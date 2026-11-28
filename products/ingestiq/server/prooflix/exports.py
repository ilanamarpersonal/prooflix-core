"""Exports of object sets: big results written to a file in the background, kept for 24 hours.

An export runs a set's last step through the SQL Editor's locked-down DuckDB and streams it into a
CSV or Parquet file in ``PROOFLIX_HOME/exports`` (mode 600), batch by batch, with actions' edits laid
over and sensitive properties masked exactly as the person who started it sees them. Only that person
(or an admin) can download it; files are deleted after 24 hours. One export runs at a time; each has a
small JSON file next to it, so the list survives a server restart.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

log = logging.getLogger(__name__)

KEEP_SECONDS = 24 * 3600
MAX_ROWS = 5_000_000
BATCH = 20_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Export:
    id: str
    owner: str | None
    name: str
    type: str
    format: str  # csv or parquet
    state: str = "queued"  # queued, running, done, failed
    rows: int = 0
    total: int | None = None
    created: str = ""
    finished: str | None = None
    error: str | None = None
    bytes: int = 0
    truncated: bool = False


class Exports:
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prooflix-export")
        self.lock = threading.Lock()

    @staticmethod
    def folder(home: Path | None) -> Path | None:
        return Path(home) / "exports" if home else None

    def _meta(self, folder: Path, e: Export) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f".{e.id}.json.tmp"
        tmp.write_text(json.dumps(asdict(e)))
        os.chmod(tmp, 0o600)
        os.replace(tmp, folder / f"{e.id}.json")

    def file(self, folder: Path, e: Export) -> Path:
        return folder / f"{e.id}.{e.format}"

    def cleanup(self, folder: Path) -> None:
        """Delete exports older than 24 hours."""
        if not folder.is_dir():
            return
        cutoff = time.time() - KEEP_SECONDS
        for meta in folder.glob("*.json"):
            if meta.stat().st_mtime < cutoff:
                for f in folder.glob(meta.stem + ".*"):
                    f.unlink(missing_ok=True)

    def list(self, folder: Path | None, owner: str | None, admin: bool) -> list[dict]:
        if folder is None or not folder.is_dir():
            return []
        self.cleanup(folder)
        out = []
        for meta in folder.glob("*.json"):
            try:
                e = json.loads(meta.read_text())
            except (OSError, ValueError):
                continue
            if admin or e.get("owner") == owner:
                out.append(e)
        return sorted(out, key=lambda e: e["created"], reverse=True)

    def get(self, folder: Path | None, export_id: str) -> Export | None:
        if folder is None or not export_id.isalnum():
            return None
        meta = folder / f"{export_id}.json"
        if not meta.is_file():
            return None
        return Export(**json.loads(meta.read_text()))

    def delete(self, folder: Path, e: Export) -> None:
        for f in folder.glob(e.id + ".*"):
            f.unlink(missing_ok=True)

    def start(self, folder: Path, owner: str | None, name: str, type_name: str, fmt: str, run) -> Export:
        """``run(export, write)``: streams the rows (writes them with ``write(table)``); runs on the worker."""
        e = Export(id=uuid.uuid4().hex, owner=owner, name=name, type=type_name, format=fmt, created=_now())
        self._meta(folder, e)
        self.pool.submit(self._work, folder, e, run)
        return e

    def _work(self, folder: Path, e: Export, run) -> None:
        e.state = "running"
        self._meta(folder, e)
        path = self.file(folder, e)
        tmp = path.with_suffix(path.suffix + ".part")
        writer = None

        def write(table: pa.Table) -> bool:
            """Write a batch; False once the row limit is reached."""
            nonlocal writer
            room = MAX_ROWS - e.rows
            if room <= 0:
                e.truncated = True
                return False
            if table.num_rows > room:
                table, e.truncated = table.slice(0, room), True
            if writer is None:
                writer = (pq.ParquetWriter(tmp, table.schema) if e.format == "parquet"
                          else pacsv.CSVWriter(tmp, table.schema))
                os.chmod(tmp, 0o600)
            writer.write_table(table)
            e.rows += table.num_rows
            self._meta(folder, e)
            return not e.truncated

        try:
            run(e, write)
            if writer is None:  # no rows: an empty file with no columns
                tmp.write_text("")
            else:
                writer.close()
            os.replace(tmp, path)
            e.state, e.bytes = "done", path.stat().st_size
        except Exception as err:  # noqa: BLE001 - shown on the export
            if writer is not None:
                try:
                    writer.close()
                except Exception:  # noqa: BLE001
                    pass
            tmp.unlink(missing_ok=True)
            e.state, e.error = "failed", str(err)[:1000]
            log.warning("export %s failed: %s", e.id, err)
        finally:
            e.finished = _now()
            self._meta(folder, e)

    def stop(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

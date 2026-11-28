"""The files of a Delta table's current version, read from its ``_delta_log``.

A Delta table is a folder of Parquet files plus a ``_delta_log`` folder that says
which files make up each version: JSON commits (``00000000000000000012.json``) with
``add`` and ``remove`` actions, and every so often a Parquet checkpoint that holds
the state at that version (``_last_checkpoint`` points at the newest). Files that
were overwritten or removed stay in the folder until they are vacuumed, so reading
every Parquet file of a Delta table would count rows twice. This module replays the
log (newest checkpoint, then the commits after it) to get only the current files.

Supported: classic and multi-part checkpoints, plain (unpartitioned or partitioned)
tables. Not supported (the table is then reported unreadable): deletion vectors and
column mapping, which change how the Parquet files must be read.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

import pyarrow.parquet as pq

LOG = "_delta_log"
_COMMIT = re.compile(r"^(\d{20})\.json$")


class UnsupportedDeltaTable(ValueError):
    """The table uses a Delta feature the catalog can't read."""


@dataclass(frozen=True)
class DeltaFile:
    path: Path
    rows: int | None  # from the log's statistics, when written


def is_delta_table(folder: Path) -> bool:
    return (folder / LOG).is_dir()


def _checkpoint(log: Path) -> tuple[int, list[Path]]:
    """(version, checkpoint files) of the newest checkpoint, or (-1, [])."""
    marker = log / "_last_checkpoint"
    if not marker.is_file():
        return -1, []
    info = json.loads(marker.read_text())
    version = int(info["version"])
    parts = info.get("parts")
    if parts:
        files = [log / f"{version:020d}.checkpoint.{i:010d}.{parts:010d}.parquet" for i in range(1, parts + 1)]
    else:
        files = [log / f"{version:020d}.checkpoint.parquet"]
    if not all(f.is_file() for f in files):
        return -1, []  # the commits are still there: replay them all
    return version, files


def _rows(stats: str | None) -> int | None:
    if not stats:
        return None
    try:
        return int(json.loads(stats)["numRecords"])
    except (ValueError, KeyError, TypeError):
        return None


def current_files(table: Path) -> list[DeltaFile]:
    """The Parquet files of the table's current version, in a stable order."""
    log = table / LOG
    live: dict[str, int | None] = {}

    def check_features(metadata: dict | None, protocol: dict | None) -> None:
        if protocol and "deletionVectors" in (protocol.get("readerFeatures") or []):
            raise UnsupportedDeltaTable("deletion vectors")
        mode = ((metadata or {}).get("configuration") or {}).get("delta.columnMapping.mode", "none")
        if mode != "none":
            raise UnsupportedDeltaTable(f"column mapping ({mode})")

    version, checkpoint = _checkpoint(log)
    for part in checkpoint:
        cols = [c for c in ("add", "metaData", "protocol") if c in pq.read_schema(part).names]
        for row in pq.read_table(part, columns=cols).to_pylist():
            if row.get("add"):
                add = row["add"]
                if add.get("deletionVector"):
                    raise UnsupportedDeltaTable("deletion vectors")
                live[add["path"]] = _rows(add.get("stats"))
            check_features(row.get("metaData"), row.get("protocol"))

    commits = sorted(
        (int(m.group(1)), p) for p in log.iterdir() if (m := _COMMIT.match(p.name)) and int(m.group(1)) > version
    )
    for _, commit in commits:
        for line in commit.read_text().splitlines():
            if not line.strip():
                continue
            action = json.loads(line)
            if "add" in action:
                add = action["add"]
                if add.get("deletionVector"):
                    raise UnsupportedDeltaTable("deletion vectors")
                live[add["path"]] = _rows(add.get("stats"))
            elif "remove" in action:
                live.pop(action["remove"]["path"], None)
            elif "metaData" in action or "protocol" in action:
                check_features(action.get("metaData"), action.get("protocol"))

    out = []
    for rel, rows in sorted(live.items()):
        path = Path(unquote(rel)) if rel.startswith("/") else table / unquote(rel)
        out.append(DeltaFile(path, rows))
    return out


def current_version(table: Path) -> int:
    """The table's newest version (the highest commit), or -1 when it has none."""
    log = table / LOG
    versions = [int(m.group(1)) for p in log.iterdir() if (m := _COMMIT.match(p.name))] if log.is_dir() else []
    if versions:
        return max(versions)
    version, _ = _checkpoint(log)
    return version


@dataclass(frozen=True)
class Changes:
    version: int  # the newest version read
    added: list[Path]
    removed: list[Path]
    # True when the changes can't be followed file by file (a schema change, commits already
    # cleaned up, removed files already vacuumed, deletion vectors): rebuild from the whole table
    rebuild: bool
    reason: str = ""


def changes_since(table: Path, since: int) -> Changes:
    """The data files added and removed by the commits after version ``since``."""
    log = table / LOG
    commits = sorted((int(m.group(1)), p) for p in log.iterdir() if (m := _COMMIT.match(p.name)) and int(m.group(1)) > since)
    newest = commits[-1][0] if commits else since
    if commits and commits[0][0] != since + 1:
        return Changes(newest, [], [], True, f"commits {since + 1}..{commits[0][0] - 1} are no longer in the log")
    added: dict[str, None] = {}
    removed: dict[str, None] = {}

    def path_of(rel: str) -> Path:
        return Path(unquote(rel)) if rel.startswith("/") else table / unquote(rel)

    for _, commit in commits:
        for line in commit.read_text().splitlines():
            if not line.strip():
                continue
            action = json.loads(line)
            if "metaData" in action:
                return Changes(newest, [], [], True, "the table's schema or settings changed")
            if "add" in action:
                if action["add"].get("deletionVector"):
                    return Changes(newest, [], [], True, "deletion vectors")
                if action["add"].get("dataChange", True):
                    added[action["add"]["path"]] = None
            elif "remove" in action and action["remove"].get("dataChange", True):
                rel = action["remove"]["path"]
                if rel in added:
                    del added[rel]  # added and removed again within these commits
                else:
                    removed[rel] = None
    gone = [r for r in removed if not path_of(r).is_file()]
    if gone:
        return Changes(newest, [], [], True, f"{len(gone)} removed files are already vacuumed")
    return Changes(newest, [path_of(a) for a in added], [path_of(r) for r in removed], False)

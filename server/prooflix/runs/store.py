"""Run storage: in memory, mirrored to JSON files under ``<workspace>/.prooflix/runs``."""

from __future__ import annotations

import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from .models import Run, RunStatus, utcnow

log = logging.getLogger(__name__)


class RunStore:
    def __init__(self, directory: Path | None = None):
        self._dir = Path(directory) if directory else None
        self._runs: dict[str, Run] = {}
        self._lock = threading.RLock()
        if self._dir:
            self._dir.mkdir(parents=True, exist_ok=True)
            self._load()

    def _load(self) -> None:
        assert self._dir is not None
        for file in self._dir.glob("*.json"):
            try:
                run = Run.model_validate_json(file.read_text(encoding="utf-8"))
            except Exception as exc:  # corrupt or old file; keep the server usable
                log.warning("Skipping unreadable run file %s: %s", file, exc)
                continue
            self._runs[run.id] = run

    def recover_interrupted(self) -> int:
        """Mark runs left RUNNING/PENDING by a previous server process as FAILED."""
        count = 0
        with self._lock:
            for run in self._runs.values():
                if run.status.terminal:
                    continue
                run.status = RunStatus.FAILED
                run.error = "Interrupted: the server stopped while this run was active"
                run.ended_at = run.ended_at or utcnow()
                for task in run.tasks.values():
                    if not task.status.terminal:
                        task.status = RunStatus.CANCELLED
                        task.ended_at = task.ended_at or run.ended_at
                self._persist(run)
                count += 1
        return count

    def save(self, run: Run) -> None:
        with self._lock:
            self._runs[run.id] = run
            self._persist(run)

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            run = self._runs.get(run_id)
            return run.model_copy(deep=True) if run else None

    def list(
        self, *, pipeline: str | None = None, root_only: bool = False, limit: int = 100
    ) -> list[Run]:
        with self._lock:
            runs = [
                r
                for r in self._runs.values()
                if (pipeline is None or r.pipeline == pipeline) and (not root_only or r.is_root)
            ]
            runs.sort(key=lambda r: r.created_at, reverse=True)
            return [r.model_copy(deep=True) for r in runs[:limit]]

    def children(self, run_id: str) -> list[Run]:
        with self._lock:
            kids = [r for r in self._runs.values() if r.parent_run_id == run_id]
            kids.sort(key=lambda r: r.created_at)
            return [r.model_copy(deep=True) for r in kids]

    def tree(self, run_id: str) -> dict[str, Any] | None:
        """The run as a dict with a nested ``children`` list of child-run trees."""
        run = self.get(run_id)
        if run is None:
            return None
        node = run.model_dump(mode="json")
        node["children"] = [self.tree(child.id) for child in self.children(run_id)]
        return node

    def _persist(self, run: Run) -> None:
        if not self._dir:
            return
        data = run.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=f".{run.id}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(data)
            os.replace(tmp, self._dir / f"{run.id}.json")
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

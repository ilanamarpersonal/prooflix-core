"""The workspaces the server knows about, and which one is active.

A workspace is a folder holding ``pipelines/`` and ``src/`` (and imported
projects as sub-folders). The default workspace (``PROOFLIX_WORKSPACE``) is
always in the list; others are added when they are created or opened from the
web client. Exactly one workspace is active at a time: the one the server runs
pipelines from.

The list is saved to ``<PROOFLIX_HOME>/workspaces.json`` so the choice survives
restarts. Without a home folder (tests) it is kept in memory only.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)


class WorkspaceRegistry:
    def __init__(self, default: Path, file: Path | None = None):
        self.default = Path(default).expanduser().resolve()
        self.file = file
        self._paths: list[Path] = [self.default]
        self._active: Path = self.default
        self._load()

    # ---------------------------------------------------------------- queries
    @property
    def active(self) -> Path:
        return self._active

    def paths(self) -> list[Path]:
        """Every known workspace: the default first, then the others in order added."""
        return list(self._paths)

    # ---------------------------------------------------------------- changes
    def add(self, path: Path) -> Path:
        path = Path(path).expanduser().resolve()
        if path not in self._paths:
            self._paths.append(path)
            self._save()
        return path

    def set_active(self, path: Path) -> Path:
        path = self.add(path)
        if path != self._active:
            self._active = path
            self._save()
        return path

    def forget(self, path: Path) -> None:
        """Remove a workspace from the list (its folder is left alone)."""
        path = Path(path).expanduser().resolve()
        if path == self._active:
            raise ValueError("The active workspace can't be removed from the list; switch to another first")
        if path == self.default:
            raise ValueError("The default workspace can't be removed from the list")
        if path in self._paths:
            self._paths.remove(path)
            self._save()

    # ------------------------------------------------------------ persistence
    def _load(self) -> None:
        if self.file is None or not self.file.is_file():
            return
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            paths = [Path(p) for p in data.get("workspaces", []) if isinstance(p, str)]
            active = data.get("active")
        except (OSError, ValueError, AttributeError) as exc:
            log.warning("Ignoring unreadable workspace list %s: %s", self.file, exc)
            return
        for p in paths:
            p = p.expanduser().resolve()
            if p not in self._paths:
                self._paths.append(p)
        # A chosen workspace that has since been deleted falls back to the default
        if isinstance(active, str) and Path(active).is_dir():
            self._active = Path(active).resolve()
            if self._active not in self._paths:
                self._paths.append(self._active)

    def _save(self) -> None:
        if self.file is None:
            return
        data = {"active": str(self._active), "workspaces": [str(p) for p in self._paths]}
        self.file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.file.parent, prefix=".workspaces.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self.file)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

"""The workspaces the server knows about, and which one is active.

A workspace is a folder holding ``pipelines/`` and ``src/`` (and imported
projects as sub-folders). Workspaces live in the **workspaces folder**
(``PROOFLIX_WORKSPACES``, by default ``<repo>/workspaces``): every sub-folder
of it with a ``pipelines/`` folder is a workspace, listed by name. Folders
elsewhere can be added too (created in, or opened from, another location).

Exactly one workspace is active: the one the server runs pipelines from. Until
another is chosen it is the default, which is ``PROOFLIX_WORKSPACE`` when set
and otherwise the first workspace in the workspaces folder. When that folder
has none, a ``default`` workspace is created in it, so there is always one.

The active choice and the workspaces outside the folder are saved to
``<PROOFLIX_HOME>/workspaces.json`` so they survive restarts. Without a home
folder (tests) they are kept in memory only.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_NAME = "default"  # created in an empty workspaces folder


def discover(root: Path) -> list[Path]:
    """Workspaces in the workspaces folder: sub-folders with ``pipelines/``, by name."""
    if not root.is_dir():
        return []
    return sorted(
        (
            d.resolve()
            for d in root.iterdir()
            if d.is_dir() and not d.name.startswith((".", "_")) and (d / "pipelines").is_dir()
        ),
        key=lambda p: p.name.lower(),
    )


def create_workspace_dirs(path: Path) -> None:
    """Make ``path`` a workspace: create it with ``pipelines/`` and ``src/``."""
    (path / "pipelines").mkdir(parents=True, exist_ok=True)
    (path / "src").mkdir(exist_ok=True)


class WorkspaceRegistry:
    def __init__(self, root: Path | None = None, file: Path | None = None, default: Path | None = None):
        if root is None and default is None:
            raise ValueError("Give a workspaces folder, a default workspace, or both")
        self.root = Path(root).expanduser().resolve() if root is not None else None
        self.file = file
        self._explicit_default = Path(default).expanduser().resolve() if default is not None else None
        self._extra: list[Path] = []  # added workspaces outside the workspaces folder
        self._chosen: Path | None = None  # the active workspace, once one is chosen
        self._load()

    def keep_active(self) -> Path:
        """Fix the active workspace and save it, so it changes only when someone switches.

        Without this, the default (the first workspace by name) would move to
        any workspace created later that sorts before it.
        """
        return self.set_active(self.active)

    # ---------------------------------------------------------------- queries
    @property
    def default(self) -> Path:
        """``PROOFLIX_WORKSPACE``, else the first workspace in the folder (created if none)."""
        if self._explicit_default is not None:
            return self._explicit_default
        assert self.root is not None
        found = discover(self.root)
        if found:
            return found[0]
        path = self.root / DEFAULT_NAME
        create_workspace_dirs(path)
        log.info("Created the default workspace %s", path)
        return path.resolve()

    @property
    def active(self) -> Path:
        # A chosen workspace that has since been deleted falls back to the default
        if self._chosen is not None and self._chosen.is_dir():
            return self._chosen
        return self.default

    def in_root(self, path: Path) -> bool:
        return self.root is not None and Path(path).resolve().parent == self.root

    def paths(self) -> list[Path]:
        """Every workspace: the default first, then the workspaces folder by name, then added ones."""
        out: list[Path] = []
        for p in [self.default, *(discover(self.root) if self.root else []), *self._extra]:
            if p not in out:
                out.append(p)
        if self._chosen is not None and self._chosen not in out:
            out.append(self._chosen)
        return out

    # ---------------------------------------------------------------- changes
    def add(self, path: Path) -> Path:
        path = Path(path).expanduser().resolve()
        if path not in self.paths() and not self.in_root(path):
            self._extra.append(path)
            self._save()
        return path

    def set_active(self, path: Path) -> Path:
        path = self.add(path)
        if path != self._chosen:
            self._chosen = path
            self._save()
        return path

    def forget(self, path: Path) -> None:
        """Remove an added workspace from the list (its folder is left alone)."""
        path = Path(path).expanduser().resolve()
        if path == self.active:
            raise ValueError("The active workspace can't be removed from the list; switch to another first")
        if path == self.default:
            raise ValueError("The default workspace can't be removed from the list")
        if self.in_root(path) and path in discover(self.root):  # type: ignore[arg-type]
            raise ValueError(
                f"'{path.name}' is in the workspaces folder {self.root}; move or delete the folder to remove it"
            )
        if path in self._extra:
            self._extra.remove(path)
            self._save()

    # ------------------------------------------------------------ persistence
    def _load(self) -> None:
        if self.file is None or not self.file.is_file():
            return
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            extra = [Path(p) for p in data.get("workspaces", []) if isinstance(p, str)]
            active = data.get("active")
        except (OSError, ValueError, AttributeError) as exc:
            log.warning("Ignoring unreadable workspace list %s: %s", self.file, exc)
            return
        for p in extra:
            p = p.expanduser().resolve()
            if p not in self._extra and not self.in_root(p) and p != self._explicit_default:
                self._extra.append(p)
        if isinstance(active, str):
            self._chosen = Path(active).expanduser().resolve()

    def _save(self) -> None:
        if self.file is None:
            return
        data = {
            "active": str(self._chosen) if self._chosen is not None else None,
            "workspaces": [str(p) for p in self._extra],  # those outside the workspaces folder
        }
        self.file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.file.parent, prefix=".workspaces.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self.file)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

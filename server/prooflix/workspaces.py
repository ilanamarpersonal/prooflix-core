"""The workspaces the server knows about, and which one is active.

A workspace is a folder holding ``pipelines/`` and ``src/`` (and imported
projects as sub-folders). Workspaces live in the **workspaces folder**
(``PROOFLIX_WORKSPACES``, by default ``<repo>/workspaces``): every sub-folder
of it with a ``pipelines/`` folder is a workspace, listed by name. Folders
elsewhere can be added too (created in, or opened from, another location).

At most one workspace is active: the one the server runs pipelines from. Until
another is chosen it is the default, which is ``PROOFLIX_WORKSPACE`` when set
and otherwise the first workspace in the workspaces folder.

The list can be empty (every workspace removed, or none yet). Then nothing is
active, and the server runs on an empty placeholder folder,
``<workspaces folder>/.no-workspace`` (hidden, never listed), so pipelines,
runs and schedules are simply empty until a workspace is created or opened.

Removing a workspace only takes it off the list; its folder is never moved or
deleted. A removed workspace in the workspaces folder is remembered as hidden,
so it isn't found again, until it is opened or created there again.

The active choice, the workspaces outside the folder and the hidden ones are saved to
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

NO_WORKSPACE = ".no-workspace"  # the placeholder the server runs on while nothing is active


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
        self._hidden: list[Path] = []  # removed from the list, though still in the workspaces folder
        self._load()

    @property
    def placeholder(self) -> Path | None:
        """The empty folder the server runs on while no workspace is active."""
        return (self.root / NO_WORKSPACE) if self.root is not None else None

    def keep_active(self) -> Path:
        """Fix the active workspace and save it, so it changes only when someone switches.

        Without this, the default (the first workspace by name) would move to
        any workspace created later that sorts before it.
        """
        active = self.active
        if active == self.placeholder and self.default is not None:
            active = self.default  # a workspace appeared while the server was stopped
        return self.set_active(active)

    # ---------------------------------------------------------------- queries
    @property
    def default(self) -> Path | None:
        """``PROOFLIX_WORKSPACE``, else the first workspace in the folder; None when there is none."""
        if self._explicit_default is not None:
            return self._explicit_default
        found = self._discover()
        return found[0] if found else None

    @property
    def explicit_default(self) -> Path | None:
        """``PROOFLIX_WORKSPACE`` when set: it can't be removed."""
        return self._explicit_default

    @property
    def active(self) -> Path:
        """The folder the server runs on: the active workspace, or the placeholder when there is none."""
        # A chosen workspace (or the placeholder, chosen when the last one was
        # removed) stays until someone switches; one since deleted falls back to the default
        if self._chosen is not None and self._chosen.is_dir():
            return self._chosen
        default = self.default
        if default is not None:
            return default
        placeholder = self.placeholder
        assert placeholder is not None  # without a workspaces folder there is always PROOFLIX_WORKSPACE
        create_workspace_dirs(placeholder)
        return placeholder

    @property
    def has_active(self) -> bool:
        """False while the list is empty and the server runs on the placeholder."""
        return self.active != self.placeholder

    def _discover(self) -> list[Path]:
        """Workspaces in the workspaces folder, without the removed (hidden) ones."""
        return [p for p in discover(self.root) if p not in self._hidden] if self.root else []

    def in_root(self, path: Path) -> bool:
        return self.root is not None and Path(path).resolve().parent == self.root

    def paths(self) -> list[Path]:
        """Every workspace: the default first, then the workspaces folder by name, then added ones."""
        out: list[Path] = []
        default = self.default
        for p in [*([default] if default else []), *self._discover(), *self._extra]:
            if p not in out:
                out.append(p)
        if self._chosen is not None and self._chosen not in out and self._chosen != self.placeholder:
            out.append(self._chosen)
        return out

    # ---------------------------------------------------------------- changes
    def add(self, path: Path) -> Path:
        path = Path(path).expanduser().resolve()
        changed = False
        if path in self._hidden:  # created or opened again: list it again
            self._hidden.remove(path)
            changed = True
        if path not in self.paths() and not self.in_root(path):
            self._extra.append(path)
            changed = True
        if changed:
            self._save()
        return path

    def set_active(self, path: Path) -> Path:
        path = self.add(path)
        if path != self._chosen:
            self._chosen = path
            self._save()
        return path

    def replacement_for(self, path: Path) -> Path:
        """The folder to switch to before removing the active ``path``: another
        existing workspace, else the placeholder (the list becomes empty)."""
        path = Path(path).expanduser().resolve()
        for p in self.paths():
            if p != path and p.is_dir():
                return p
        placeholder = self.placeholder
        if placeholder is None:
            raise ValueError("This is the only workspace; create another before removing it")
        create_workspace_dirs(placeholder)
        return placeholder

    def forget(self, path: Path) -> None:
        """Remove a workspace from the list. Its folder and files are never touched.

        One in the workspaces folder is remembered as hidden, so it isn't found
        again; opening or creating it again lists it again.
        """
        path = Path(path).expanduser().resolve()
        if path == self.active:
            raise ValueError("The active workspace can't be removed; switch to another first")
        if path == self._explicit_default:
            raise ValueError("The default workspace (PROOFLIX_WORKSPACE) can't be removed")
        changed = False
        if path in self._extra:
            self._extra.remove(path)
            changed = True
        if self.in_root(path) and path not in self._hidden:
            self._hidden.append(path)
            changed = True
        if changed:
            self._save()

    # ------------------------------------------------------------ persistence
    def _load(self) -> None:
        if self.file is None or not self.file.is_file():
            return
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            extra = [Path(p) for p in data.get("workspaces", []) if isinstance(p, str)]
            active = data.get("active")
            hidden = [Path(p) for p in data.get("hidden", []) if isinstance(p, str)]
        except (OSError, ValueError, AttributeError) as exc:
            log.warning("Ignoring unreadable workspace list %s: %s", self.file, exc)
            return
        for p in extra:
            p = p.expanduser().resolve()
            if p not in self._extra and not self.in_root(p) and p != self._explicit_default:
                self._extra.append(p)
        for p in hidden:
            p = p.expanduser().resolve()
            if p not in self._hidden and self.in_root(p):
                self._hidden.append(p)
        if isinstance(active, str):
            self._chosen = Path(active).expanduser().resolve()

    def _save(self) -> None:
        # forget removed workspaces whose folders are gone
        self._hidden = [p for p in self._hidden if p.is_dir()]
        if self.file is None:
            return
        data = {
            "active": str(self._chosen) if self._chosen is not None else None,
            "workspaces": [str(p) for p in self._extra],  # those outside the workspaces folder
            "hidden": [str(p) for p in self._hidden],  # removed ones still in the workspaces folder
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

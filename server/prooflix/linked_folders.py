"""A workspace's source data and data lake folders, which can live outside it.

Two folders of a workspace can be links to folders elsewhere (a big disk, existing
data, a separate Kubernetes volume), so nothing is copied into the workspace:

- **source data**, ``<workspace>/source``: the raw files pipelines read (bronze's
  input). Read from, never written to by Prooflix.
- **data lake**, ``<workspace>/data``: what pipelines build, ``data/<catalog>/<schema>/<table>/``
  (bronze, gold) and their state such as ``data/<catalog>/checkpoint/``. The
  catalog and the SQL editor read it.

The folder used for each, first match wins:

1. the workspace's own choice, made in the web client and kept in
   ``<workspace>/.prooflix/settings.json`` (``{"source_data": ..., "data_lake": ...}``)
2. the server default: ``PROOFLIX_SOURCE_DATA`` / ``PROOFLIX_DATA_LAKE``
   (Helm ``sourceData`` / ``dataLake``)
3. the workspace's own ``source/`` / ``data/`` folder

When it is not the workspace's own folder, Prooflix makes ``source`` / ``data`` a
symbolic link to it, so pipeline code and shell tasks keep using ``source/...`` and
``data/...`` and work on the files in place. A real folder with files in it is
never replaced: move its files first.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

log = logging.getLogger(__name__)

SETTINGS_FILE = Path(".prooflix") / "settings.json"

Kind = Literal["source_data", "data_lake"]
Origin = Literal["workspace", "server", "default"]


@dataclass(frozen=True)
class FolderKind:
    link: str  # the name in the workspace
    label: str  # for messages


KINDS: dict[Kind, FolderKind] = {
    "source_data": FolderKind("source", "source data folder"),
    "data_lake": FolderKind("data", "data lake folder"),
}
LINK_NAMES = tuple(k.link for k in KINDS.values())


class FolderError(ValueError):
    """The folder can't be used (missing, inside the workspace, or a real folder with files is in the way)."""


@dataclass(frozen=True)
class Resolved:
    kind: Kind
    path: Path  # the folder used (resolved)
    origin: Origin  # where the choice comes from
    workspace_setting: Path | None  # the workspace's own choice, if any
    server_default: Path | None  # PROOFLIX_SOURCE_DATA / PROOFLIX_DATA_LAKE, if set


Defaults = dict[Kind, Path | None]


def _settings_file(workspace: Path) -> Path:
    return workspace / SETTINGS_FILE


def _read_settings(workspace: Path) -> dict:
    file = _settings_file(workspace)
    if not file.is_file():
        return {}
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("Ignoring unreadable workspace settings %s: %s", file, exc)
        return {}
    return data if isinstance(data, dict) else {}


def read_setting(workspace: Path, kind: Kind) -> Path | None:
    """The workspace's own folder for ``kind``, or None."""
    raw = _read_settings(workspace).get(kind)
    return Path(raw).expanduser().resolve() if isinstance(raw, str) and raw.strip() else None


def _write_setting(workspace: Path, kind: Kind, folder: Path | None) -> None:
    file = _settings_file(workspace)
    data = _read_settings(workspace)
    if folder is None:
        data.pop(kind, None)
    else:
        data[kind] = str(folder)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=file.parent, prefix=".settings.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, file)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def resolve(workspace: Path, kind: Kind, server_default: Path | None) -> Resolved:
    workspace = Path(workspace).resolve()
    own = read_setting(workspace, kind)
    default = Path(server_default).expanduser().resolve() if server_default else None
    if own is not None:
        return Resolved(kind, own, "workspace", own, default)
    if default is not None:
        return Resolved(kind, default, "server", None, default)
    return Resolved(kind, workspace / KINDS[kind].link, "default", None, None)


def _is_empty_dir(path: Path) -> bool:
    # an empty folder, or one holding only Finder's .DS_Store, can be replaced by the link
    return path.is_dir() and all(c.name == ".DS_Store" for c in path.iterdir())


def _same(a: Path, b: Path) -> bool:
    try:
        return os.path.samefile(a, b)  # also on case-insensitive file systems (.PROOFLIX = .prooflix)
    except OSError:
        return a == b


def inside(target: Path, folder: Path) -> bool:
    """target is folder or inside it (by path, and by file identity)."""
    return any(_same(p, folder) for p in (target, *target.parents))


COPIES = "workspaces"  # PROOFLIX_HOME/workspaces holds workspace copies: not private


def private(target: Path, home: Path) -> bool:
    """target is in PROOFLIX_HOME's private files (users, keys, connections, alerts), that is
    inside PROOFLIX_HOME but not in its workspaces folder."""
    return inside(target, home) and not inside(target, home / COPIES)


def _overlaps(folder: Path, protected: Path) -> bool:
    """folder is protected, inside it, or contains it."""
    return inside(folder, protected) or inside(protected, folder)


def link(workspace: Path, kind: Kind, folder: Path, protected: Path | None = None) -> None:
    """Make ``<workspace>/<link>`` point at ``folder`` (or be a plain folder when it is that folder).

    Raises FolderError when the folder is missing or inside the workspace, or a
    real folder with files is in the way, or it overlaps ``protected`` (the server's
    PROOFLIX_HOME, with users, keys and passwords: a link to it would expose them
    through the workspace's file routes).
    """
    workspace = Path(workspace).resolve()
    spec = KINDS[kind]
    here = workspace / spec.link
    if folder == here:
        if here.is_symlink():  # back to the workspace's own folder
            here.unlink()
        return
    if not folder.is_dir():
        raise FolderError(f"The {spec.label} '{folder}' does not exist")
    if folder == workspace or workspace in folder.parents:
        raise FolderError(f"The {spec.label} can't be inside the workspace; leave it as the default instead")
    if protected is not None and _overlaps(folder.resolve(), Path(protected).resolve()):
        raise FolderError(
            f"The {spec.label} can't be '{folder}': it holds or is inside the server's private folder "
            "(PROOFLIX_HOME, with users and passwords)"
        )
    if here.is_symlink():
        if here.resolve() == folder:
            return
        here.unlink()
    elif here.exists():
        if not _is_empty_dir(here):
            raise FolderError(
                f"'{here}' already holds files; move them to '{folder}' first, then set the {spec.label} again"
            )
        for c in here.iterdir():
            c.unlink()
        here.rmdir()
    here.symlink_to(folder, target_is_directory=True)
    log.info("The %s of %s is %s", spec.label, workspace, folder)


def apply(workspace: Path, defaults: Defaults, protected: Path | None = None) -> None:
    """Link both folders as the settings say; a problem is logged, not raised
    (the server still starts, on the workspace's own folder)."""
    for kind in KINDS:
        resolved = resolve(workspace, kind, defaults.get(kind))
        try:
            link(workspace, kind, resolved.path, protected)
        except (FolderError, OSError) as exc:
            log.warning("Not using the %s for %s: %s", KINDS[kind].label, workspace, exc)
            here = Path(workspace).resolve() / KINDS[kind].link
            if protected is not None and here.is_symlink() and _overlaps(here.resolve(), Path(protected).resolve()):
                here.unlink()  # an older link to the private folder: never leave it reachable
                log.warning("Removed %s: it led to the server's private folder", here)


def set_workspace_setting(
    workspace: Path, kind: Kind, folder: Path | None, server_default: Path | None, protected: Path | None = None
) -> Resolved:
    """Choose the workspace's folder for ``kind`` (None: back to the server default or its own folder).

    The link is changed first, so nothing is saved when the folder can't be used.
    """
    workspace = Path(workspace).resolve()
    chosen = Path(folder).expanduser().resolve() if folder is not None else None
    if chosen is not None:
        target = chosen
    elif server_default:
        target = Path(server_default).expanduser().resolve()
    else:
        target = workspace / KINDS[kind].link
    link(workspace, kind, target, protected)
    _write_setting(workspace, kind, chosen)
    return resolve(workspace, kind, server_default)

"""``/api/workspaces``: create workspaces and choose the active one.

``/api/fs/dirs`` lists folders on the server so the web client can offer a
folder picker (a browser can't hand the server a path of its own).
"""

from __future__ import annotations

import base64
import binascii
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from ..runtime import WorkspaceBusy, switch_workspace
from ..workspaces import WorkspaceRegistry, create_workspace_dirs
from .workspace import MAX_IMPORT_BYTES, ImportFile, _clean_import_path, resolve_inside

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])
fs_router = APIRouter(prefix="/api/fs", tags=["workspaces"])

# A folder name: starts with a letter or digit, no path separators
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$")


class WorkspaceEntry(BaseModel):
    name: str
    path: str  # absolute path on the server
    active: bool
    default: bool  # active until another is chosen: the first workspace (or PROOFLIX_WORKSPACE)
    in_root: bool  # in the workspaces folder (listed while the folder is there)
    exists: bool


class WorkspaceList(BaseModel):
    active: str | None  # None while the list is empty
    root: str | None  # the workspaces folder
    workspaces: list[WorkspaceEntry]


class CreateWorkspaceIn(BaseModel):
    parent: str = Field(..., min_length=1, description="existing folder to create the workspace in")
    name: str = Field(..., min_length=1, max_length=100, description="name of the new folder")


class ImportWorkspaceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="name of the new workspace folder")
    files: list[ImportFile] = Field(..., min_length=1, max_length=2000)  # paths relative to the new workspace
    activate: bool = True
    # update an existing workspace of that name: uploaded files replace those
    # with the same path, everything else in it (run history too) is kept
    overwrite: bool = False


class ImportWorkspaceResult(BaseModel):
    workspace: WorkspaceEntry
    written: int  # number of files
    pipelines: list[str]  # ids of the pipelines it brought


class PathIn(BaseModel):
    path: str = Field(..., min_length=1)


class DirEntry(BaseModel):
    name: str
    path: str


class DirListing(BaseModel):
    path: str
    parent: str | None  # None at the filesystem root
    dirs: list[DirEntry]


def _registry(request: Request) -> WorkspaceRegistry:
    return request.app.state.registry


def _absolute(raw: str) -> Path:
    path = Path(raw.strip()).expanduser()
    if not path.is_absolute():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"'{raw}' is not an absolute path")
    return path.resolve()


def _check_name(raw: str) -> str:
    name = raw.strip()
    if not NAME_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Use letters, digits, spaces, '.', '_' or '-' for the name, starting with a letter or digit",
        )
    return name


def _listing(registry: WorkspaceRegistry) -> WorkspaceList:
    active = registry.active if registry.has_active else None
    default = registry.default
    return WorkspaceList(
        active=str(active) if active else None,
        root=str(registry.root) if registry.root else None,
        workspaces=[
            WorkspaceEntry(
                name=p.name,
                path=str(p),
                active=p == active,
                default=p == default,
                in_root=registry.in_root(p),
                exists=p.is_dir(),
            )
            for p in registry.paths()
        ],
    )


@router.get("", response_model=WorkspaceList)
def list_workspaces(request: Request) -> WorkspaceList:
    return _listing(_registry(request))


@router.post("", response_model=WorkspaceEntry, status_code=status.HTTP_201_CREATED)
async def create_workspace(body: CreateWorkspaceIn, request: Request) -> WorkspaceEntry:
    """Create ``<parent>/<name>/`` with ``pipelines/`` and ``src/``, and list it.

    The new workspace is not made active (a separate choice), unless the list
    was empty.
    """
    name = _check_name(body.name)
    parent = _absolute(body.parent)
    if not parent.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Folder '{parent}' does not exist")
    target = parent / name
    if target.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, f"'{target}' already exists")
    try:
        target.mkdir()
        create_workspace_dirs(target)
    except OSError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not create '{target}': {exc.strerror}") from exc
    registry = _registry(request)
    registry.add(target)
    if not registry.has_active:  # the first workspace in an empty list becomes active
        await switch_workspace(request.app, target)
    return next(w for w in _listing(registry).workspaces if w.path == str(target.resolve()))


@router.post("/import", response_model=ImportWorkspaceResult, status_code=status.HTTP_201_CREATED)
async def import_workspace(body: ImportWorkspaceIn, request: Request) -> ImportWorkspaceResult:
    """Create a workspace in the workspaces folder from uploaded files (a folder
    chosen in the browser), and make it active unless ``activate`` is false.

    ``pipelines/`` and ``src/`` are created when the upload has none. Nothing is
    written when a path is invalid or the upload is too large. When the folder
    exists, the import is refused (``409`` with ``exists``, ``path`` and whether
    it is a workspace removed from the list) unless ``overwrite`` is set and the
    folder is a workspace; it is then listed again and updated.
    """
    registry = _registry(request)
    if registry.root is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "There is no workspaces folder to import into")
    name = _check_name(body.name)
    target = registry.root / name
    is_workspace = (target / "pipelines").is_dir()
    if target.exists() and not (body.overwrite and is_workspace):
        removed = is_workspace and target.resolve() not in registry.paths()
        message = (
            f"A workspace named '{name}' already exists"
            + (" (removed from the list)" if removed else "")
            + ": use it, update it with this folder, or choose another name"
            if is_workspace
            else f"'{name}' already exists in the workspaces folder and is not a workspace; choose another name"
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "errors": [message],
                "exists": True,
                "workspace": is_workspace,
                "removed": removed,
                "path": str(target.resolve()),
            },
        )

    decoded: dict[str, bytes] = {}
    total = 0
    for f in body.files:
        rel = _clean_import_path(f.path)
        resolve_inside(target, rel, request.app.state.settings.home)
        try:
            data = base64.b64decode(f.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"'{rel}' is not valid base64") from exc
        total += len(data)
        if total > MAX_IMPORT_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Import is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB",
            )
        decoded[rel] = data
    # "a" and "a/b" can't both be files
    for rel in decoded:
        if any(parent.as_posix() in decoded for parent in Path(rel).parents[:-1]):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"'{rel}' is inside a file of the upload")

    try:
        for rel, data in decoded.items():
            dest = target / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        create_workspace_dirs(target)
    except OSError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not write '{target}': {exc.strerror}") from exc

    registry.add(target)
    if body.activate or not registry.has_active:
        try:
            await switch_workspace(request.app, target)
        except WorkspaceBusy as exc:
            # imported and listed, just not active yet
            raise HTTPException(status.HTTP_409_CONFLICT, f"Imported '{name}', but could not switch to it: {exc}") from exc
    pipelines = sorted(Path(rel).stem for rel in decoded if re.fullmatch(r"pipelines/[^/]+\.ya?ml", rel))
    entry = next(w for w in _listing(registry).workspaces if w.path == str(target.resolve()))
    return ImportWorkspaceResult(workspace=entry, written=len(decoded), pipelines=pipelines)


@router.put("/active", response_model=WorkspaceList)
async def set_active(body: PathIn, request: Request) -> WorkspaceList:
    """Make a workspace active: pipelines, runs and schedules come from it."""
    path = _absolute(body.path)
    if not path.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Folder '{path}' does not exist")
    try:
        await switch_workspace(request.app, path)
    except WorkspaceBusy as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return _listing(_registry(request))


@router.delete("", response_model=WorkspaceList)
async def forget_workspace(request: Request, path: str = Query(..., min_length=1)) -> WorkspaceList:
    """Remove a workspace from the list. Its folder and files are left alone.

    Removing the active workspace first switches to another one (a new
    ``default`` workspace when it was the only one), which waits for no runs.
    """
    registry = _registry(request)
    target = _absolute(path)
    try:
        if registry.has_active and target == registry.active:
            if target == registry.explicit_default:
                raise ValueError("The default workspace (PROOFLIX_WORKSPACE) can't be removed")
            await switch_workspace(request.app, registry.replacement_for(target))
        registry.forget(target)
    except WorkspaceBusy as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except (ValueError, OSError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _listing(registry)


@fs_router.get("/dirs", response_model=DirListing)
def list_dirs(request: Request, path: str | None = Query(None)) -> DirListing:
    """Sub-folders of ``path`` (default: the workspaces folder)."""
    registry = _registry(request)
    folder = _absolute(path) if path else (registry.root or registry.active.parent)
    if not folder.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Folder '{folder}' does not exist")
    try:
        dirs = sorted(
            (c for c in folder.iterdir() if not c.name.startswith(".") and c.is_dir()),
            key=lambda c: c.name.lower(),
        )
    except PermissionError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"No permission to read '{folder}'") from exc
    return DirListing(
        path=str(folder),
        parent=str(folder.parent) if folder.parent != folder else None,
        dirs=[DirEntry(name=c.name, path=str(c)) for c in dirs],
    )

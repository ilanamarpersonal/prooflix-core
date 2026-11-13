"""``/api/workspaces``: create workspaces and choose the active one.

``/api/fs/dirs`` lists folders on the server so the web client can offer a
folder picker (a browser can't hand the server a path of its own).
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from ..runtime import WorkspaceBusy, switch_workspace
from ..workspaces import WorkspaceRegistry

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])
fs_router = APIRouter(prefix="/api/fs", tags=["workspaces"])

# A folder name: starts with a letter or digit, no path separators
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$")
WORKSPACE_DIRS = ("pipelines", "src")


class WorkspaceEntry(BaseModel):
    name: str
    path: str  # absolute path on the server
    active: bool
    default: bool  # the PROOFLIX_WORKSPACE workspace, always listed
    exists: bool


class WorkspaceList(BaseModel):
    active: str
    workspaces: list[WorkspaceEntry]


class CreateWorkspaceIn(BaseModel):
    parent: str = Field(..., min_length=1, description="existing folder to create the workspace in")
    name: str = Field(..., min_length=1, max_length=100, description="name of the new folder")


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


def _listing(registry: WorkspaceRegistry) -> WorkspaceList:
    active = registry.active
    return WorkspaceList(
        active=str(active),
        workspaces=[
            WorkspaceEntry(
                name=p.name,
                path=str(p),
                active=p == active,
                default=p == registry.default,
                exists=p.is_dir(),
            )
            for p in registry.paths()
        ],
    )


@router.get("", response_model=WorkspaceList)
def list_workspaces(request: Request) -> WorkspaceList:
    return _listing(_registry(request))


@router.post("", response_model=WorkspaceEntry, status_code=status.HTTP_201_CREATED)
def create_workspace(body: CreateWorkspaceIn, request: Request) -> WorkspaceEntry:
    """Create ``<parent>/<name>/`` with ``pipelines/`` and ``src/``, and list it.

    The new workspace is not made active; that is a separate choice.
    """
    name = body.name.strip()
    if not NAME_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Use letters, digits, spaces, '.', '_' or '-' for the name, starting with a letter or digit",
        )
    parent = _absolute(body.parent)
    if not parent.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Folder '{parent}' does not exist")
    target = parent / name
    if target.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, f"'{target}' already exists")
    try:
        for sub in WORKSPACE_DIRS:
            (target / sub).mkdir(parents=True)
    except OSError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not create '{target}': {exc.strerror}") from exc
    registry = _registry(request)
    registry.add(target)
    return next(w for w in _listing(registry).workspaces if w.path == str(target.resolve()))


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
def forget_workspace(request: Request, path: str = Query(..., min_length=1)) -> WorkspaceList:
    """Remove a workspace from the list. Its folder and files are left alone."""
    registry = _registry(request)
    try:
        registry.forget(_absolute(path))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _listing(registry)


@fs_router.get("/dirs", response_model=DirListing)
def list_dirs(request: Request, path: str | None = Query(None)) -> DirListing:
    """Sub-folders of ``path`` (default: the folder holding the active workspace)."""
    folder = _absolute(path) if path else _registry(request).active.parent
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

"""``/api/workspace`` routes: browse the workspace folder and import code into it."""

from __future__ import annotations

import base64
import binascii
import os
import re
import shutil
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from .. import linked_folders
from ..linked_folders import KINDS, LINK_NAMES, FolderError, Kind
from ..pipelines import Workspace
from .deps import get_workspace

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

# Folders and files that are internal state or build output, not workspace content.
HIDDEN_NAMES = {"__pycache__", ".DS_Store"}
MAX_FILE_BYTES = 1_000_000


class WorkspaceNode(BaseModel):
    name: str
    path: str  # relative to the workspace root, with "/" separators
    type: Literal["dir", "file"]
    size: int | None = None
    children: list["WorkspaceNode"] | None = None


class WorkspaceFile(BaseModel):
    path: str
    size: int
    content: str | None  # None when the file is binary or too large to show
    truncated: bool = False
    binary: bool = False
    modified: float | None = None  # when it last changed (seconds); saving checks it hasn't since


class FileSave(BaseModel):
    path: str
    content: str
    modified: float | None = None  # the "modified" it was opened with: refused if the file changed since


def _visible(p: Path) -> bool:
    return not p.name.startswith(".") and p.name not in HIDDEN_NAMES


def _node(root: Path, p: Path) -> WorkspaceNode:
    rel = p.relative_to(root).as_posix()
    if p.is_dir():
        entries = sorted(
            (c for c in p.iterdir() if _visible(c)),
            key=lambda c: (not c.is_dir(), c.name.lower()),
        )
        return WorkspaceNode(
            name=p.name, path=rel, type="dir", children=[_node(root, c) for c in entries]
        )
    return WorkspaceNode(name=p.name, path=rel, type="file", size=p.stat().st_size)


def resolve_inside(root: Path, rel: str, protected: Path | None = None) -> Path:
    """Resolve ``rel`` under ``root``, refusing paths that escape it.

    ``source/`` and ``data/`` may be links to folders elsewhere (see
    linked_folders.py): paths through them resolve there. Nothing inside
    ``protected`` (PROOFLIX_HOME: users, keys, passwords) is ever reachable.
    """
    root = root.resolve()
    target = (root / rel).resolve()
    if protected is not None and linked_folders.inside(target, Path(protected).resolve()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path is outside the workspace")
    inside = lambda base: target == base or base in target.parents  # noqa: E731
    lexical = Path(os.path.normpath(root / rel))
    if inside(root):
        return target
    for name in LINK_NAMES:
        link = root / name
        if link.is_symlink() and (lexical == link or link in lexical.parents) and inside(link.resolve()):
            return target
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path is outside the workspace")


MAX_IMPORT_FILES = 2000
MAX_IMPORT_BYTES = 20 * 1024 * 1024


class ImportFile(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)  # destination, relative to the workspace
    content_base64: str


class ImportIn(BaseModel):
    files: list[ImportFile] = Field(..., min_length=1, max_length=MAX_IMPORT_FILES)
    overwrite: bool = False


class ImportResult(BaseModel):
    written: list[str]
    pipelines: list[str]  # ids of pipeline files that were added or replaced


def _clean_import_path(raw: str) -> str:
    """Normalise an uploaded path and refuse anything unsafe or hidden."""
    parts = [p for p in raw.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or raw.startswith("/") or any(p == ".." for p in parts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid path '{raw}'")
    if any(p.startswith(".") or p in HIDDEN_NAMES for p in parts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Hidden files can't be imported: '{raw}'")
    return "/".join(parts)


@router.post("/import", response_model=ImportResult)
def import_files(body: ImportIn, request: Request, ws: Workspace = Depends(get_workspace)) -> ImportResult:
    """Write uploaded files into the workspace (e.g. a folder of pipelines and code).

    Nothing is written when any path is invalid, when the upload is too large,
    or when files already exist and ``overwrite`` is false (409 with the list).
    """
    root = ws.root.resolve()
    decoded: dict[str, bytes] = {}
    total = 0
    for f in body.files:
        rel = _clean_import_path(f.path)
        resolve_inside(root, rel, request.app.state.settings.home)
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

    blocked = [
        f"'{rel}' is a folder" if (root / rel).is_dir() else f"'{rel}' is inside a file"
        for rel in decoded
        if (root / rel).is_dir() or any(p.is_file() for p in (root / rel).parents if p != root)
    ]
    if blocked:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"errors": blocked})
    existing = sorted(rel for rel in decoded if (root / rel).exists())
    if existing and not body.overwrite:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "errors": [f"{len(existing)} file(s) already exist; choose overwrite to replace them"],
                "conflicts": existing,
            },
        )

    for rel, data in decoded.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.import-tmp")
        tmp.write_bytes(data)
        tmp.replace(target)

    pipelines = sorted(
        Path(rel).stem for rel in decoded if re.fullmatch(r"pipelines/[^/]+\.ya?ml", rel)
    )
    return ImportResult(written=sorted(decoded), pipelines=pipelines)


class RemoveResult(BaseModel):
    path: str
    type: Literal["dir", "file"]
    files: int  # number of files removed
    trash: str  # where the removed item was moved, relative to the workspace


@router.delete("/item", response_model=RemoveResult)
def remove_item(
    request: Request, path: str = Query(..., min_length=1), ws: Workspace = Depends(get_workspace)
) -> RemoveResult:
    """Remove a file or folder (for example an imported project) from the workspace.

    The item is moved into ``.prooflix/trash/<timestamp>/`` rather than deleted,
    so it can be recovered by hand.
    """
    root = ws.root.resolve()
    rel = _clean_import_path(path)
    target = resolve_inside(root, rel, request.app.state.settings.home)
    if target == root or not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"'{path}' not found")
    kind: Literal["dir", "file"] = "dir" if target.is_dir() else "file"
    files = sum(1 for p in target.rglob("*") if p.is_file()) if kind == "dir" else 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = root / ".prooflix" / "trash" / stamp / rel
    n = 1
    while dest.exists():
        dest = root / ".prooflix" / "trash" / f"{stamp}-{n}" / rel
        n += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(dest))
    return RemoveResult(path=rel, type=kind, files=files, trash=dest.relative_to(root).as_posix())


@router.get("/tree", response_model=WorkspaceNode)
async def tree(ws: Workspace = Depends(get_workspace)) -> WorkspaceNode:
    """The workspace's files, without the data lake folder.

    ``data/`` holds what pipelines build (browsed in the Catalog and SQL editor tabs),
    so it is left out of the tree.
    """
    root = ws.root.resolve()
    node = _node(root, root)
    node.name = root.name
    data_lake = KINDS["data_lake"].link
    node.children = [c for c in node.children or [] if c.name != data_lake]
    return node


@router.get("/file", response_model=WorkspaceFile)
async def read_file(
    request: Request, path: str = Query(..., min_length=1), ws: Workspace = Depends(get_workspace)
) -> WorkspaceFile:
    target = resolve_inside(ws.root, path, request.app.state.settings.home)
    # as asked for: a file in a linked data lake is outside the workspace folder itself
    parts = Path(os.path.normpath(path)).parts
    hidden = any(part.startswith(".") or part in HIDDEN_NAMES for part in parts)
    if hidden or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"File '{path}' not found")
    st = target.stat()
    size = st.st_size
    raw = target.read_bytes()[:MAX_FILE_BYTES]
    if b"\0" in raw[:8192]:
        return WorkspaceFile(path=path, size=size, content=None, binary=True, modified=st.st_mtime)
    return WorkspaceFile(
        path=path,
        size=size,
        content=raw.decode("utf-8", errors="replace"),
        truncated=size > MAX_FILE_BYTES,
        modified=st.st_mtime,
    )


@router.put("/file", response_model=WorkspaceFile)
async def save_file(body: FileSave, request: Request, ws: Workspace = Depends(get_workspace)) -> WorkspaceFile:
    """Save a text file of the workspace (edited in the Workspace tab).

    Only existing text files, up to 1 MB, in the workspace or its linked folders; never
    hidden files or anything in PROOFLIX_HOME. ``409`` when the file changed since it
    was opened (``modified``), so one person's save never silently undoes another's.
    """
    target = resolve_inside(ws.root, body.path, request.app.state.settings.home)
    parts = Path(os.path.normpath(body.path)).parts
    if any(part.startswith(".") or part in HIDDEN_NAMES for part in parts) or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"File '{body.path}' not found")
    data = body.content.encode("utf-8")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Files over 1 MB can't be edited here")
    st = target.stat()
    if st.st_size > MAX_FILE_BYTES or b"\0" in target.read_bytes()[:8192]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only text files up to 1 MB can be edited here")
    if body.modified is not None and abs(st.st_mtime - body.modified) > 1e-6:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "The file changed since you opened it; reload it, then make your change again")
    tmp = target.with_name(f".{target.name}.saving")
    tmp.write_bytes(data)
    os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, target)  # atomic: a reader never sees half a file
    return await read_file(request, body.path, ws)


# ------------------------------------------------------------------ linked folders
URL_KINDS: dict[str, Kind] = {"source-data": "source_data", "data-lake": "data_lake"}


class LinkedFolderOut(BaseModel):
    kind: Kind
    link: str  # the folder's name in the workspace: "source" or "data"
    path: str  # the folder it uses
    origin: Literal["workspace", "server", "default"]  # the workspace's choice, the server default, or its own folder
    workspace_setting: str | None  # the workspace's own choice
    server_default: str | None  # PROOFLIX_SOURCE_DATA / PROOFLIX_DATA_LAKE (Helm sourceData / dataLake)
    linked: bool  # the workspace's folder is a link to it


class LinkedFolderIn(BaseModel):
    path: str | None = Field(None, description="absolute folder; null goes back to the server default or the workspace's own")


def _kind(name: str) -> Kind:
    if name not in URL_KINDS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown folder '{name}' (source-data or data-lake)")
    return URL_KINDS[name]


def _folder_out(ws: Workspace, r: linked_folders.Resolved) -> LinkedFolderOut:
    here = ws.root.resolve() / KINDS[r.kind].link
    return LinkedFolderOut(
        kind=r.kind,
        link=KINDS[r.kind].link,
        path=str(r.path),
        origin=r.origin,
        workspace_setting=str(r.workspace_setting) if r.workspace_setting else None,
        server_default=str(r.server_default) if r.server_default else None,
        linked=here.is_symlink() and here.resolve() == r.path,
    )


@router.get("/folders/{name}", response_model=LinkedFolderOut)
def get_linked_folder(name: str, request: Request, ws: Workspace = Depends(get_workspace)) -> LinkedFolderOut:
    """The active workspace's source data (``source-data``) or data lake (``data-lake``) folder."""
    kind = _kind(name)
    return _folder_out(ws, linked_folders.resolve(ws.root, kind, request.app.state.settings.folder_defaults[kind]))


@router.put("/folders/{name}", response_model=LinkedFolderOut)
def set_linked_folder(
    name: str, body: LinkedFolderIn, request: Request, ws: Workspace = Depends(get_workspace)
) -> LinkedFolderOut:
    """Choose the active workspace's source data or data lake folder: ``source/`` or
    ``data/`` becomes a link to it.

    ``400`` when the folder doesn't exist, is inside the workspace, or the
    workspace's own folder holds files (they are never replaced).
    """
    kind = _kind(name)
    path: Path | None = None
    if body.path is not None and body.path.strip():
        path = Path(body.path.strip()).expanduser()
        if not path.is_absolute():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"'{body.path}' is not an absolute path")
    try:
        settings = request.app.state.settings
        r = linked_folders.set_workspace_setting(ws.root, kind, path, settings.folder_defaults[kind], settings.home)
    except (FolderError, OSError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _folder_out(ws, r)

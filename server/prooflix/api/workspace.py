"""``/api/workspace`` routes: browse the workspace folder and import code into it."""

from __future__ import annotations

import base64
import binascii
import re
import shutil
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

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


def resolve_inside(root: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``root``, refusing paths that escape it."""
    root = root.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path is outside the workspace")
    return target


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
def import_files(body: ImportIn, ws: Workspace = Depends(get_workspace)) -> ImportResult:
    """Write uploaded files into the workspace (e.g. a folder of pipelines and code).

    Nothing is written when any path is invalid, when the upload is too large,
    or when files already exist and ``overwrite`` is false (409 with the list).
    """
    root = ws.root.resolve()
    decoded: dict[str, bytes] = {}
    total = 0
    for f in body.files:
        rel = _clean_import_path(f.path)
        resolve_inside(root, rel)
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
    path: str = Query(..., min_length=1), ws: Workspace = Depends(get_workspace)
) -> RemoveResult:
    """Remove a file or folder (for example an imported project) from the workspace.

    The item is moved into ``.prooflix/trash/<timestamp>/`` rather than deleted,
    so it can be recovered by hand.
    """
    root = ws.root.resolve()
    rel = _clean_import_path(path)
    target = resolve_inside(root, rel)
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
    root = ws.root.resolve()
    node = _node(root, root)
    node.name = root.name
    return node


@router.get("/file", response_model=WorkspaceFile)
async def read_file(
    path: str = Query(..., min_length=1), ws: Workspace = Depends(get_workspace)
) -> WorkspaceFile:
    target = resolve_inside(ws.root, path)
    parts = target.relative_to(ws.root.resolve()).parts
    hidden = any(part.startswith(".") or part in HIDDEN_NAMES for part in parts)
    if hidden or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"File '{path}' not found")
    size = target.stat().st_size
    raw = target.read_bytes()[:MAX_FILE_BYTES]
    if b"\0" in raw[:8192]:
        return WorkspaceFile(path=path, size=size, content=None, binary=True)
    return WorkspaceFile(
        path=path,
        size=size,
        content=raw.decode("utf-8", errors="replace"),
        truncated=size > MAX_FILE_BYTES,
    )

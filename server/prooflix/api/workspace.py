"""``/api/workspace`` routes: browse the workspace folder (read only)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

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

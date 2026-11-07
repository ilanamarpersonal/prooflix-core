"""``/api/runs`` routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..engine import PipelineExecutor, RunNotActive
from ..runs import Run, RunStore
from .deps import get_executor, get_store

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _get_or_404(store: RunStore, run_id: str) -> Run:
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run '{run_id}' not found")
    return run


@router.get("", response_model=list[Run])
async def list_runs(
    pipeline: str | None = None,
    root_only: bool = True,
    limit: int = Query(50, ge=1, le=500),
    store: RunStore = Depends(get_store),
) -> list[Run]:
    return store.list(pipeline=pipeline, root_only=root_only, limit=limit)


@router.get("/{run_id}", response_model=Run)
async def get_run(run_id: str, store: RunStore = Depends(get_store)) -> Run:
    return _get_or_404(store, run_id)


@router.get("/{run_id}/tree")
async def get_run_tree(run_id: str, store: RunStore = Depends(get_store)) -> dict[str, Any]:
    """The run with all of its child runs nested under ``children``."""
    tree = store.tree(run_id)
    if tree is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run '{run_id}' not found")
    return tree


@router.post("/{run_id}/cancel", response_model=Run)
async def cancel_run(
    run_id: str,
    store: RunStore = Depends(get_store),
    executor: PipelineExecutor = Depends(get_executor),
) -> Run:
    run = _get_or_404(store, run_id)
    if run.status.terminal:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Run is already {run.status.value}")
    try:
        executor.cancel(run_id)
    except RunNotActive as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Run is not active on this server") from exc
    return _get_or_404(store, run_id)

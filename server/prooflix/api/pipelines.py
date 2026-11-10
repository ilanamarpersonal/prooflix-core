"""``/api/pipelines`` routes.

Handlers are ``async`` on purpose: run records are mutated on the event loop,
so reading them on the same thread avoids partial reads.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..engine import PipelineExecutor, Scheduler
from ..pipelines import PipelineNotFound, PipelineValidationError, Workspace
from ..pipelines.models import PIPELINE_ID_PATTERN
from ..pipelines.schedule_yaml import set_schedule
from ..runs import Run
from .deps import get_executor, get_scheduler, get_workspace
from .schemas import (
    PipelineDetail,
    PipelineSourceIn,
    PipelineSummary,
    RunRequest,
    ScheduleIn,
    ValidationResult,
    detail_of,
    summary_of,
)

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])
PipelineId = str


def _invalid(errors: list[str]) -> HTTPException:
    return HTTPException(422, detail={"errors": errors})


@router.get("", response_model=list[PipelineSummary])
async def list_pipelines(
    ws: Workspace = Depends(get_workspace), scheduler: Scheduler = Depends(get_scheduler)
) -> list[PipelineSummary]:
    return [summary_of(d, ws.root, scheduler) for d in ws.load_all().values()]


@router.get("/{pipeline_id}", response_model=PipelineDetail)
async def get_pipeline(
    pipeline_id: PipelineId, ws: Workspace = Depends(get_workspace), scheduler: Scheduler = Depends(get_scheduler)
):
    defs = ws.load_all()
    if pipeline_id not in defs:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Pipeline '{pipeline_id}' not found")
    used_by = [p for p, d in defs.items() if d.spec and pipeline_id in d.spec.sub_pipelines]
    return detail_of(defs[pipeline_id], used_by, ws.root, scheduler)


@router.post("/{pipeline_id}/validate", response_model=ValidationResult)
async def validate_pipeline(
    pipeline_id: PipelineId, body: PipelineSourceIn, ws: Workspace = Depends(get_workspace)
) -> ValidationResult:
    errors = ws.validate_source(pipeline_id, body.source)
    return ValidationResult(valid=not errors, errors=errors)


@router.put("/{pipeline_id}", response_model=PipelineDetail)
async def save_pipeline(
    pipeline_id: PipelineId,
    body: PipelineSourceIn,
    response: Response,
    create_only: bool = False,
    ws: Workspace = Depends(get_workspace),
    scheduler: Scheduler = Depends(get_scheduler),
):
    """Create or replace a pipeline file. ``create_only=true`` refuses to overwrite."""
    if not re.match(PIPELINE_ID_PATTERN, pipeline_id):
        raise _invalid([f"Invalid pipeline id '{pipeline_id}'"])
    created = not ws.exists(pipeline_id)
    if create_only and not created:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"errors": [f"A pipeline with id '{pipeline_id}' already exists"]},
        )
    try:
        ws.save(pipeline_id, body.source)
    except PipelineValidationError as exc:
        raise _invalid(exc.errors) from exc
    if created:
        response.status_code = status.HTTP_201_CREATED
    return await get_pipeline(pipeline_id, ws, scheduler)


def _write_schedule(pipeline_id: str, schedule: tuple[str, str, bool] | None, ws: Workspace) -> None:
    if not ws.exists(pipeline_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Pipeline '{pipeline_id}' not found")
    try:
        ws.save(pipeline_id, set_schedule(ws.read_source(pipeline_id), schedule))
    except PipelineValidationError as exc:
        raise _invalid(exc.errors) from exc


@router.put("/{pipeline_id}/schedule", response_model=PipelineDetail)
async def set_pipeline_schedule(
    pipeline_id: PipelineId,
    body: ScheduleIn,
    ws: Workspace = Depends(get_workspace),
    scheduler: Scheduler = Depends(get_scheduler),
):
    """Set (or replace) the pipeline's schedule. Only the ``schedule:`` block of its
    YAML changes; an invalid cron expression or time zone is a 422."""
    _write_schedule(pipeline_id, (body.cron.strip(), body.timezone.strip() or "UTC", body.enabled), ws)
    return await get_pipeline(pipeline_id, ws, scheduler)


@router.delete("/{pipeline_id}/schedule", response_model=PipelineDetail)
async def remove_pipeline_schedule(
    pipeline_id: PipelineId,
    ws: Workspace = Depends(get_workspace),
    scheduler: Scheduler = Depends(get_scheduler),
):
    """Remove the schedule: the pipeline then runs only when started."""
    _write_schedule(pipeline_id, None, ws)
    return await get_pipeline(pipeline_id, ws, scheduler)


@router.delete("/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(pipeline_id: PipelineId, ws: Workspace = Depends(get_workspace)):
    if not ws.exists(pipeline_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Pipeline '{pipeline_id}' not found")
    callers = [c for c in ws.callers_of(pipeline_id) if c != pipeline_id]
    if callers:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"errors": [f"Pipeline is used as a sub-pipeline by: {', '.join(callers)}"]},
        )
    ws.delete(pipeline_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{pipeline_id}/runs", response_model=Run, status_code=status.HTTP_202_ACCEPTED)
async def start_run(
    pipeline_id: PipelineId,
    body: RunRequest | None = None,
    executor: PipelineExecutor = Depends(get_executor),
) -> Run:
    try:
        run = executor.start(pipeline_id, (body or RunRequest()).parameters)
    except PipelineNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except PipelineValidationError as exc:
        raise _invalid(exc.errors) from exc
    return run.model_copy(deep=True)

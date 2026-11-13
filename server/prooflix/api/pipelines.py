"""``/api/pipelines`` routes.

Handlers are ``async`` on purpose: run records are mutated on the event loop,
so reading them on the same thread avoids partial reads.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from ..engine import PipelineExecutor, Scheduler
from ..pipelines import PipelineNotFound, PipelineValidationError, Workspace
from ..pipelines.models import PIPELINE_ID_PATTERN, PipelineTask, ShellTask
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


# ---------------------------------------------------------------- task code
MAX_CODE_BYTES = 1_000_000


class TaskCode(BaseModel):
    """The code a task runs: a Python file, a shell command, or a sub-pipeline's YAML."""

    task: str
    type: Literal["python", "shell", "pipeline"]
    language: Literal["python", "shell", "yaml"]
    path: str | None  # relative to the workspace root; None for a shell command
    content: str
    line: int | None = None  # 1-based line where the Python function is defined
    truncated: bool = False


def _python_file(src: Path, module: str) -> Path | None:
    rel = Path(*module.split("."))
    for candidate in (src / rel.with_suffix(".py"), src / rel / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


@router.get("/{pipeline_id}/tasks/{task_key}/code", response_model=TaskCode)
def task_code(pipeline_id: PipelineId, task_key: str, ws: Workspace = Depends(get_workspace)) -> TaskCode:
    """The code behind one task of a pipeline, for showing next to the graph."""
    try:
        definition = ws.load(pipeline_id)
    except PipelineNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Pipeline '{pipeline_id}' not found") from exc
    if definition.spec is None:
        raise _invalid(definition.errors)
    task = next((t for t in definition.spec.tasks if t.key == task_key), None)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Task '{task_key}' not found in '{pipeline_id}'")
    root = ws.root

    if isinstance(task, ShellTask):
        return TaskCode(task=task_key, type="shell", language="shell", path=None, content=task.command)

    if isinstance(task, PipelineTask):
        child = ws.path_for(task.pipeline)
        if child is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Pipeline '{task.pipeline}' not found")
        return TaskCode(
            task=task_key,
            type="pipeline",
            language="yaml",
            path=child.relative_to(root).as_posix(),
            content=child.read_text(encoding="utf-8", errors="replace"),
        )

    module, _, func = task.entrypoint.partition(":")
    src = ws.src_dir_for(pipeline_id)
    file = _python_file(src, module)
    if file is None:
        where = src.relative_to(root).as_posix() if src.is_relative_to(root) else str(src)
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Module '{module}' not found in {where}/")
    raw = file.read_bytes()
    content = raw[:MAX_CODE_BYTES].decode("utf-8", errors="replace")
    match = re.search(rf"^[ \t]*(?:async[ \t]+)?def[ \t]+{re.escape(func)}\b", content, re.MULTILINE)
    return TaskCode(
        task=task_key,
        type="python",
        language="python",
        path=file.relative_to(root).as_posix(),
        content=content,
        line=content.count("\n", 0, match.start()) + 1 if match else None,
        truncated=len(raw) > MAX_CODE_BYTES,
    )

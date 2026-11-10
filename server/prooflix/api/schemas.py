"""Request and response bodies of the REST API."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..pipelines.models import PipelineTask, PythonTask
from ..pipelines.workspace import PipelineDefinition

if TYPE_CHECKING:
    from ..engine import Scheduler


class GraphNode(BaseModel):
    key: str
    type: str
    description: str | None = None
    pipeline: str | None = None
    # python tasks: the file holding the entrypoint's module, relative to the workspace
    source_file: str | None = None


class GraphEdge(BaseModel):
    source: str
    target: str


class PipelineGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class ScheduleInfo(BaseModel):
    cron: str
    timezone: str
    enabled: bool
    next_run: datetime | None = None  # None when paused
    last_run_id: str | None = None  # the last run the schedule started (since the server started)
    last_run_at: datetime | None = None  # the cron time it was due
    last_skipped_at: datetime | None = None  # a due run skipped because the previous one was still going
    last_error: str | None = None  # why the last due run couldn't start


class ScheduleIn(BaseModel):
    cron: str = Field(min_length=1, description="minute hour day-of-month month day-of-week")
    timezone: str = "UTC"
    enabled: bool = True


class SchedulePreviewIn(BaseModel):
    cron: str
    timezone: str = "UTC"


class SchedulePreview(BaseModel):
    valid: bool
    error: str | None = None
    cron: str | None = None  # normalized
    next_runs: list[datetime] = Field(default_factory=list)


class PipelineSummary(BaseModel):
    id: str
    name: str
    description: str | None = None
    valid: bool
    errors: list[str]
    task_count: int
    sub_pipelines: list[str]
    parameters: dict[str, Any]
    project: str = ""  # project folder relative to the workspace; "" for the workspace root
    file: str | None = None  # the pipeline's YAML file, relative to the workspace
    schedule: ScheduleInfo | None = None  # None: runs only when started


class PipelineDetail(PipelineSummary):
    source: str
    spec: dict[str, Any] | None
    graph: PipelineGraph
    used_by: list[str]


class PipelineSourceIn(BaseModel):
    source: str = Field(description="Pipeline YAML")


class ValidationResult(BaseModel):
    valid: bool
    errors: list[str]


class RunRequest(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)


def schedule_of(d: PipelineDefinition, scheduler: "Scheduler | None") -> ScheduleInfo | None:
    schedule = d.spec.schedule if d.spec else None
    if schedule is None:
        return None
    info = ScheduleInfo(cron=schedule.cron, timezone=schedule.timezone, enabled=schedule.enabled)
    if scheduler is not None:
        info.next_run = scheduler.next_run(d.id, schedule.cron, schedule.timezone, schedule.enabled)
        state = scheduler.states.get(d.id)
        if state is not None:
            info.last_run_id, info.last_run_at = state.last_run_id, state.last_run_at
            info.last_skipped_at, info.last_error = state.last_skipped_at, state.last_error
    return info


def summary_of(d: PipelineDefinition, root: Path | None = None, scheduler: "Scheduler | None" = None) -> PipelineSummary:
    spec = d.spec
    file = project = None
    if root is not None and d.path is not None:
        try:
            rel = d.path.resolve().relative_to(root)
            file = rel.as_posix()
            project = rel.parent.parent.as_posix()
        except ValueError:
            pass
    return PipelineSummary(
        project="" if project in (None, ".") else project,
        file=file,
        id=d.id,
        name=d.name,
        description=spec.description if spec else None,
        valid=d.valid,
        errors=d.errors,
        task_count=len(spec.tasks) if spec else 0,
        sub_pipelines=spec.sub_pipelines if spec else [],
        parameters=spec.parameters if spec else {},
        schedule=schedule_of(d, scheduler),
    )


def _module_file(d: PipelineDefinition, entrypoint: str, root: Path | None) -> str | None:
    """``hello_jobs.hello:run`` -> ``<project>/src/hello_jobs/hello.py`` (or the
    package's ``__init__.py``), if that file exists."""
    if root is None or d.path is None:
        return None
    src = d.path.resolve().parent.parent / "src"
    module = entrypoint.split(":", 1)[0].replace(".", "/")
    for candidate in (src / f"{module}.py", src / module / "__init__.py"):
        if candidate.is_file():
            try:
                return candidate.relative_to(root).as_posix()
            except ValueError:
                return None
    return None


def detail_of(
    d: PipelineDefinition, used_by: list[str], root: Path | None = None, scheduler: "Scheduler | None" = None
) -> PipelineDetail:
    spec = d.spec
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    if spec:
        keys = {t.key for t in spec.tasks}
        for t in spec.tasks:
            nodes.append(
                GraphNode(
                    key=t.key,
                    type=t.type,
                    description=t.description,
                    pipeline=t.pipeline if isinstance(t, PipelineTask) else None,
                    source_file=_module_file(d, t.entrypoint, root) if isinstance(t, PythonTask) else None,
                )
            )
            edges.extend(GraphEdge(source=dep, target=t.key) for dep in t.depends_on if dep in keys)
    return PipelineDetail(
        **summary_of(d, root, scheduler).model_dump(),
        source=d.source,
        spec=spec.model_dump(mode="json", exclude_none=True) if spec else None,
        graph=PipelineGraph(nodes=nodes, edges=edges),
        used_by=used_by,
    )

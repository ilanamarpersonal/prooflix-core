"""Pydantic models for the pipeline YAML format.

A pipeline file lives at ``<workspace>/pipelines/<pipeline_id>.yaml``. The file
name (without extension) is the pipeline id that other pipelines use to call it.

Example::

    name: Daily orders
    parameters:
      run_date: "2026-01-01"
    tasks:
      - key: ingest
        type: pipeline
        pipeline: ingest_orders
        parameters:
          run_date: ${params.run_date}
      - key: notify
        type: shell
        depends_on: [ingest]
        command: echo "rows=${tasks.ingest.output.row_count}"
    outputs:
      rows: ${tasks.ingest.output.row_count}
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

PIPELINE_ID_PATTERN = r"^[a-z0-9][a-z0-9_\-]*$"
# Task keys are identifiers so they can be referenced as ${tasks.<key>.output}.
TASK_KEY_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
ENTRYPOINT_PATTERN = r"^[A-Za-z_][\w.]*:[A-Za-z_]\w*$"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskBase(_Model):
    key: str = Field(pattern=TASK_KEY_PATTERN, description="Unique task key within the pipeline")
    description: str | None = None
    depends_on: list[str] = Field(default_factory=list, description="Upstream task keys")
    retries: int = Field(default=0, ge=0, le=10, description="Extra attempts after a failure")
    timeout_seconds: float | None = Field(default=None, gt=0)


class PythonTask(TaskBase):
    """Calls ``module:function`` from the workspace ``src/`` directory."""

    type: Literal["python"]
    entrypoint: str = Field(pattern=ENTRYPOINT_PATTERN, examples=["jobs.orders:extract"])
    parameters: dict[str, Any] = Field(default_factory=dict)


class ShellTask(TaskBase):
    """Runs a shell command with the workspace root as working directory."""

    type: Literal["shell"]
    command: str = Field(min_length=1)
    env: dict[str, str] = Field(default_factory=dict)


class PipelineTask(TaskBase):
    """Runs another pipeline of the workspace as a sub-pipeline."""

    type: Literal["pipeline"]
    pipeline: str = Field(pattern=PIPELINE_ID_PATTERN, description="Id of the pipeline to call")
    parameters: dict[str, Any] = Field(default_factory=dict)


Task = Annotated[Union[PythonTask, ShellTask, PipelineTask], Field(discriminator="type")]


class PipelineSpec(_Model):
    name: str | None = Field(default=None, description="Display name; defaults to the id")
    description: str | None = None
    parameters: dict[str, Any] = Field(
        default_factory=dict, description="Declared parameters and their default values"
    )
    tasks: list[Task] = Field(min_length=1)
    outputs: dict[str, Any] = Field(
        default_factory=dict,
        description="Values returned to a calling pipeline, usually ${tasks.<key>.output...}",
    )

    def task(self, key: str) -> PythonTask | ShellTask | PipelineTask:
        for t in self.tasks:
            if t.key == key:
                return t
        raise KeyError(key)

    @property
    def sub_pipelines(self) -> list[str]:
        seen: list[str] = []
        for t in self.tasks:
            if isinstance(t, PipelineTask) and t.pipeline not in seen:
                seen.append(t.pipeline)
        return seen

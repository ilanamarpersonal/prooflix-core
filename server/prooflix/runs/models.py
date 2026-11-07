"""Run and task-run records.

A *run* is one execution of a pipeline. A task of type ``pipeline`` starts a
*child run*; child runs point back to their parent through ``parent_run_id`` /
``parent_task_key`` and share the ``root_run_id`` of the top-level run.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

MAX_LOG_LINES = 2000


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


class RunStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    CANCELLED = "CANCELLED"

    @property
    def terminal(self) -> bool:
        return self in (RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.SKIPPED, RunStatus.CANCELLED)


class TaskRun(BaseModel):
    key: str
    type: str
    depends_on: list[str] = Field(default_factory=list)
    pipeline: str | None = Field(default=None, description="Sub-pipeline id for pipeline tasks")
    status: RunStatus = RunStatus.PENDING
    attempt: int = 0
    max_attempts: int = 1
    started_at: datetime | None = None
    ended_at: datetime | None = None
    output: Any = None
    error: str | None = None
    logs: list[str] = Field(default_factory=list)
    child_run_id: str | None = None

    def log(self, message: str) -> None:
        stamp = utcnow().strftime("%H:%M:%S")
        for line in str(message).splitlines() or [""]:
            self.logs.append(f"{stamp} {line}")
        if len(self.logs) > MAX_LOG_LINES:
            del self.logs[: len(self.logs) - MAX_LOG_LINES]


class Run(BaseModel):
    id: str = Field(default_factory=new_run_id)
    pipeline: str
    pipeline_name: str | None = None
    status: RunStatus = RunStatus.PENDING
    parameters: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    parent_run_id: str | None = None
    parent_task_key: str | None = None
    root_run_id: str | None = None
    depth: int = 0
    tasks: dict[str, TaskRun] = Field(default_factory=dict)

    @property
    def is_root(self) -> bool:
        return self.parent_run_id is None

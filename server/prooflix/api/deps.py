"""FastAPI dependencies giving routes access to shared services."""

from __future__ import annotations

from fastapi import Request

from ..engine import PipelineExecutor
from ..pipelines import Workspace
from ..runs import RunStore


def get_workspace(request: Request) -> Workspace:
    return request.app.state.workspace


def get_store(request: Request) -> RunStore:
    return request.app.state.store


def get_executor(request: Request) -> PipelineExecutor:
    return request.app.state.executor

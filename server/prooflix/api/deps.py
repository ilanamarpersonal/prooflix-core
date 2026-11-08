"""FastAPI dependencies giving routes access to shared services."""

from __future__ import annotations

from pathlib import Path

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


class CatalogPaths:
    """Where catalog tables live: the workspace (project data) and the catalog folder."""

    def __init__(self, workspace_root: Path, catalog_dir: Path):
        self.root = Path(workspace_root).resolve()
        self.catalog_dir = Path(catalog_dir).resolve()


def get_catalog_paths(request: Request) -> CatalogPaths:
    settings = request.app.state.settings
    return CatalogPaths(settings.workspace, settings.catalog_dir)

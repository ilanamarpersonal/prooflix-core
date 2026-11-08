"""FastAPI application factory.

Run in development with::

    uv run prooflix serve --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import __version__
from .api import pipelines, runs, sql, workspace as workspace_api
from .config import Settings
from .engine import PipelineExecutor
from .pipelines import Workspace
from .runs import RunStore

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    workspace = Workspace(settings.workspace)
    store = RunStore(settings.runs_dir)
    recovered = store.recover_interrupted()
    if recovered:
        log.warning("Marked %d interrupted run(s) as FAILED", recovered)
    executor = PipelineExecutor(workspace, store, max_depth=settings.max_depth)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await executor.shutdown()

    app = FastAPI(title="Prooflix", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.workspace = workspace
    app.state.store = store
    app.state.executor = executor

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(pipelines.router)
    app.include_router(runs.router)
    app.include_router(workspace_api.router)
    app.include_router(sql.router)

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": __version__, "workspace": str(workspace.root)}

    _mount_client(app, settings)
    return app


def _mount_client(app: FastAPI, settings: Settings) -> None:
    """Serve the built React client (``client/dist``) when it exists."""
    dist = settings.client_dist
    index = dist / "index.html"
    if not index.is_file():
        return

    @app.get("/{path:path}", include_in_schema=False)
    async def client(path: str):
        target = (dist / path).resolve()
        if path and target.is_file() and dist.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(index)  # client-side routing

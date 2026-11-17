"""FastAPI application factory.

Run in development with::

    uv run prooflix serve --reload
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import replace

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import __version__
from .api import clickhouse as clickhouse_api, ingestion as ingestion_api, pipelines, runs, schedules, sql, system, workspace as workspace_api
from .api import auth as auth_api
from .api import workspaces as workspaces_api
from .auth import COOKIE, PUBLIC_PATHS, UserStore, UsersFileError, can_access
from .connections import ConnectionsFileError
from .config import Settings
from .runtime import build_services, install
from .workspaces import WorkspaceRegistry

log = logging.getLogger(__name__)

REVALIDATE = "no-cache"  # may be stored, but must be checked with the server first
IMMUTABLE = "public, max-age=31536000, immutable"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    # settings.workspace is the default; the server uses the active workspace
    registry = WorkspaceRegistry(settings.workspaces_root, settings.workspaces_file, default=settings.workspace)
    settings = replace(settings, workspace=registry.keep_active())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.settings.scheduler:
            app.state.scheduler.start()
        yield
        # the services in app.state may have been replaced by a workspace switch
        await app.state.scheduler.stop()
        await app.state.executor.shutdown()

    app = FastAPI(title="Prooflix", version=__version__, lifespan=lifespan)
    app.state.registry = registry
    # PROOFLIX_CORS is applied once, so the System tab compares it with these
    app.state.boot_parameters = dict(settings.saved_parameters)
    app.state.switch_lock = asyncio.Lock()
    install(app, build_services(settings))
    app.state.users = UserStore(settings.home)  # PROOFLIX_HOME/users.json

    @app.exception_handler(ConnectionsFileError)
    async def connections_file_error(request, exc):  # fail closed (principle 11)
        log.error("%s", exc.__cause__ or exc)
        return JSONResponse({"detail": str(exc)}, status_code=500)

    @app.middleware("http")
    async def require_sign_in(request, call_next):
        """With PROOFLIX_AUTH on, /api needs a signed-in user who has the tab the path belongs to."""
        path = request.url.path
        if (
            app.state.settings.auth
            and path.startswith("/api/")
            and not any(path == p or (p.endswith("/") and path.startswith(p)) for p in PUBLIC_PATHS)
        ):
            try:
                user = app.state.users.user_for(request.cookies.get(COOKIE))
            except UsersFileError as exc:  # fail closed: never treat an unreadable file as "no users"
                return JSONResponse({"detail": str(exc)}, status_code=500)
            if user is None:
                return JSONResponse({"detail": "Sign in first"}, status_code=401)
            if not can_access(user, path):
                return JSONResponse({"detail": "You don't have access to this tab; ask an admin"}, status_code=403)
            request.state.user = user
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(pipelines.router)
    app.include_router(schedules.router)
    app.include_router(runs.router)
    app.include_router(workspace_api.router)
    app.include_router(workspaces_api.router)
    app.include_router(workspaces_api.fs_router)
    app.include_router(sql.router)
    app.include_router(sql.catalog_router)
    app.include_router(system.router)
    app.include_router(clickhouse_api.router)
    app.include_router(ingestion_api.router)
    app.include_router(auth_api.router)
    app.include_router(auth_api.users_router)

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": __version__, "workspace": str(app.state.workspace.root)}

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
            if path.startswith("assets/"):
                # Vite puts a content hash in these file names, so a new build
                # gets new names and the old files can be cached forever.
                return FileResponse(target, headers={"Cache-Control": IMMUTABLE})
            return FileResponse(target, headers={"Cache-Control": REVALIDATE})
        # The page itself (and client-side routes): always check for a newer
        # build, so a rebuild shows up on a normal reload.
        return FileResponse(index, headers={"Cache-Control": REVALIDATE})

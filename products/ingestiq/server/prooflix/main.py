"""FastAPI application factory.

Run in development with::

    uv run prooflix serve --reload
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import replace

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from . import __version__
from .api import clickhouse as clickhouse_api, ingestion as ingestion_api, pipelines, runs, schedules, sql, system, workspace as workspace_api
from .alerts import AlertsFileError
from .api import alerts as alerts_api
from .api import ai_assist as ai_assist_api
from .ai_assist import AiAssistFileError, AiAssistStore
from .api import semantic as semantic_api
from .api import ontology as ontology_api
from .api import auth as auth_api
from .api import workspaces as workspaces_api
from .api import mcp as mcp_api
from .mcp_tokens import TokenStore
from .search_index import Indexer
from .exports import Exports
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
            app.state.indexer.start(app)  # keeps fast-search indexes up to date with their tables
        yield
        app.state.indexer.stop()
        app.state.exports.stop()
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
    app.state.indexer = Indexer()  # the object model's fast-search indexes (search_index.py)
    app.state.exports = Exports()  # background exports of object sets (exports.py)
    app.state.ai_assist = AiAssistStore(settings.home)  # PROOFLIX_HOME/ai_assist.json
    app.state.mcp_tokens = TokenStore(settings.home)  # PROOFLIX_HOME/mcp_tokens.json: MCP personal tokens

    @app.exception_handler(AlertsFileError)
    async def alerts_file_error(request, exc):  # fail closed (principle 11)
        return JSONResponse({"detail": str(exc)}, status_code=500)

    @app.exception_handler(AiAssistFileError)
    async def ai_assist_file_error(request, exc):  # fail closed (principle 11)
        return JSONResponse({"detail": str(exc)}, status_code=500)

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
    app.include_router(alerts_api.router)
    app.include_router(semantic_api.router)
    app.include_router(ontology_api.router)
    app.include_router(ai_assist_api.router)
    app.include_router(mcp_api.router)  # /mcp: the MCP server over the Object API (PROOFLIX_MCP)
    app.include_router(mcp_api.api_router)
    app.include_router(auth_api.router)
    app.include_router(auth_api.users_router)

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": __version__, "workspace": str(app.state.workspace.root)}

    _mount_client(app, settings)
    return app


# The products this server serves under their own path (packages/ui/src/lib/products.ts), and the
# tabs of each that used to be served at the root (or, for InsightIQ's, under /ingestiq/): old links
# and bookmarks are sent on to the product that has the tab now.
PRODUCT_PATHS = {"ingestiq": "/ingestiq", "insightiq": "/insightiq", "settings": "/settings"}
LEGACY_ROUTES = {
    **{t: "ingestiq" for t in ("pipelines", "runs", "ingestion", "workspace", "alerts")},
    **{t: "ingestiq" for t in ("sql", "catalog", "semantic", "clickhouse")},
    **{t: "settings" for t in ("system", "users", "ai-assist")},
}


def _mount_client(app: FastAPI, settings: Settings) -> None:
    """Serve the built clients: each product's under its path and the portal's at ``/``."""
    dists = {
        "ingestiq": settings.client_dist,
        "insightiq": settings.insightiq_dist,
        "settings": settings.settings_dist,
    }
    built = {name: dist for name, dist in dists.items() if (dist / "index.html").is_file()}
    portal = settings.portal_dist if (settings.portal_dist / "index.html").is_file() else None

    def redirect(target: str, request: Request) -> RedirectResponse:
        query = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(f"{target}{query}", status_code=307)

    for name, dist in built.items():
        _mount_product(app, PRODUCT_PATHS[name], dist, name, built, redirect)

    if portal is None and not built:
        return

    @app.get("/{path:path}", include_in_schema=False)
    async def portal_client(path: str, request: Request):
        first = path.split("/", 1)[0]
        owner = LEGACY_ROUTES.get(first)
        if owner in built:
            return redirect(f"{PRODUCT_PATHS[owner]}/{path}", request)
        if portal is None:  # no portal build (development): the first product
            return redirect(f"{PRODUCT_PATHS[next(iter(built))]}/{path}", request)
        return _serve(portal, path)


def _mount_product(app: FastAPI, prefix: str, dist: Path, name: str, built: dict, redirect) -> None:
    @app.get(prefix, include_in_schema=False)
    async def product_root():
        return RedirectResponse(f"{prefix}/", status_code=308)

    @app.get(prefix + "/{path:path}", include_in_schema=False)
    async def product_client(path: str, request: Request):
        # a tab that moved to another product (e.g. /ingestiq/sql -> /insightiq/sql)
        owner = LEGACY_ROUTES.get(path.split("/", 1)[0])
        if owner and owner != name and owner in built:
            return redirect(f"{PRODUCT_PATHS[owner]}/{path}", request)
        return _serve(dist, path)


def _serve(dist: Path, path: str) -> FileResponse:
    """A file of a built client, or its index.html for client-side routes."""
    target = (dist / path).resolve()
    if path and target.is_file() and dist.resolve() in target.parents:
        if path.startswith("assets/"):
            # Vite puts a content hash in these file names, so a new build
            # gets new names and the old files can be cached forever.
            return FileResponse(target, headers={"Cache-Control": IMMUTABLE})
        return FileResponse(target, headers={"Cache-Control": REVALIDATE})
    # The page itself (and client-side routes): always check for a newer
    # build, so a rebuild shows up on a normal reload.
    return FileResponse(dist / "index.html", headers={"Cache-Control": REVALIDATE})

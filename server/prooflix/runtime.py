"""The services bound to the active workspace, and switching between workspaces.

Pipelines, run history (``<workspace>/.prooflix/runs``) and the scheduler all
belong to one workspace. Switching builds a fresh set for the new workspace and
swaps it into ``app.state``, so routes (which read ``app.state`` on every
request) see the new workspace straight away, without a server restart.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace
from pathlib import Path

from fastapi import FastAPI

from . import linked_folders
from .alerts import AlertEngine, AlertStore
from .config import Settings
from .connections import ConnectionStore
from .engine import PipelineExecutor, Scheduler
from .pipelines import Workspace
from .runs import RunStore

log = logging.getLogger(__name__)


class WorkspaceBusy(Exception):
    """Runs are still going in the current workspace."""


@dataclass
class Services:
    settings: Settings
    workspace: Workspace
    store: RunStore
    executor: PipelineExecutor
    scheduler: Scheduler
    connections: ConnectionStore
    alert_store: AlertStore
    alerts: AlertEngine


def build_services(settings: Settings) -> Services:
    # <workspace>/source and data link to the source data and data lake folders
    linked_folders.apply(settings.workspace, settings.folder_defaults, protected=settings.home)
    workspace = Workspace(settings.workspace)
    store = RunStore(settings.runs_dir)
    recovered = store.recover_interrupted()
    if recovered:
        log.warning("Marked %d interrupted run(s) as FAILED", recovered)
    connections = ConnectionStore(settings.home)  # PROOFLIX_HOME/connections.json

    def connection(name: str) -> dict | None:
        found = connections.get(name)
        return found.for_task() if found is not None else None

    alert_store = AlertStore(settings.home)  # PROOFLIX_HOME/alerts.json
    alerts = AlertEngine(alert_store)
    executor = PipelineExecutor(
        workspace,
        store,
        max_depth=settings.max_depth,
        start_date=settings.start_date,
        connections=connection,
        on_log=alerts.handle,
    )
    scheduler = Scheduler(workspace, executor, store)
    return Services(settings, workspace, store, executor, scheduler, connections, alert_store, alerts)


def install(app: FastAPI, services: Services) -> None:
    app.state.settings = services.settings
    app.state.workspace = services.workspace
    app.state.store = services.store
    app.state.executor = services.executor
    app.state.scheduler = services.scheduler
    app.state.connections = services.connections
    app.state.alert_store = services.alert_store
    app.state.alerts = services.alerts


async def switch_workspace(app: FastAPI, root: Path) -> bool:
    """Make ``root`` the active workspace. Returns False when it already was.

    Refuses (``WorkspaceBusy``) while runs are going, rather than cancelling
    them: they belong to the current workspace's run history.
    """
    root = Path(root).resolve()
    lock: asyncio.Lock = app.state.switch_lock
    async with lock:
        current: Settings = app.state.settings
        if root == current.workspace.resolve():
            app.state.registry.set_active(root)
            return False
        running = app.state.executor.active_count()
        if running:
            raise WorkspaceBusy(
                f"{running} run{'s are' if running != 1 else ' is'} still going in this workspace; "
                "wait for them to finish or cancel them, then switch"
            )
        # The catalog follows the workspace unless PROOFLIX_CATALOG pins it
        services = build_services(replace(current, workspace=root))
        await app.state.scheduler.stop()
        await app.state.executor.shutdown()
        install(app, services)
        if services.settings.scheduler:
            services.scheduler.start()
        app.state.registry.set_active(root)
        log.info("Active workspace is now %s", root)
        return True


async def restart(app: FastAPI) -> Settings:
    """Read the parameters again and rebuild every service, as a server start does.

    Picks up values edited in the System tab (``PROOFLIX_HOME/parameters.json``)
    without stopping the process. Only the allowed browser origins
    (``PROOFLIX_CORS``) are fixed for the life of the process. Refuses
    (``WorkspaceBusy``) while runs are going.
    """
    from .workspaces import WorkspaceRegistry  # imported here: workspaces imports nothing from runtime

    lock: asyncio.Lock = app.state.switch_lock
    async with lock:
        running = app.state.executor.active_count()
        if running:
            raise WorkspaceBusy(
                f"{running} run{'s are' if running != 1 else ' is'} still going; "
                "wait for them to finish or cancel them, then restart"
            )
        current: Settings = app.state.settings
        fresh = replace(
            Settings.from_env(),
            client_dist=current.client_dist,
            cors_origins=current.cors_origins,  # the CORS middleware is built once
        )
        registry = WorkspaceRegistry(fresh.workspaces_root, fresh.workspaces_file, default=fresh.workspace)
        services = build_services(replace(fresh, workspace=registry.keep_active()))
        await app.state.scheduler.stop()
        await app.state.executor.shutdown()
        app.state.registry = registry
        install(app, services)
        if services.settings.scheduler:
            services.scheduler.start()
        log.info("Restarted with the current parameters (workspace %s)", services.settings.workspace)
        return services.settings

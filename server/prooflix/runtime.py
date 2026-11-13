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

from .config import Settings
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


def build_services(settings: Settings) -> Services:
    workspace = Workspace(settings.workspace)
    store = RunStore(settings.runs_dir)
    recovered = store.recover_interrupted()
    if recovered:
        log.warning("Marked %d interrupted run(s) as FAILED", recovered)
    executor = PipelineExecutor(workspace, store, max_depth=settings.max_depth)
    scheduler = Scheduler(workspace, executor, store)
    return Services(settings, workspace, store, executor, scheduler)


def install(app: FastAPI, services: Services) -> None:
    app.state.settings = services.settings
    app.state.workspace = services.workspace
    app.state.store = services.store
    app.state.executor = services.executor
    app.state.scheduler = services.scheduler


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

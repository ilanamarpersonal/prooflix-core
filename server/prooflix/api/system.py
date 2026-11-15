"""``/api/system`` routes: the server's settings (system parameters), read only."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..config import DEFAULT_WORKSPACES, Settings

router = APIRouter(prefix="/api/system", tags=["system"])


class SystemParameter(BaseModel):
    name: str  # the environment variable that sets it
    value: str | None  # what the server uses now; None: not set
    default: str  # what is used when the variable is not set
    source: Literal["environment", "default"]
    description: str


def _path(p) -> str | None:
    return str(p) if p is not None else None


@dataclass(frozen=True)
class _Param:
    name: str
    description: str
    default: str
    value: Callable[[Settings], str | None]


# In the order of the Settings docstring (config.py).
PARAMS: tuple[_Param, ...] = (
    _Param(
        "PROOFLIX_WORKSPACES",
        "Folder of workspaces: each sub-folder with pipelines/ is a workspace.",
        str(DEFAULT_WORKSPACES),
        lambda s: _path(s.workspaces_root),
    ),
    _Param(
        "PROOFLIX_WORKSPACE",
        "Default workspace, used until another one is made active in the Workspace tab.",
        "the first workspace in PROOFLIX_WORKSPACES",
        # app settings hold the active workspace, so show only what was asked for
        lambda s: os.environ.get("PROOFLIX_WORKSPACE") or None,
    ),
    _Param(
        "PROOFLIX_MAX_DEPTH",
        "Maximum sub-pipeline nesting depth.",
        "10",
        lambda s: str(s.max_depth),
    ),
    _Param(
        "PROOFLIX_CORS",
        "Browser origins allowed to call the API (comma-separated).",
        ", ".join(Settings.__dataclass_fields__["cors_origins"].default),
        lambda s: ", ".join(s.cors_origins),
    ),
    _Param(
        "PROOFLIX_CATALOG",
        "Folder holding catalog schemas that are not part of a project.",
        "a catalog folder next to the workspaces folder",
        lambda s: _path(s.catalog_dir),
    ),
    _Param(
        "PROOFLIX_SCHEDULER",
        "Run pipelines on their cron schedules (\"0\" turns it off).",
        "on",
        lambda s: "on" if s.scheduler else "off",
    ),
    _Param(
        "PROOFLIX_HOME",
        "Folder for server-wide state: the list of workspaces and which one is active.",
        "~/.prooflix",
        lambda s: _path(s.home),
    ),
    _Param(
        "PROOFLIX_SOURCE_DATA",
        "Default source data folder (the raw files pipelines read) for every workspace.",
        "each workspace's own source/ folder",
        lambda s: _path(s.source_data),
    ),
    _Param(
        "PROOFLIX_DATA_LAKE",
        "Default data lake folder (what pipelines build) for every workspace.",
        "each workspace's own data/ folder",
        lambda s: _path(s.data_lake),
    ),
)


@router.get("/parameters", response_model=list[SystemParameter])
async def parameters(request: Request) -> list[SystemParameter]:
    settings: Settings = request.app.state.settings
    return [
        SystemParameter(
            name=p.name,
            value=p.value(settings),
            default=p.default,
            source="environment" if os.environ.get(p.name) else "default",
            description=p.description,
        )
        for p in PARAMS
    ]

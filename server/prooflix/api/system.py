"""``/api/system`` routes: the server's settings (system parameters).

Each parameter is an environment variable read when the server starts. A value
edited here is saved to ``PROOFLIX_HOME/parameters.json``, wins over the
environment variable and is used from the next start on (see ``config.py``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from ..config import (
    DEFAULT_WORKSPACES,
    Settings,
    load_saved_parameters,
    parse_flag,
    parse_start_date,
    save_parameters,
)
from ..runtime import WorkspaceBusy, restart

router = APIRouter(prefix="/api/system", tags=["system"])


class SystemParameter(BaseModel):
    name: str  # the environment variable that sets it
    value: str | None  # what the server uses now; None: not set
    default: str  # what is used when the variable is not set
    source: Literal["saved", "environment", "default"]  # where the value in use comes from
    description: str
    editable: bool
    # "folder": a path on the server, chosen with a folder browser; "date": a date picker;
    # "secret": a password, never sent back (value and saved show "********" when set)
    kind: Literal["folder", "date", "text", "secret"]
    saved: str | None  # the value edited in the System tab, if any
    restart_needed: bool  # the saved value changed since the last (re)start
    # applied by the Restart button; False: only a restart of the server process applies it
    live: bool


class ParameterUpdate(BaseModel):
    value: str | None  # None or "": remove the saved value


def _path(p) -> str | None:
    return str(p) if p is not None else None


def _parse_path(raw: str) -> str:
    return str(Path(raw).expanduser().resolve())


def _parse_dir(raw: str) -> str:
    path = Path(raw).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"{path} is not a folder")
    return str(path)


def _parse_depth(raw: str) -> str:
    try:
        n = int(raw)
    except ValueError:
        raise ValueError("must be a whole number") from None
    if not 1 <= n <= 100:
        raise ValueError("must be between 1 and 100")
    return str(n)


def _parse_flag(raw: str) -> str:
    if raw.strip().lower() not in ("1", "true", "yes", "on", "0", "false", "no", "off"):
        raise ValueError('must be "on" or "off"')
    return "on" if parse_flag(raw) else "off"


def _parse_http_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not url.startswith(("http://", "https://")) or len(url) < 10:
        raise ValueError("must be an http:// or https:// URL, e.g. http://localhost:8123")
    return url


def _parse_text(raw: str) -> str:
    return raw.strip()


def _parse_origins(raw: str) -> str:
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    bad = [o for o in origins if not o.startswith(("http://", "https://"))]
    if not origins or bad:
        raise ValueError("must be http:// or https:// origins, separated by commas")
    return ",".join(origins)


@dataclass(frozen=True)
class _Param:
    name: str
    description: str
    default: str
    value: Callable[[Settings], str | None]
    # normalises an edited value, raising ValueError; None: can't be edited here
    parse: Callable[[str], str] | None
    live: bool = True  # False: fixed for the life of the server process
    secret: bool = False  # a password: its value is never shown


# In the order of the Settings docstring (config.py).
PARAMS: tuple[_Param, ...] = (
    _Param(
        "PROOFLIX_WORKSPACES",
        "Folder of workspaces: each sub-folder with pipelines/ is a workspace.",
        str(DEFAULT_WORKSPACES),
        lambda s: _path(s.workspaces_root),
        _parse_dir,
    ),
    _Param(
        "PROOFLIX_WORKSPACE",
        "Default workspace, used until another one is made active in the Workspace tab.",
        "the first workspace in PROOFLIX_WORKSPACES",
        # app settings hold the active workspace, so show only what was asked for
        lambda s: s.saved_parameters.get("PROOFLIX_WORKSPACE") or os.environ.get("PROOFLIX_WORKSPACE") or None,
        _parse_dir,
    ),
    _Param(
        "PROOFLIX_MAX_DEPTH",
        "Maximum sub-pipeline nesting depth.",
        "10",
        lambda s: str(s.max_depth),
        _parse_depth,
    ),
    _Param(
        "PROOFLIX_CORS",
        "Browser origins allowed to call the API (comma-separated).",
        ", ".join(Settings.__dataclass_fields__["cors_origins"].default),
        lambda s: ", ".join(s.cors_origins),
        _parse_origins,
        live=False,
    ),
    _Param(
        "PROOFLIX_CATALOG",
        "Folder holding catalog schemas that are not part of a project.",
        "a catalog folder next to the workspaces folder",
        lambda s: _path(s.catalog_dir),
        _parse_path,
    ),
    _Param(
        "PROOFLIX_SCHEDULER",
        "Run pipelines on their cron schedules (\"off\" turns it off).",
        "on",
        lambda s: "on" if s.scheduler else "off",
        _parse_flag,
    ),
    _Param(
        "PROOFLIX_START_DATE",
        "Where data processing starts when the system is initialized: a pipeline with no "
        "checkpoint yet processes data from this date on (UTC). Pipelines read it as "
        "ctx.start_date or ${system.start_date}.",
        "1970-01-01 (all data)",
        lambda s: s.start_date,
        parse_start_date,
    ),
    _Param(
        "PROOFLIX_HOME",
        "Folder for server-wide state: the list of workspaces, which one is active and the "
        "parameters edited here. Set it with the environment variable only.",
        "~/.prooflix",
        lambda s: _path(s.home),
        None,  # edited values are saved in it
    ),
    _Param(
        "PROOFLIX_SOURCE_DATA",
        "Default source data folder (the raw files pipelines read) for every workspace.",
        "each workspace's own source/ folder",
        lambda s: _path(s.source_data),
        _parse_dir,
    ),
    _Param(
        "PROOFLIX_DATA_LAKE",
        "Default data lake folder (what pipelines build) for every workspace.",
        "each workspace's own data/ folder",
        lambda s: _path(s.data_lake),
        _parse_dir,
    ),
    _Param(
        "PROOFLIX_CLICKHOUSE_URL",
        "ClickHouse HTTP endpoint the ClickHouse tab copies gold tables to.",
        "not set: the ClickHouse tab is off",
        lambda s: s.clickhouse_url,
        _parse_http_url,
    ),
    _Param(
        "PROOFLIX_CLICKHOUSE_USER",
        "ClickHouse user Prooflix creates and loads the tables with.",
        "default",
        lambda s: s.clickhouse_user,
        _parse_text,
    ),
    _Param(
        "PROOFLIX_CLICKHOUSE_PASSWORD",
        "Password of that ClickHouse user (never shown).",
        "none",
        lambda s: s.clickhouse_password or None,
        _parse_text,
        secret=True,
    ),
    _Param(
        "PROOFLIX_CLICKHOUSE_PUBLIC_URL",
        "Where people outside connect to query ClickHouse (shown in the ClickHouse tab).",
        "the ClickHouse URL",
        lambda s: s.clickhouse_public_url,
        _parse_http_url,
    ),
    _Param(
        "PROOFLIX_CLICKHOUSE_READER",
        "The read-only ClickHouse user they connect as (shown in the ClickHouse tab).",
        "not set",
        lambda s: s.clickhouse_reader,
        _parse_text,
    ),
)
_BY_NAME = {p.name: p for p in PARAMS}
MASK = "********"


def _kind(p: _Param) -> Literal["folder", "date", "text", "secret"]:
    if p.secret:
        return "secret"
    if p.parse in (_parse_dir, _parse_path) or p.name == "PROOFLIX_HOME":
        return "folder"
    return "date" if p.parse is parse_start_date else "text"


def _list(settings: Settings, boot: dict[str, str] | None = None) -> list[SystemParameter]:
    saved_now = load_saved_parameters(settings.home)
    started = settings.saved_parameters
    boot = started if boot is None else boot  # what the process started with

    def source(name: str) -> Literal["saved", "environment", "default"]:
        if started.get(name):
            return "saved"
        return "environment" if os.environ.get(name) else "default"

    def shown(p: _Param, value: str | None) -> str | None:
        return MASK if p.secret and value else value

    return [
        SystemParameter(
            name=p.name,
            value=shown(p, p.value(settings)),
            default=p.default,
            source=source(p.name),
            description=p.description,
            editable=p.parse is not None and settings.home is not None,
            kind=_kind(p),
            saved=shown(p, saved_now.get(p.name)),
            restart_needed=saved_now.get(p.name) != (started if p.live else boot).get(p.name),
            live=p.live,
        )
        for p in PARAMS
    ]


@router.get("/parameters", response_model=list[SystemParameter])
async def parameters(request: Request) -> list[SystemParameter]:
    return _list(request.app.state.settings, _boot(request))


def _boot(request: Request) -> dict[str, str] | None:
    return getattr(request.app.state, "boot_parameters", None)


@router.post("/restart", response_model=list[SystemParameter])
async def restart_server(request: Request) -> list[SystemParameter]:
    """Apply the edited parameters: read them again and rebuild every service.

    The process keeps running, so this works the same on a laptop and in Kubernetes.
    Refused while runs are going.
    """
    try:
        settings = await restart(request.app)
    except WorkspaceBusy as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    except (OSError, ValueError, RuntimeError) as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Restart failed: {e}") from None
    return _list(settings, _boot(request))


@router.put("/parameters/{name}", response_model=list[SystemParameter])
async def set_parameter(name: str, body: ParameterUpdate, request: Request) -> list[SystemParameter]:
    """Save a parameter's value (used from the next start), or remove the saved value."""
    settings: Settings = request.app.state.settings
    param = _BY_NAME.get(name)
    if param is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown parameter '{name}'")
    if param.parse is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{name} can only be set with the environment variable")
    if settings.home is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No PROOFLIX_HOME folder to save parameters in")
    saved = load_saved_parameters(settings.home)
    raw = (body.value or "").strip()
    if raw:
        try:
            saved[name] = param.parse(raw)
        except ValueError as e:
            raise HTTPException(422, f"{name}: {e}") from None
    else:
        saved.pop(name, None)
    save_parameters(settings.home, saved)
    return _list(settings, _boot(request))

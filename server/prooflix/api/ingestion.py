"""``/api/ingestion`` routes: database connections and ingestion jobs (the Ingestion tab).

Connections live in ``PROOFLIX_HOME/connections.json``; jobs are pipelines (see
``ingestion.py``), so running one now uses ``POST /api/pipelines/{id}/runs`` and its
cron schedule is part of the job form.
"""

from __future__ import annotations

import asyncio
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from ..connections import KINDS, Connection, ConnectionStore, DatabaseUnreachable, describe, kinds_for_client
from ..engine import PipelineExecutor, Scheduler
from ..ingestion import ENTRYPOINT, TASK_MODULE, JobSpec, job_of, render, spec_of, takes_dates, task_project, valid_id
from ..runs.models import Run
from ..pipelines import Workspace
from ..pipelines.errors import PipelineValidationError
from .deps import get_executor, get_scheduler, get_workspace

router = APIRouter(prefix="/api/ingestion", tags=["ingestion"])


def get_connections(request: Request) -> ConnectionStore:
    return request.app.state.connections


# ------------------------------------------------------------ connections
class ConnectionIn(BaseModel):
    kind: str
    host: str = Field(min_length=1)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str = Field(min_length=1)
    user: str = Field(min_length=1)
    password: str = ""  # "********" keeps the saved one
    options: dict = {}  # per type: connect_by (Oracle), encrypt / trust_server_certificate (SQL Server)


class ConnectionOut(BaseModel):
    name: str
    kind: str
    host: str
    port: int
    database: str
    user: str
    password: str  # "********" when set
    options: dict
    jdbc_url: str


class ColumnOut(BaseModel):
    name: str
    type: str
    watermark: bool  # a date, timestamp or integer column: can mark which rows are new


class SourceTable(BaseModel):
    schema_: str = Field(alias="schema", serialization_alias="schema")
    name: str
    primary_key: list[str] = []
    columns: list[ColumnOut]

    model_config = {"populate_by_name": True}


class TestResult(BaseModel):
    ok: bool
    tables: int | None = None
    error: str | None = None


def _jobs_using(ws: Workspace, name: str) -> list[str]:
    return [j["id"] for d in ws.load_all().values() if (j := job_of(d)) and j["connection"] == name]


def _find(store: ConnectionStore, name: str) -> Connection:
    conn = store.get(name)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No connection named '{name}'")
    return conn


@router.get("/kinds")
def kinds() -> list[dict]:
    """The database types and the fields each one's connection form asks for."""
    return kinds_for_client()


@router.get("/connections", response_model=list[ConnectionOut])
def list_connections(store: ConnectionStore = Depends(get_connections)) -> list[dict]:
    return [c.public() for c in store.list()]


@router.put("/connections/{name}", response_model=ConnectionOut)
def save_connection(name: str, body: ConnectionIn, store: ConnectionStore = Depends(get_connections)) -> dict:
    kind = KINDS.get(body.kind)
    if kind is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"type must be one of {', '.join(KINDS)}")
    default_port = next(f.default for f in kind.fields if f.key == "port")
    conn = Connection(name=name, kind=body.kind, host=body.host.strip(), port=body.port or default_port,
                      database=body.database.strip(), user=body.user.strip(), password=body.password,
                      options=dict(body.options))
    try:
        return store.save(conn).public()
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


@router.delete("/connections/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(name: str, store: ConnectionStore = Depends(get_connections),
                      ws: Workspace = Depends(get_workspace)) -> Response:
    used = _jobs_using(ws, name)
    if used:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Used by ingestion job{'s' if len(used) > 1 else ''} "
                            f"{', '.join(used)}; delete or change those first")
    if not store.delete(name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No connection named '{name}'")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/connections/{name}/test", response_model=TestResult)
async def test_connection(name: str, store: ConnectionStore = Depends(get_connections)) -> TestResult:
    conn = _find(store, name)
    try:
        tables = await asyncio.to_thread(describe, conn)
    except DatabaseUnreachable as e:
        return TestResult(ok=False, error=str(e))
    return TestResult(ok=True, tables=len(tables))


@router.get("/connections/{name}/tables", response_model=list[SourceTable], response_model_by_alias=True)
async def source_tables(name: str, store: ConnectionStore = Depends(get_connections)) -> list[dict]:
    conn = _find(store, name)
    try:
        return await asyncio.to_thread(describe, conn)
    except DatabaseUnreachable as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from None


# ------------------------------------------------------------ jobs
class JobSchedule(BaseModel):
    cron: str
    timezone: str
    enabled: bool
    next_run: str | None = None


class JobOut(BaseModel):
    id: str
    name: str
    connection: str | None
    start_date: str | None
    tables: list[dict]
    schedule: JobSchedule | None
    errors: list[str] = []


class JobsOut(BaseModel):
    jobs: list[JobOut]
    task_ready: bool  # the workspace has src/bronze/jdbc_ingest.py
    task_module: str


def _job_out(d, scheduler: Scheduler) -> JobOut | None:
    job = job_of(d)
    if job is None:
        return None
    s = job["schedule"]
    if s:
        nxt = scheduler.next_run(d.id, s["cron"], s["timezone"], s["enabled"])
        job["schedule"] = JobSchedule(**s, next_run=nxt.isoformat() if nxt else None)
    return JobOut(**job, errors=d.errors)


@router.get("/jobs", response_model=JobsOut)
def list_jobs(ws: Workspace = Depends(get_workspace), scheduler: Scheduler = Depends(get_scheduler)) -> JobsOut:
    jobs = [j for d in ws.load_all().values() if (j := _job_out(d, scheduler))]
    return JobsOut(jobs=jobs, task_ready=task_project(ws) is not None, task_module=TASK_MODULE.as_posix())


@router.put("/jobs/{job_id}", response_model=JobOut)
def save_job(job_id: str, body: JobSpec, response: Response, create_only: bool = False,
             ws: Workspace = Depends(get_workspace), scheduler: Scheduler = Depends(get_scheduler),
             store: ConnectionStore = Depends(get_connections)) -> JobOut:
    """Create or replace a job, schedule included (None: runs only when started)."""
    if not valid_id(job_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            "Job id: lowercase letters, digits, _ and -, starting with a letter or digit")
    if store.get(body.connection) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"No connection named '{body.connection}'")
    if ws.exists(job_id):
        current = ws.load(job_id)
        if create_only:
            raise HTTPException(status.HTTP_409_CONFLICT, f"A pipeline with id '{job_id}' already exists")
        if job_of(current) is None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Pipeline '{job_id}' exists and isn't an ingestion job; choose another id")
    else:
        response.status_code = status.HTTP_201_CREATED
    project = task_project(ws)
    if project is None:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"The workspace has no {TASK_MODULE.as_posix()} for {ENTRYPOINT} to call")
    try:
        definition = ws.save(job_id, render(job_id, body), project=project)
    except PipelineValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(e.errors)) from None
    return _job_out(definition, scheduler)


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(job_id: str, ws: Workspace = Depends(get_workspace)) -> Response:
    if not ws.exists(job_id) or job_of(ws.load(job_id)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No ingestion job '{job_id}'")
    callers = [c for c in ws.callers_of(job_id) if c != job_id]
    if callers:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Called by pipeline {', '.join(callers)}")
    ws.delete(job_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class RangeRun(BaseModel):
    from_date: str | None = None  # YYYY-MM-DD, included; None: from the beginning
    to_date: str | None = None  # YYYY-MM-DD, included; None: up to now


@router.post("/jobs/{job_id}/runs", response_model=Run, status_code=status.HTTP_202_ACCEPTED)
async def run_job_for_dates(job_id: str, body: RangeRun, ws: Workspace = Depends(get_workspace),
                      executor: PipelineExecutor = Depends(get_executor)) -> Run:
    """Run a job for the rows between two dates only: each table with a date or timestamp
    watermark copies that range and replaces it in bronze."""
    try:
        low = date.fromisoformat(body.from_date) if body.from_date else None
        high = date.fromisoformat(body.to_date) if body.to_date else None
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Dates are YYYY-MM-DD") from None
    if low is None and high is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a from date, a to date, or both")
    if low and high and high < low:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The to date is before the from date")
    if not ws.exists(job_id) or (job := job_of(definition := ws.load(job_id))) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No ingestion job '{job_id}'")
    if not takes_dates(definition):  # saved before date ranges existed: write it again with them
        try:
            ws.save(job_id, render(job_id, spec_of(job)))
        except PipelineValidationError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(e.errors)) from None
    params = {"from_date": body.from_date or None, "to_date": body.to_date or None}
    try:
        return executor.start(job_id, params).model_copy(deep=True)
    except PipelineValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(e.errors)) from None

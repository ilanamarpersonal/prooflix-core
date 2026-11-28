"""Ingestion jobs: copy tables of a relational database into the bronze layer.

The Ingestion tab defines a job as a database connection (see ``connections.py``),
the tables and columns to copy, the column that tells which rows are new (the
watermark) and the date to start from. A job is stored as an ordinary pipeline,
``pipelines/<job id>.yaml``, with one Python task calling the workspace's
``bronze.jdbc_ingest:run`` (Spark over JDBC), so it runs, is scheduled with a cron
expression, shows its runs and can be stopped like every other pipeline::

    # Managed by the Ingestion tab ...
    name: Ingest bankdb
    schedule:
      cron: "0 2 * * *"
    tasks:
      - key: ingest
        type: python
        entrypoint: bronze.jdbc_ingest:run
        parameters:
          connection: bankdb
          start_date: "2024-01-01"
          tables:
            - source: core.accounts
              target: bankdb_accounts
              columns: [account_id, balance, updated_at]   # [] = every column
              watermark: updated_at                         # null = full copy each run
              keys: [account_id]                            # rows with a key already in bronze are overwritten

The whole job, schedule included, is configured in the tab; its file is generated.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator

from .pipelines import Workspace
from .pipelines.models import PIPELINE_ID_PATTERN, PythonTask
from .pipelines.schedule_yaml import set_schedule
from .pipelines.workspace import PipelineDefinition

ENTRYPOINT = "bronze.jdbc_ingest:run"
TASK_MODULE = Path("src") / "bronze" / "jdbc_ingest.py"
TARGET_PATTERN = r"^[a-z_][a-z0-9_]*$"
HEADER = (
    "# Managed by the Ingestion tab: copies tables of a relational database into bronze.\n"
    "# Configure it there: saving the job rewrites this file.\n"
)


class JobTable(BaseModel):
    source: str = Field(min_length=1, description='"schema.table" in the database')
    target: str = Field(pattern=TARGET_PATTERN, description="bronze table name")
    columns: list[str] = Field(default_factory=list, description="[] = every column")
    watermark: str | None = Field(default=None, description="column marking new rows; None = full copy")
    keys: list[str] = Field(default_factory=list,
                            description="columns identifying a row: a row already in bronze is overwritten")


class JobSchedule(BaseModel):
    cron: str
    timezone: str = "UTC"
    enabled: bool = True


class JobSpec(BaseModel):
    name: str | None = None
    schedule: JobSchedule | None = None  # None: runs only when started
    connection: str = Field(min_length=1)
    start_date: str | None = None  # YYYY-MM-DD; None = the system start date, else all rows
    tables: list[JobTable] = Field(min_length=1)

    @field_validator("start_date")
    @classmethod
    def _date(cls, v: str | None) -> str | None:
        if v in (None, ""):
            return None
        date.fromisoformat(v)
        return v

    @field_validator("tables")
    @classmethod
    def _unique_targets(cls, tables: list[JobTable]) -> list[JobTable]:
        seen = set()
        for t in tables:
            if t.target in seen:
                raise ValueError(f"two tables are copied to bronze.{t.target}")
            seen.add(t.target)
            if t.watermark and t.columns and t.watermark not in t.columns:
                raise ValueError(f"{t.source}: the watermark column {t.watermark} must be one of the copied columns")
            missing = [k for k in t.keys if t.columns and k not in t.columns]
            if missing:
                raise ValueError(f"{t.source}: key column {', '.join(missing)} must be copied too")
        return tables


def job_of(definition: PipelineDefinition) -> dict | None:
    """The job a pipeline holds, or None when it isn't an ingestion job."""
    spec = definition.spec
    if spec is None or len(spec.tasks) != 1:
        return None
    task = spec.tasks[0]
    if not isinstance(task, PythonTask) or task.entrypoint != ENTRYPOINT:
        return None
    p = task.parameters
    return {
        "id": definition.id,
        "name": spec.name or definition.id,
        "connection": p.get("connection"),
        "start_date": p.get("start_date"),
        "tables": p.get("tables") or [],
        "schedule": spec.schedule.model_dump() if spec.schedule else None,
    }


def render(job_id: str, job: JobSpec) -> str:
    s = job.schedule
    schedule = (s.cron.strip(), s.timezone.strip() or "UTC", s.enabled) if s else None
    body = {
        "name": job.name or job_id,
        "description": f"Copies {len(job.tables)} table{'s' if len(job.tables) != 1 else ''} "
        f"of the {job.connection} database into bronze (Ingestion tab).",
    # set by "Ingest dates" (POST /api/ingestion/jobs/{id}/runs): only that range, replaced in bronze
    "parameters": {"from_date": None, "to_date": None},
        "tasks": [{
            "key": "ingest",
            "type": "python",
            "entrypoint": ENTRYPOINT,
            "parameters": {
                "connection": job.connection,
                "start_date": job.start_date,
                "tables": [t.model_dump() for t in job.tables],
                "from_date": "${params.from_date}",
                "to_date": "${params.to_date}",
            },
        }],
    }
    text = HEADER + yaml.safe_dump(body, sort_keys=False, default_flow_style=None, width=120)
    return set_schedule(text, schedule) if schedule else text


RANGE_PARAMETERS = ("from_date", "to_date")


def takes_dates(definition: PipelineDefinition) -> bool:
    """The job's pipeline has the from_date / to_date parameters (jobs saved before they existed don't)."""
    spec = definition.spec
    return spec is not None and all(p in spec.parameters for p in RANGE_PARAMETERS)


def spec_of(job: dict) -> JobSpec:
    """A job read back from its pipeline, to render it again."""
    return JobSpec(name=job["name"], connection=job["connection"], start_date=job["start_date"],
                   tables=job["tables"], schedule=job["schedule"])


def task_project(ws: Workspace) -> Path | None:
    """The project whose src/ has the JDBC ingest task (new jobs are saved there)."""
    return next((p for p in ws.projects() if (p / TASK_MODULE).is_file()), None)


def valid_id(job_id: str) -> bool:
    return bool(re.match(PIPELINE_ID_PATTERN, job_id))

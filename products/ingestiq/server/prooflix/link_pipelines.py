"""Pipelines that build the Object Model's computed links.

A computed link is defined in the wizard as Spark SQL that gives pairs of keys (``from_key``,
``to_key``). Publishing its type writes one pipeline per computed link,
``pipelines/object-link-<type>-<link>.yaml``, with a Python task calling the platform task
``prooflix.tasks.link_tables:build`` (Spark SQL into a Delta table, ``<catalog>.gold.link_<type>_<link>``),
on the link's cron schedule. Like an ingestion job, the pipeline is an output of the GUI
(principle 4): it runs, is scheduled and shows its runs like any other, and publishing rewrites it.
Prooflix itself never runs the SQL: Spark does, in the task (principle 1).
"""

from __future__ import annotations

from pathlib import Path

import yaml

from .ontology import Link, ObjectType, file_name
from .pipelines import Workspace
from .pipelines.schedule_yaml import set_schedule
from .tasks import RUNTIME_MODULE, runtime_project

ENTRYPOINT = "prooflix.tasks.link_tables:build"
TASK_MODULE = RUNTIME_MODULE  # the workspace's Spark runtime, which the platform task uses
PREFIX = "object-link-"
HEADER = (
    "# Managed by InsightIQ's Object Model: builds the table of a computed link with Spark.\n"
    "# Change the link in the Object Model wizard: publishing its type rewrites this file.\n"
)


def pipeline_id(api_name: str, link: str) -> str:
    return PREFIX + file_name(api_name).removesuffix(".yaml").replace("_", "-") + "-" + link.replace("_", "-")


def render(t: ObjectType, k: Link) -> str:
    body = {
        "name": f"Object Model link {t.api_name}.{k.api_name}",
        "description": f"Builds {k.table}: the pairs of {t.api_name} → {k.target} keys of the computed link "
        f"{k.api_name} (Object Model).",
        "tasks": [{
            "key": "build",
            "type": "python",
            "entrypoint": ENTRYPOINT,
            "parameters": {"table": k.table, "sql": k.sql},
        }],
    }
    text = HEADER + yaml.safe_dump(body, sort_keys=False, default_flow_style=None, width=120, allow_unicode=True)
    return set_schedule(text, (k.schedule.strip(), "UTC", True)) if k.schedule else text


def task_project(ws: Workspace) -> Path | None:
    """The project whose src/ has the Spark runtime the link task uses (generated pipelines go there)."""
    return runtime_project(ws)


def _ours(ws: Workspace, api_name: str) -> list[str]:
    prefix = PREFIX + file_name(api_name).removesuffix(".yaml").replace("_", "-") + "-"
    return [pid for pid in ws.load_all() if pid.startswith(prefix)]


def sync(ws: Workspace, t: ObjectType) -> dict:
    """Write the pipeline of each computed link of the type and remove those of links it no longer has.
    Returns {"written": [...], "removed": [...], "error": str | None}."""
    wanted = {pipeline_id(t.api_name, k.api_name): k for k in t.links if k.storage == "computed"}
    removed = []
    for pid in _ours(ws, t.api_name):
        if pid not in wanted:
            ws.delete(pid)
            removed.append(pid)
    if not wanted:
        return {"written": [], "removed": removed, "error": None}
    project = task_project(ws)
    if project is None:
        return {"written": [], "removed": removed,
                "error": f"the workspace has no {TASK_MODULE.as_posix()}: computed links need its Spark runtime"}
    written = []
    for pid, k in wanted.items():
        ws.save(pid, render(t, k), project=None if ws.exists(pid) else project)
        written.append(pid)
    return {"written": written, "removed": removed, "error": None}


def remove(ws: Workspace, api_name: str) -> list[str]:
    gone = _ours(ws, api_name)
    for pid in gone:
        ws.delete(pid)
    return gone

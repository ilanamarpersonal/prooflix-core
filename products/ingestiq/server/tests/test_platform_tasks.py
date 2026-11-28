"""Platform tasks (prooflix.tasks): run from pipelines with the workspace's own Spark runtime."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app
from prooflix.tasks import PLATFORM_TASKS, runtime_project

# a stand-in for a workspace's Spark runtime: records what the task did
SPARK = '''
class Frame:
    def __init__(self, columns, rows):
        self.columns, self.rows = columns, rows
    def select(self, *cols):
        return Frame(list(cols), self.rows)
    def where(self, cond):
        return Frame(self.columns, [r for r in self.rows if None not in r])
    def distinct(self):
        return Frame(self.columns, sorted(set(self.rows)))

class Spark:
    def sql(self, text):
        SQL.append(text)
        return Frame(["from_key", "to_key"], [(1, 2), (1, 2), (2, None), (3, 1)])

SQL = []

def get_spark(ctx=None):
    ctx.log("fake Spark from this workspace")
    return Spark()
'''
CATALOG = '''
class Ref:
    def __init__(self, name):
        self.name = name

class Catalog:
    def __init__(self, name):
        self.name = name
    def table(self, schema, table):
        return Ref(f"{self.name}.{schema}.{table}")

def tenant_catalog(ctx, schemas=(), catalog=None):
    return Catalog(catalog or "tenant1")
'''
MATERIALIZATION = '''
WRITTEN = {}

def overwrite(df, ref):
    WRITTEN[ref.name] = df.rows
    return len(df.rows)

def ensure_table(spark, ref, schema):
    return False

def table_exists(spark, ref):
    return ref.name in WRITTEN
'''


def _pipeline(entrypoint: str) -> str:
    return (f"name: links\ntasks:\n- key: build\n  type: python\n  entrypoint: {entrypoint}\n"
            "  parameters:\n    table: tenant1.gold.link_customer_shared\n    sql: SELECT 1 AS from_key, 2 AS to_key\n")


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    for package, files in {"runtime": {"spark_session": SPARK, "catalog": CATALOG},
                           "infra": {"materialization": MATERIALIZATION}}.items():
        (ws / "src" / package).mkdir(parents=True)
        (ws / "src" / package / "__init__.py").write_text("")
        for name, text in files.items():
            (ws / "src" / package / f"{name}.py").write_text(text)
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog")
    with TestClient(create_app(settings)) as c:
        yield c, ws


def _run(c, pipeline: str) -> dict:
    run = c.post(f"/api/pipelines/{pipeline}/runs", json={}).json()
    for _ in range(200):
        run = c.get(f"/api/runs/{run['id']}").json()
        if run["status"] in ("SUCCEEDED", "FAILED"):
            return run
        time.sleep(0.02)
    raise AssertionError("the run didn't finish")


@pytest.mark.parametrize("entrypoint", ["prooflix.tasks.link_tables:build", "gold.link_tables:build"])
def test_a_platform_task_runs_on_the_workspace_runtime(client, entrypoint):
    c, ws = client
    (ws / "pipelines" / "links.yaml").write_text(_pipeline(entrypoint))  # the old name still works
    run = _run(c, "links")
    assert run["status"] == "SUCCEEDED", run
    task = run["tasks"]["build"]
    assert task["output"] == {"table": "tenant1.gold.link_customer_shared", "pairs": 2}  # distinct, both keys
    logs = "\n".join(line["message"] if isinstance(line, dict) else str(line) for line in task.get("logs", []))
    assert "fake Spark from this workspace" in str(run) or "fake Spark from this workspace" in logs
    assert "platform task" in str(run)


def test_only_listed_platform_functions_run(client):
    c, ws = client
    (ws / "pipelines" / "links.yaml").write_text(_pipeline("prooflix.tasks.jdbc:read"))
    assert _run(c, "links")["status"] == "FAILED"
    (ws / "pipelines" / "links.yaml").write_text(_pipeline("prooflix.auth:hash_password"))
    assert _run(c, "links")["status"] == "FAILED"
    assert PLATFORM_TASKS == {"prooflix.tasks.jdbc_ingest:run", "prooflix.tasks.link_tables:build"}


def test_a_workspace_keeps_its_own_copy(client):
    c, ws = client
    (ws / "src" / "gold").mkdir()
    (ws / "src" / "gold" / "__init__.py").write_text("")
    (ws / "src" / "gold" / "link_tables.py").write_text("def build(table, sql, ctx=None):\n    return {'own': True}\n")
    (ws / "pipelines" / "links.yaml").write_text(_pipeline("gold.link_tables:build"))
    assert _run(c, "links")["tasks"]["build"]["output"] == {"own": True}


def test_runtime_project(tmp_path: Path):
    from prooflix.pipelines import Workspace

    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    assert runtime_project(Workspace(ws)) is None
    (ws / "src" / "runtime").mkdir(parents=True)
    (ws / "src" / "runtime" / "spark_session.py").write_text("")
    assert runtime_project(Workspace(ws)) == ws

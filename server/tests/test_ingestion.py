"""Database connections and ingestion jobs (the Ingestion tab)."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.connections import KINDS, MASK, Connection, ConnectionStore, _clean
from prooflix.engine.context import TaskContext
from prooflix.ingestion import ENTRYPOINT
from prooflix.main import create_app


def test_jdbc_urls_per_type():
    oracle = Connection("o", "oracle", "db", 1521, "FREEPDB1", "u", options={"connect_by": "service"})
    assert oracle.jdbc_url == "jdbc:oracle:thin:@//db:1521/FREEPDB1"
    oracle.options = {"connect_by": "sid"}
    assert oracle.jdbc_url == "jdbc:oracle:thin:@db:1521:FREEPDB1"
    mssql = Connection("s", "sqlserver", "db", 1433, "bank", "u", options={"encrypt": True})
    assert mssql.jdbc_url == "jdbc:sqlserver://db:1433;databaseName=bank;encrypt=true;trustServerCertificate=false"
    assert Connection("m", "mysql", "db", 3306, "bank", "u").jdbc_url == "jdbc:mysql://db:3306/bank"
    assert Connection("p", "postgresql", "db", 5432, "bank", "u").jdbc_url == "jdbc:postgresql://db:5432/bank"
    assert {k: v.driver for k, v in KINDS.items()} == {
        "oracle": "oracle.jdbc.OracleDriver",
        "sqlserver": "com.microsoft.sqlserver.jdbc.SQLServerDriver",
        "mysql": "com.mysql.cj.jdbc.Driver",
        "postgresql": "org.postgresql.Driver",
    }


@pytest.mark.parametrize(
    ("kind", "type_", "scale", "ok"),
    [
        ("postgresql", "TIMESTAMP WITHOUT TIME ZONE", None, True),
        ("postgresql", "TEXT", None, False),
        ("mysql", "INT(11) UNSIGNED", 0, True),
        ("mysql", "DATETIME(6)", None, True),
        ("mysql", "DECIMAL(12,2)", 2, False),
        ("sqlserver", "DATETIME2", None, True),
        ("sqlserver", "TIMESTAMP", None, False),  # rowversion
        ("oracle", "NUMBER", 0, True),
        ("oracle", "NUMBER", 2, False),
        ("oracle", "TIMESTAMP(6)", 6, True),
    ],
)
def test_watermark_columns(kind, type_, scale, ok):
    assert KINDS[kind].watermark(type_, scale) is ok


def test_store_keeps_password_private(tmp_path: Path):
    store = ConnectionStore(tmp_path)
    store.save(Connection("bankdb", "oracle", "db", 1521, "XE", "u", "s3cret",
                          {"connect_by": "sid", "encrypt": True}))  # encrypt isn't an Oracle field
    assert stat.S_IMODE((tmp_path / "connections.json").stat().st_mode) == 0o600
    assert store.get("bankdb").options == {"connect_by": "sid"}
    assert store.get("bankdb").public()["password"] == MASK
    store.save(Connection("bankdb", "oracle", "db2", 1521, "XE", "u", MASK, {"connect_by": "sid"}))
    assert store.get("bankdb").password == "s3cret" and store.get("bankdb").host == "db2"
    with pytest.raises(ValueError):
        store.save(Connection("Bad Name", "oracle", "db", 1, "x", "u"))
    assert store.delete("bankdb") and store.get("bankdb") is None


def test_errors_never_show_the_password():
    assert "s3cret" not in _clean(RuntimeError("login failed for password s3cret"), "s3cret")
    assert _clean(Exception({"M": "password authentication failed", "C": "28P01"}), "x") == \
        "password authentication failed"


def test_task_context_connection():
    ctx = TaskContext("r", "r", "p", "t", 1, Path("."), _connections=lambda n: {"name": n} if n == "a" else None)
    assert ctx.connection("a") == {"name": "a"}
    with pytest.raises(KeyError, match="Ingestion tab"):
        ctx.connection("b")


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "src" / "bronze").mkdir(parents=True)
    (ws / "src" / "bronze" / "jdbc_ingest.py").write_text("def run(connection, tables, start_date=None, from_date=None, to_date=None, ctx=None):\n"
                                                         "    return ctx.connection(connection)['jdbc_url']\n")
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog")
    with TestClient(create_app(settings)) as c:
        yield c, ws


JOB = {
    "name": "Bank",
    "connection": "bankdb",
    "start_date": "2024-06-01",
    "schedule": {"cron": "0 2 * * *", "timezone": "UTC", "enabled": True},
    "tables": [{"source": "core.accounts", "target": "bankdb_accounts", "columns": ["id", "updated_at"],
                "watermark": "updated_at"}],
}


def test_connection_and_job_api(client):
    c, ws = client
    kinds = c.get("/api/ingestion/kinds").json()
    assert [k["kind"] for k in kinds] == ["oracle", "sqlserver", "mysql", "postgresql"]
    oracle_fields = [f["key"] for f in kinds[0]["fields"]]
    assert "connect_by" in oracle_fields and "encrypt" not in oracle_fields

    r = c.put("/api/ingestion/connections/bankdb", json={
        "kind": "postgresql", "host": "db", "database": "bank", "user": "u", "password": "pw"})
    assert r.status_code == 200 and r.json()["port"] == 5432 and r.json()["password"] == MASK

    assert c.put("/api/ingestion/jobs/ingest_bank?create_only=true", json={**JOB, "connection": "nope"}).status_code == 422
    r = c.put("/api/ingestion/jobs/ingest_bank?create_only=true", json=JOB)
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["schedule"]["cron"] == "0 2 * * *" and job["schedule"]["next_run"]
    doc = yaml.safe_load((ws / "pipelines" / "ingest_bank.yaml").read_text())
    assert doc["tasks"][0]["entrypoint"] == ENTRYPOINT
    assert doc["tasks"][0]["parameters"]["tables"][0]["watermark"] == "updated_at"
    assert "pw" not in (ws / "pipelines" / "ingest_bank.yaml").read_text()

    # saving again with no schedule removes it; the id can't be created twice
    assert c.put("/api/ingestion/jobs/ingest_bank?create_only=true", json=JOB).status_code == 409
    r = c.put("/api/ingestion/jobs/ingest_bank", json={**JOB, "schedule": None})
    assert r.json()["schedule"] is None
    assert [j["id"] for j in c.get("/api/ingestion/jobs").json()["jobs"]] == ["ingest_bank"]

    # the connection is in use
    assert c.delete("/api/ingestion/connections/bankdb").status_code == 409

    # a run hands the task the connection through ctx.connection
    run = c.post("/api/pipelines/ingest_bank/runs", json={}).json()
    for _ in range(100):
        run = c.get(f"/api/runs/{run['id']}").json()
        if run["status"] in ("SUCCEEDED", "FAILED"):
            break
        import time
        time.sleep(0.05)
    assert run["status"] == "SUCCEEDED", run
    assert json.dumps(run).count("jdbc:postgresql://db:5432/bank") >= 1

    assert c.delete("/api/ingestion/jobs/ingest_bank").status_code == 204
    assert c.delete("/api/ingestion/connections/bankdb").status_code == 204


def test_watermark_must_be_copied(client):
    c, _ = client
    c.put("/api/ingestion/connections/bankdb", json={"kind": "mysql", "host": "db", "database": "b", "user": "u"})
    bad = {**JOB, "tables": [{**JOB["tables"][0], "columns": ["id"]}]}
    assert c.put("/api/ingestion/jobs/ingest_bank", json=bad).status_code == 422


def test_jobs_take_keys_and_a_date_range(client):
    c, ws = client
    c.put("/api/ingestion/connections/bankdb", json={"kind": "mysql", "host": "db", "database": "b", "user": "u"})
    job = {**JOB, "tables": [{**JOB["tables"][0], "keys": ["id"]}]}
    assert c.put("/api/ingestion/jobs/ingest_bank", json=job).status_code == 201
    doc = yaml.safe_load((ws / "pipelines" / "ingest_bank.yaml").read_text())
    assert doc["parameters"] == {"from_date": None, "to_date": None}
    params = doc["tasks"][0]["parameters"]
    assert params["tables"][0]["keys"] == ["id"]
    assert params["from_date"] == "${params.from_date}"
    # a key that isn't copied is refused
    bad = {**JOB, "tables": [{**JOB["tables"][0], "keys": ["name"]}]}
    assert c.put("/api/ingestion/jobs/ingest_bank", json=bad).status_code == 422

    B = "/api/ingestion/jobs/ingest_bank/runs"
    assert c.post(B, json={"from_date": "2024-05-01", "to_date": "2024-04-01"}).status_code == 422
    assert c.post(B, json={"from_date": "May 1"}).status_code == 422
    assert c.post("/api/ingestion/jobs/nope/runs", json={"from_date": "2024-01-01"}).status_code == 404
    r = c.post(B, json={"from_date": "2024-04-01", "to_date": "2024-04-30"})
    assert r.status_code == 202, r.text
    assert r.json()["parameters"] == {"from_date": "2024-04-01", "to_date": "2024-04-30"}


def test_old_jobs_get_the_date_parameters(client):
    """A job saved before date ranges existed is written again with them when run for dates."""
    c, ws = client
    c.put("/api/ingestion/connections/bankdb", json={"kind": "mysql", "host": "db", "database": "b", "user": "u"})
    (ws / "pipelines" / "old_job.yaml").write_text(
        "name: old_job\ntasks:\n- key: ingest\n  type: python\n  entrypoint: bronze.jdbc_ingest:run\n"
        "  parameters:\n    connection: bankdb\n    start_date: null\n    tables:\n"
        "    - {source: core.t, target: t, columns: [], watermark: ts}\n"
    )
    r = c.post("/api/ingestion/jobs/old_job/runs", json={"to_date": "2024-01-31"})
    assert r.status_code == 202, r.text
    doc = yaml.safe_load((ws / "pipelines" / "old_job.yaml").read_text())
    assert "from_date" in doc["parameters"] and doc["tasks"][0]["parameters"]["tables"][0]["watermark"] == "ts"

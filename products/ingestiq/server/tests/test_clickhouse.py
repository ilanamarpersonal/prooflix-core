import datetime as dt
import json
import os
import urllib.request

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix.clickhouse import ClickHouse, ClickHouseError, clickhouse_type
from prooflix.config import Settings
from prooflix.main import create_app

CH_URL = os.environ.get("PROOFLIX_TEST_CLICKHOUSE_URL", "http://localhost:8123")
CH_USER = os.environ.get("PROOFLIX_TEST_CLICKHOUSE_USER", "prooflix")
CH_PASSWORD = os.environ.get("PROOFLIX_TEST_CLICKHOUSE_PASSWORD", "prooflix-dev")
DB = "prooflix_test_ch"


def test_type_mapping():
    assert clickhouse_type(pa.int64()) == "Nullable(Int64)"
    assert clickhouse_type(pa.int32()) == "Nullable(Int32)"
    assert clickhouse_type(pa.float64()) == "Nullable(Float64)"
    assert clickhouse_type(pa.string()) == "Nullable(String)"
    assert clickhouse_type(pa.bool_()) == "Nullable(Bool)"
    assert clickhouse_type(pa.date32()) == "Nullable(Date32)"
    assert clickhouse_type(pa.decimal128(12, 2)) == "Nullable(Decimal(12, 2))"
    assert clickhouse_type(pa.timestamp("us", tz="UTC")) == "Nullable(DateTime64(6, 'UTC'))"
    assert clickhouse_type(pa.timestamp("ms")) == "Nullable(DateTime64(3))"
    with pytest.raises(ClickHouseError):
        clickhouse_type(pa.list_(pa.int64()))


def _clickhouse_up() -> bool:
    try:
        return urllib.request.urlopen(CH_URL + "/ping", timeout=2).read().strip() == b"Ok."
    except OSError:
        return False


def _delta_table(folder, rows):
    log = folder / "_delta_log"
    log.mkdir(parents=True)
    pq.write_table(pa.table({
        "day": pa.array([r[0] for r in rows], pa.date32()),
        "at": pa.array([r[1] for r in rows], pa.timestamp("us", tz="UTC")),
        "label": pa.array([r[2] for r in rows], pa.string()),
        "count": pa.array([r[3] for r in rows], pa.int64()),
        "amount": pa.array([r[4] for r in rows], pa.float64()),
    }), folder / "part-0.parquet")
    (log / f"{0:020d}.json").write_text("\n".join(json.dumps(a) for a in [
        {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}},
        {"metaData": {"id": "x", "configuration": {}}},
        {"add": {"path": "part-0.parquet", "size": 1, "dataChange": True,
                 "stats": json.dumps({"numRecords": len(rows)})}},
    ]) + "\n")


@pytest.mark.skipif(not _clickhouse_up(), reason=f"no ClickHouse at {CH_URL}")
def test_import_gold_table_into_clickhouse(sample_workspace, tmp_path):
    ch = ClickHouse(CH_URL, CH_USER, CH_PASSWORD)
    ch.execute(f"DROP DATABASE IF EXISTS {DB}")
    utc = dt.timezone.utc
    rows = [(dt.date(2026, 1, 1), dt.datetime(2026, 1, 1, 8, 30, tzinfo=utc), "a", 3, 1.5),
            (dt.date(2026, 1, 2), dt.datetime(2026, 1, 2, 9, 0, tzinfo=utc), None, 5, 2.25)]
    _delta_table(sample_workspace / "data" / DB / "lakehouse" / "gold" / "daily", rows)
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client", scheduler=False,
                        clickhouse_url=CH_URL, clickhouse_user=CH_USER, clickhouse_password=CH_PASSWORD)
    try:
        with TestClient(create_app(settings)) as c:
            gold = {g["table"]: g for g in c.get("/api/clickhouse/gold-tables").json()}
            g = gold[f"{DB}.gold.daily"]
            assert g["target"] == f"{DB}.daily" and g["rows"] == 2
            assert [(col["name"], col["clickhouse_type"]) for col in g["columns"]] == [
                ("day", "Nullable(Date32)"), ("at", "Nullable(DateTime64(6, 'UTC'))"),
                ("label", "Nullable(String)"), ("count", "Nullable(Int64)"), ("amount", "Nullable(Float64)")]

            res = c.post("/api/clickhouse/import", json={"tables": [f"{DB}.gold.daily", "nope.gold.x"]}).json()
            assert res[0]["ok"] and res[0]["rows"] == 2 and res[0]["replaced"] is False, res[0]
            assert not res[1]["ok"] and res[1]["error"] == "not a gold table"
            described = ch.rows(f"DESCRIBE TABLE {DB}.daily")
            assert [(d["name"], d["type"]) for d in described] == [(col["name"], col["clickhouse_type"]) for col in g["columns"]]
            data = ch.rows(f"SELECT toString(day) AS day, toString(at) AS at, label, count, amount FROM {DB}.daily ORDER BY day")
            assert data == [
                {"day": "2026-01-01", "at": "2026-01-01 08:30:00.000000", "label": "a", "count": 3, "amount": 1.5},
                {"day": "2026-01-02", "at": "2026-01-02 09:00:00.000000", "label": None, "count": 5, "amount": 2.25},
            ]
            # importing again replaces the table as a whole
            again = c.post("/api/clickhouse/import", json={"tables": [f"{DB}.gold.daily"]}).json()[0]
            assert again["ok"] and again["rows"] == 2 and again["replaced"] is True
            status = c.get("/api/clickhouse/status").json()
            assert status["reachable"] and {"database": DB, "name": "daily"}.items() <= next(
                t for t in status["tables"] if t["database"] == DB).items()
            assert not any(t["name"].endswith("__prooflix_new") for t in status["tables"])
    finally:
        ch.execute(f"DROP DATABASE IF EXISTS {DB}")


def test_status_without_clickhouse(sample_workspace, tmp_path):
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client", scheduler=False)
    with TestClient(create_app(settings)) as c:
        s = c.get("/api/clickhouse/status").json()
        assert s["configured"] is False and s["tables"] == []
        assert c.post("/api/clickhouse/import", json={"tables": ["x"]}).status_code == 409

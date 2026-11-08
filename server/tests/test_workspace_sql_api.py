import json

import pytest
from fastapi.testclient import TestClient

from prooflix.api.sql import table_name
from prooflix.config import Settings
from prooflix.main import create_app


@pytest.fixture
def client(sample_workspace, tmp_path):
    out = sample_workspace / "data" / "output" / "2026-01-01"
    out.mkdir(parents=True)
    (out / "clean_orders.json").write_text(
        json.dumps([{"order_id": 1, "amount": 10.5, "tags": ["a"]}, {"order_id": 2, "amount": 4}])
    )
    (out / "summary.json").write_text(json.dumps({"total": 14.5, "by_country": {"IL": 14.5}}))
    (sample_workspace / ".prooflix").mkdir(exist_ok=True)
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client")
    with TestClient(create_app(settings)) as c:
        yield c


# ---------------------------------------------------------------- workspace
def test_tree_lists_workspace_without_hidden_folders(client):
    tree = client.get("/api/workspace/tree").json()
    assert tree["type"] == "dir"
    top = [c["name"] for c in tree["children"]]
    assert {"data", "pipelines", "src"} <= set(top)
    assert ".prooflix" not in top
    assert top.index("data") < top.index("pipelines")  # folders sorted by name


def test_read_file(client):
    res = client.get("/api/workspace/file", params={"path": "pipelines/hello_world.yaml"})
    assert res.status_code == 200
    body = res.json()
    assert body["content"] and not body["binary"] and not body["truncated"]


@pytest.mark.parametrize("path", ["../outside.txt", "/etc/passwd", ".prooflix", "missing.txt"])
def test_read_file_refuses_paths_outside_or_hidden(client, path):
    assert client.get("/api/workspace/file", params={"path": path}).status_code in (400, 404)


# ---------------------------------------------------------------- sql
def test_table_name():
    from pathlib import Path

    assert table_name(Path("orders.csv")) == "orders"
    assert table_name(Path("output/2026-11-07/clean_orders.json")) == "output_2026_11_07_clean_orders"
    assert table_name(Path("2026.csv")) == "t_2026"


def test_tables_lists_csv_and_json_files(client):
    tables = {t["name"]: t for t in client.get("/api/sql/tables").json()}
    assert tables["orders"]["source"] == "data/orders.csv"
    assert tables["orders"]["row_count"] > 0
    clean = tables["output_2026_01_01_clean_orders"]
    assert [c["name"] for c in clean["columns"]] == ["order_id", "amount", "tags"]
    assert tables["output_2026_01_01_summary"]["row_count"] == 1


def test_query_returns_rows_with_numbers(client):
    res = client.post(
        "/api/sql/query",
        json={"sql": "SELECT order_id, amount FROM output_2026_01_01_clean_orders ORDER BY order_id"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["columns"] == ["order_id", "amount"]
    assert body["rows"] == [[1, 10.5], [2, 4]]
    assert body["truncated"] is False


def test_query_limit_truncates(client):
    body = client.post("/api/sql/query", json={"sql": "SELECT * FROM orders", "limit": 2}).json()
    assert body["row_count"] == 2 and body["truncated"] is True


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM orders",
        "CREATE TABLE x (a)",
        "ATTACH DATABASE 'evil.db' AS evil",
        "SELECT * FROM nope",
        "SELECT 1; SELECT 2",
    ],
)
def test_query_rejects_writes_and_bad_sql(client, sql, sample_workspace):
    res = client.post("/api/sql/query", json={"sql": sql})
    assert res.status_code == 400
    assert res.json()["detail"]
    assert not (sample_workspace / "evil.db").exists()

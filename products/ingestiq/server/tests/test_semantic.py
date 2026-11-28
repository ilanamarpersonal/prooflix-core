"""The semantic model: validation, the YAML file, the SQL it writes, and the API."""

from __future__ import annotations

import os
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import semantic
from prooflix.config import Settings
from prooflix.main import create_app
from prooflix.semantic import SemanticModel, compile_query

MODEL = {
    "name": "Shop",
    "entities": [
        {"name": "orders", "table": "orders", "primary_key": "order_id",
         "dimensions": [{"name": "status", "column": "status"}],
         "measures": [{"name": "revenue", "agg": "sum", "column": "amount"}, {"name": "count", "agg": "count"}],
         "joins": [{"entity": "customers", "column": "customer_id", "to_column": "customer_id"}]},
        {"name": "customers", "table": "customers", "dimensions": [{"name": "country", "column": "country"}]},
    ],
    "metrics": [{"name": "avg_order", "sql": "{orders.revenue} / NULLIF({orders.count}, 0)"}],
}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda m: m["entities"].append(dict(m["entities"][1])), "two entities"),
        (lambda m: m["entities"][0]["joins"].append({"entity": "nope", "column": "a", "to_column": "b"}), "isn't an entity"),
        (lambda m: m["metrics"].append({"name": "x", "sql": "{orders.nope}"}), "isn't a measure"),
        (lambda m: m["entities"][0].update(table="orders; DROP"), "catalog table"),
        (lambda m: m["entities"][0]["dimensions"].append({"name": "status", "column": "x"}), "twice"),
    ],
)
def test_invalid_models(change, message):
    import copy

    data = copy.deepcopy(MODEL)
    change(data)
    with pytest.raises(ValueError, match=message):
        SemanticModel.model_validate(data)


def test_compile_follows_joins_and_metrics():
    sql = compile_query(SemanticModel.model_validate(MODEL), ["orders.revenue", "avg_order"], ["customers.country"], 10)
    assert 'LEFT JOIN "customers" AS "customers" ON "orders"."customer_id" = "customers"."customer_id"' in sql
    assert '(SUM("orders"."amount")) / NULLIF((COUNT(*)), 0) AS "avg_order"' in sql
    assert "GROUP BY 1" in sql and sql.endswith("LIMIT 10")
    with pytest.raises(ValueError):
        compile_query(SemanticModel.model_validate(MODEL), [], [])


def test_file_round_trip_and_conflicts(tmp_path: Path):
    model = SemanticModel.model_validate(MODEL)
    assert semantic.load(tmp_path) == (SemanticModel(), None)
    mtime = semantic.save(tmp_path, model, None)
    text = (tmp_path / "semantic" / "model.yaml").read_text()
    assert text.startswith("# Semantic model") and "name: Shop" in text
    loaded, m2 = semantic.load(tmp_path)
    assert loaded == model and m2 == mtime
    with pytest.raises(FileExistsError):
        semantic.save(tmp_path, model, None)  # a model exists: must say which version it edits
    os.utime(tmp_path / "semantic" / "model.yaml", (mtime + 5, mtime + 5))
    with pytest.raises(FileExistsError):
        semantic.save(tmp_path, model, mtime)  # changed since


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "data").mkdir()
    pq.write_table(pa.table({"order_id": [1, 2, 3], "customer_id": [1, 1, 2], "status": ["paid", "paid", "open"],
                             "amount": [10.0, 30.0, 5.0]}), ws / "data" / "orders.parquet")
    pq.write_table(pa.table({"customer_id": [1, 2], "country": ["IL", "US"]}), ws / "data" / "customers.parquet")
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog")
    with TestClient(create_app(settings)) as c:
        yield c, ws


def test_api(client):
    c, ws = client
    r = c.get("/api/semantic").json()
    assert r["exists"] is False and r["path"] == "semantic/model.yaml"
    tables = {t["table"]: [col["name"] for col in t["columns"]] for t in c.get("/api/semantic/tables").json()}
    assert tables["orders"] == ["order_id", "customer_id", "status", "amount"]

    assert c.post("/api/semantic/check", json={"model": MODEL}).json() == {"ok": True, "problems": []}
    bad = {**MODEL, "entities": [{**MODEL["entities"][0], "dimensions": [{"name": "x", "column": "nope"}]},
                                 MODEL["entities"][1]]}
    problems = c.post("/api/semantic/check", json={"model": bad}).json()["problems"]
    assert [p["where"] for p in problems] == ["orders.x"]

    out = c.post("/api/semantic/query", json={"model": MODEL, "measures": ["orders.revenue", "avg_order"],
                                              "dimensions": ["customers.country"]}).json()
    assert out["result"]["rows"] == [["IL", 40.0, 20.0], ["US", 5.0, 5.0]]

    saved = c.put("/api/semantic", json={"model": MODEL, "modified": None})
    assert saved.status_code == 200 and (ws / "semantic" / "model.yaml").is_file()
    assert c.put("/api/semantic", json={"model": MODEL, "modified": None}).status_code == 409
    again = c.put("/api/semantic", json={"model": {**MODEL, "name": "Shop 2"}, "modified": saved.json()["modified"]})
    assert again.status_code == 200 and c.get("/api/semantic").json()["model"]["name"] == "Shop 2"
    # the saved model is used when no draft is sent
    assert c.post("/api/semantic/query", json={"measures": ["orders.count"]}).json()["result"]["rows"] == [[3]]
    assert c.put("/api/semantic", json={"model": {"entities": [{"name": "Bad Name", "table": "t"}]}}).status_code == 422


def test_edit_the_yaml_by_hand(client):
    c, ws = client
    start = c.get("/api/semantic/yaml").json()
    assert start["modified"] is None and "entities: []" in start["text"]
    text = "# my notes stay\nname: Hand made\nentities:\n  - name: orders\n    table: orders\n    measures:\n      - {name: count, agg: count}\n"
    assert c.post("/api/semantic/yaml/validate", json={"text": text}).json()["ok"] is True
    bad = c.post("/api/semantic/yaml/validate", json={"text": "name: [unclosed"}).json()
    assert bad["ok"] is False and "line 1" in bad["error"]
    assert c.put("/api/semantic/yaml", json={"text": "entities: [{name: X}]"}).status_code == 422
    r = c.put("/api/semantic/yaml", json={"text": text, "modified": None})
    assert r.status_code == 200 and r.json()["model"]["name"] == "Hand made"
    assert (ws / "semantic" / "model.yaml").read_text().startswith("# my notes stay")  # written as typed
    assert c.put("/api/semantic/yaml", json={"text": text, "modified": None}).status_code == 409
    again = c.get("/api/semantic/yaml").json()
    assert c.put("/api/semantic/yaml", json={"text": text.replace("Hand made", "Two"),
                                             "modified": again["modified"]}).status_code == 200
    assert c.get("/api/semantic").json()["model"]["name"] == "Two"

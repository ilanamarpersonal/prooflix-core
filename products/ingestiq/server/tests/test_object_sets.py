"""Phase D: links stored in tables, computed links (generated pipelines), object sets and exports."""

from __future__ import annotations

import copy
import csv
import io
import os
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import object_sets, ontology
from prooflix.config import Settings
from prooflix.main import create_app

GOOD = "Correct-horse-9"
CUSTOMER = {
    "api_name": "Customer",
    "source": {"table": "tenant1.silver.customers"},
    "primary_key": "customer_id",
    "title": "full_name",
    "properties": [
        {"api_name": "customer_id", "column": "customer_id"},
        {"api_name": "full_name", "column": "full_name", "searchable": True},
        {"api_name": "city", "column": "city"},
        {"api_name": "email", "column": "email", "sensitive": True},
    ],
    "links": [{"api_name": "accounts", "target": "Account", "cardinality": "one-to-many", "reverse": "owner",
               "from_property": "customer_id", "to_property": "owner_id"}],
}
ACCOUNT = {
    "api_name": "Account",
    "source": {"table": "tenant1.silver.accounts"},
    "primary_key": "account_id",
    "title": "account_id",
    "properties": [
        {"api_name": "account_id", "column": "account_id"},
        {"api_name": "owner_id", "column": "owner_ref"},
        {"api_name": "status", "column": "status"},
        {"api_name": "balance", "column": "balance"},
    ],
    "actions": [{"api_name": "freeze", "parameters": [{"property": "status"}], "allowed": ["role:user"],
                 "require_reason": False}],
}
# a link stored in a table: customers who share a device (many to many)
SHARED = {"api_name": "shares_device", "target": "Customer", "cardinality": "many-to-many", "storage": "table",
          "table": "tenant1.gold.shared_device", "from_property": "customer_id", "to_property": "customer_id",
          "reverse": "shared_with"}
def _write(folder: Path, table: pa.Table) -> None:
    folder.mkdir(parents=True)
    pq.write_table(table, folder / "part-0.parquet")


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "src" / "runtime").mkdir(parents=True)
    (ws / "src" / "runtime" / "spark_session.py").write_text("def get_spark(ctx=None):\n    return None\n")
    data = ws / "data" / "tenant1"
    _write(data / "silver" / "customers", pa.table({
        "customer_id": [1, 2, 3], "full_name": ["Dana Cohen", "Avi Levi", "Noa Bar"],
        "city": ["Haifa", "Haifa", "Eilat"], "email": ["d@x.io", "a@x.io", "n@x.io"]}))
    _write(data / "silver" / "accounts", pa.table({
        "account_id": ["A1", "A2", "A3", "A4"], "owner_ref": [1, 1, 2, 3], "status": ["active"] * 4,
        "balance": [100.0, 25000.0, 50.0, 90000.0]}))
    _write(data / "gold" / "shared_device", pa.table({"from_key": [1, 2], "to_key": [2, 3]}))
    return ws


@pytest.fixture
def client(tmp_path: Path, ws: Path):
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog",
                        auth=True, database_url=f"sqlite:///{tmp_path / 'db.sqlite'}")
    with TestClient(create_app(settings)) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        for name, tabs in (("dana", ["objects"]), ("olga", ["ontology"])):
            c.post("/api/users", json={"username": name, "password": GOOD, "tabs": tabs})
        assert c.post("/api/ontology/publish", json={"type": ACCOUNT}).status_code == 200
        customer = copy.deepcopy(CUSTOMER)
        customer["links"].append(SHARED)
        assert c.post("/api/ontology/publish", json={"type": customer}).status_code == 200
        yield c


def _login(c: TestClient, name: str) -> None:
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json={"username": name, "password": GOOD}).status_code == 200


def test_link_rules():
    bad = copy.deepcopy(CUSTOMER)
    bad["links"][0]["cardinality"] = "many-to-many"
    with pytest.raises(ValueError, match="needs a link table"):
        ontology.parse(bad)
    computed = copy.deepcopy(CUSTOMER)
    computed["links"].append({"api_name": "shared", "target": "Customer", "storage": "computed",
                              "cardinality": "many-to-many", "from_property": "customer_id",
                              "to_property": "customer_id", "sql": "SELECT 1 AS from_key, 2 AS to_key"})
    t = ontology.parse(computed)
    assert t.links[1].table == "tenant1.gold.link_customer_shared"
    computed["links"][1]["sql"] = "SELECT 1; DROP TABLE x"
    with pytest.raises(ValueError, match="one SELECT"):
        ontology.parse(computed)


def test_links_through_a_table(client):
    c = client
    checks = {x["name"]: x["status"] for x in c.post("/api/ontology/check", json={
        "type": CUSTOMER | {"links": [SHARED]}, "steps": ["links"]}).json()["checks"]}
    assert checks["Link shares_device → Customer: match rate"] == "ok"
    page = c.get("/api/ontology/objects/Customer/2").json()
    links = {k["name"]: k["count"] for k in page["links"]}
    assert links["shares_device"] == 1 and links["shared_with"] == 1  # 2 → 3, and 1 → 2 seen from 2
    shared = c.get("/api/ontology/objects/Customer/2/links/shares_device").json()["objects"]
    assert [o["title"] for o in shared] == ["Noa Bar"]
    back = c.get("/api/ontology/objects/Customer/2/links/shared_with").json()["objects"]
    assert [o["title"] for o in back] == ["Dana Cohen"]


def test_computed_links_generate_pipelines(client, ws):
    c = client
    computed = copy.deepcopy(CUSTOMER)
    computed["links"].append({"api_name": "same_city", "target": "Customer", "storage": "computed",
                              "cardinality": "many-to-many", "from_property": "customer_id",
                              "to_property": "customer_id", "schedule": "0 3 * * *",
                              "sql": "SELECT a.customer_id AS from_key, b.customer_id AS to_key FROM "
                                     "tenant1.silver.customers a JOIN tenant1.silver.customers b "
                                     "ON a.city = b.city AND a.customer_id <> b.customer_id"})
    modified = c.get("/api/ontology/types/Customer").json()["modified"]
    checks = {x["name"]: x for x in c.post("/api/ontology/check", json={"type": computed, "steps": ["links"]}).json()["checks"]}
    assert checks["Link same_city → Customer: the SQL"]["status"] == "ok"
    assert checks["Link same_city → Customer: link table"]["status"] == "info"  # built after publishing

    _login(c, "olga")  # not an admin: computed SQL runs on Spark
    assert c.post("/api/ontology/publish", json={"type": computed, "modified": modified}).status_code == 403
    _login(c, "boss")
    r = c.post("/api/ontology/publish", json={"type": computed, "modified": modified}).json()
    assert r["pipelines"]["written"] == ["object-link-customer-same-city"] and r["pipelines"]["error"] is None
    text = (ws / "pipelines" / "object-link-customer-same-city.yaml").read_text()
    assert "prooflix.tasks.link_tables:build" in text and "tenant1.gold.link_customer_same_city" in text and "0 3 * * *" in text
    pipelines = [p["id"] for p in c.get("/api/pipelines").json()]
    assert "object-link-customer-same-city" in pipelines
    # the link table doesn't exist yet: the object page says so
    page = c.get("/api/ontology/objects/Customer/1").json()
    assert next(k for k in page["links"] if k["name"] == "same_city")["error"].endswith("isn't built yet")
    # the link removed: its pipeline goes too
    modified = c.get("/api/ontology/types/Customer").json()["modified"]
    r = c.post("/api/ontology/publish", json={"type": CUSTOMER | {"links": CUSTOMER["links"] + [SHARED]},
                                              "modified": modified}).json()
    assert r["pipelines"]["removed"] == ["object-link-customer-same-city"]
    assert not (ws / "pipelines" / "object-link-customer-same-city.yaml").exists()


def test_object_sets_run_with_counts_and_access(client):
    c = client
    s = {"type": "Customer", "filters": [{"property": "city", "op": "eq", "value": "Haifa"}],
         "steps": [{"link": "accounts", "filters": [{"property": "balance", "op": "gt", "value": 1000}]}]}
    r = c.post("/api/ontology/sets/run", json={"set": s}).json()
    assert [(x["type"], x["count"]) for x in r["steps"]] == [("Customer", 2), ("Account", 1)]
    assert [o["pk"] for o in r["objects"]] == ["A2"]
    around = {"type": "Customer", "filters": [{"property": "full_name", "op": "contains", "value": "avi"}],
              "steps": [{"link": "shares_device"}]}
    assert [o["title"] for o in c.post("/api/ontology/sets/run", json={"set": around}).json()["objects"]] == ["Noa Bar"]
    assert c.post("/api/ontology/sets/run", json={"set": {"type": "Customer", "steps": [{"link": "nope"}]}}).status_code == 422
    assert c.post("/api/ontology/sets/run", json={"set": {"type": "Customer", "steps": [{"link": "accounts"}] * 5}}).status_code == 422

    _login(c, "dana")  # no sensitive access: can't filter on email
    by_email = {"type": "Customer", "filters": [{"property": "email", "op": "eq", "value": "d@x.io"}]}
    assert c.post("/api/ontology/sets/run", json={"set": by_email}).status_code == 422
    masked = c.post("/api/ontology/sets/run", json={"set": {"type": "Customer"}}).json()["objects"]
    assert {o["properties"]["email"] for o in masked} == {ontology.MASK}


def test_saved_sets_are_private_or_shared(client):
    c = client
    _login(c, "dana")
    mine = c.post("/api/ontology/sets", json={"name": "Haifa", "set": {"type": "Customer"}}).json()
    shared = c.post("/api/ontology/sets", json={"name": "All accounts", "shared": True, "set": {"type": "Account"}}).json()
    assert {x["name"] for x in c.get("/api/ontology/sets").json()["sets"]} == {"Haifa", "All accounts"}
    _login(c, "olga")
    assert [x["name"] for x in c.get("/api/ontology/sets").json()["sets"]] == ["All accounts"]
    assert c.put(f"/api/ontology/sets/{shared['id']}", json={"name": "x", "set": {"type": "Account"}}).status_code == 403
    assert c.delete(f"/api/ontology/sets/{mine['id']}").status_code == 404  # private: not even seen
    _login(c, "boss")
    assert c.put(f"/api/ontology/sets/{shared['id']}", json={"name": "Accounts", "shared": True,
                                                             "set": {"type": "Account"}}).json()["name"] == "Accounts"
    assert c.delete(f"/api/ontology/sets/{mine['id']}").status_code == 204


def _wait_export(c, export_id):
    for _ in range(200):
        e = next(x for x in c.get("/api/ontology/exports").json() if x["id"] == export_id)
        if e["state"] in ("done", "failed"):
            return e
        time.sleep(0.02)
    raise AssertionError("the export didn't finish")


def test_exports_mask_overlay_edits_and_expire(client, tmp_path: Path):
    c = client
    _login(c, "dana")
    c.post("/api/ontology/objects/Account/A1/actions/freeze", json={"values": {"status": "frozen"}})
    e = c.post("/api/ontology/exports", json={"set": {"type": "Account"}, "format": "csv", "name": "accounts"}).json()
    done = _wait_export(c, e["id"])
    assert done["state"] == "done" and done["rows"] == 4 and done["total"] == 4
    r = c.get(f"/api/ontology/exports/{e['id']}/file")
    assert r.status_code == 200 and "accounts.csv" in r.headers["content-disposition"]
    rows = {row["account_id"]: row for row in csv.DictReader(io.StringIO(r.text))}
    assert rows["A1"]["status"] == "frozen" and rows["A2"]["status"] == "active"  # the edit is in the export

    p = c.post("/api/ontology/exports", json={"set": {"type": "Customer"}, "format": "parquet"}).json()
    assert _wait_export(c, p["id"])["state"] == "done"
    data = pq.read_table(io.BytesIO(c.get(f"/api/ontology/exports/{p['id']}/file").content))
    assert set(data.column("email").to_pylist()) == {ontology.MASK}  # dana doesn't see emails

    _login(c, "olga")
    assert c.get(f"/api/ontology/exports/{e['id']}/file").status_code == 404  # someone else's
    _login(c, "boss")
    events = [x["event"] for x in c.get("/api/ontology/audit").json()]
    assert events.count("export") == 2
    folder = tmp_path / "home" / "exports"
    old = time.time() - 25 * 3600
    for f in folder.iterdir():
        os.utime(f, (old, old))
    assert c.get("/api/ontology/exports").json() == [] and not list(folder.iterdir())


def test_compile_gives_one_select_per_step():
    visible = {"Customer": ontology.parse(CUSTOMER | {"links": CUSTOMER["links"] + [SHARED]}),
               "Account": ontology.parse(ACCOUNT)}
    stages = object_sets.compile(object_sets.ObjectSet.model_validate(
        {"type": "Customer", "steps": [{"link": "shares_device"}, {"link": "accounts"}]}), visible, None)
    assert [s["type"] for s in stages] == ["Customer", "Customer", "Account"]
    assert '"tenant1"."gold"."shared_device"' in stages[1]["sql"]

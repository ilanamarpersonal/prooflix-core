"""The ontology: definitions, object views over any layer, the wizard's checks, and the API."""

from __future__ import annotations

import copy
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import ontology
from prooflix.config import Settings
from prooflix.main import create_app

CUSTOMER = {
    "api_name": "Customer",
    "plural": "Customers",
    "source": {"table": "tenant1.bronze.customers", "rows": {"filter": "_op <> 'D'", "latest_by": "_ingested_at"}},
    "primary_key": "customer_id",
    "title": "full_name",
    "properties": [
        {"api_name": "customer_id", "column": "cst_id", "description": "The key"},
        {"api_name": "full_name", "column": "full_nm", "searchable": True, "description": "Name"},
        {"api_name": "balance", "column": "bal_amt", "type": "decimal", "description": "Balance"},
        {"api_name": "national_id", "column": "id_number", "sensitive": True, "description": "ID"},
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
        {"api_name": "account_id", "column": "account_id", "searchable": True, "description": "Number"},
        {"api_name": "owner_id", "column": "owner_ref", "description": "Owner"},
        {"api_name": "kind", "column": "kind", "description": "Type"},
    ],
}


def _write(folder: Path, table: pa.Table) -> None:
    folder.mkdir(parents=True)
    pq.write_table(table, folder / "part-0.parquet")


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    data = ws / "data" / "tenant1"
    # bronze: every change appended, a deleted customer, text balances
    _write(data / "bronze" / "customers", pa.table({
        "cst_id": ["1", "1", "2", "3"],
        "full_nm": ["Dana Coen", "Dana Cohen", "Avi Levi", "Noa Bar"],
        "bal_amt": ["10.5", "18240.50", "oops", "7"],
        "id_number": ["011", "011", "022", "033"],
        "_op": ["I", "U", "I", "D"],
        "_ingested_at": [1, 2, 1, 1],
    }))
    _write(data / "silver" / "accounts", pa.table({
        "account_id": ["A1", "A2", "A3", "A4"], "owner_ref": ["1", "1", "2", "9"],
        "kind": ["checking", "savings", "checking", "credit"],
    }))
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog")
    with TestClient(create_app(settings)) as c:
        yield c, ws


def test_definition_rules():
    t = ontology.parse(CUSTOMER)
    assert t.source.layer == "bronze" and ontology.parse(ACCOUNT).source.layer == "silver"
    assert ontology.layer_of("orders") == "unclassified"
    for change, message in [
        (lambda d: d.update(primary_key="nope"), "primary key"),
        (lambda d: d["properties"].append(dict(d["properties"][0])), "twice"),
        (lambda d: d["source"]["rows"].update(filter="1=1; DROP TABLE x"), "one expression"),
        (lambda d: d["source"]["rows"].update(filter="cst_id IN (SELECT 1)"), "one expression"),
        (lambda d: d["source"].update(table="a.b; x"), "catalog table"),
        (lambda d: d.update(api_name="customer"), "api_name"),
        (lambda d: d["links"][0].update(from_property="nope"), "isn't one of the properties"),
    ]:
        data = copy.deepcopy(CUSTOMER)
        change(data)
        with pytest.raises(ValueError, match=message):
            ontology.parse(data)


def test_object_view_applies_row_rules_and_casts():
    sql = ontology.object_view(ontology.parse(CUSTOMER))
    assert "WHERE (_op <> 'D')" in sql
    assert 'PARTITION BY "cst_id" ORDER BY "_ingested_at" DESC NULLS LAST' in sql
    assert 'TRY_CAST("bal_amt" AS DECIMAL(18,4)) AS "balance"' in sql


def test_files_drafts_and_conflicts(tmp_path: Path):
    t = ontology.parse(CUSTOMER)
    m = ontology.save(tmp_path, t, None, draft=True)
    assert (tmp_path / "ontology" / ".drafts" / "customer.yaml").is_file()
    loaded, m2 = ontology.load(tmp_path, "Customer", draft=True)
    assert loaded == t and m2 == m
    with pytest.raises(FileExistsError):
        ontology.save(tmp_path, t, None, draft=True)
    assert ontology.load_all(tmp_path) == ([], [])
    (tmp_path / "ontology" / "bad.yaml").write_text("api_name: [")
    assert len(ontology.load_all(tmp_path)[1]) == 1
    assert ontology.file_name("BankAccount") == "bank_account.yaml"


def _checks(result: dict) -> dict[str, tuple[str, str]]:
    return {c["name"]: (c["status"], c["detail"]) for c in result["checks"]}


def test_checks_on_a_bronze_table(client):
    c, _ = client
    sources = {s["table"]: s for s in c.get("/api/ontology/sources").json()}
    assert sources["tenant1.bronze.customers"]["layer"] == "bronze" and not sources["tenant1.bronze.customers"]["delta"]

    # without row rules the key repeats: publishing is blocked
    raw = copy.deepcopy(CUSTOMER) | {"links": []}
    raw["source"] = {"table": "tenant1.bronze.customers"}
    r = c.post("/api/ontology/check", json={"type": raw, "steps": ["source", "identity"]}).json()
    assert not r["ok"] and _checks(r)["Key unique after the rules"][0] == "fail"
    assert "latest row per key" in _checks(r)["Key unique after the rules"][1]
    assert r["stats"]["before"]["duplicate_keys"] == 1

    # with them: one object per key, the deleted one left out
    r = c.post("/api/ontology/check", json={"type": CUSTOMER | {"links": []}}).json()
    checks = _checks(r)
    assert r["ok"], checks
    assert r["stats"]["after"] == {"rows": 2, "distinct_keys": 2, "duplicate_keys": 0, "empty_keys": 0}
    assert checks["Cast balance to decimal"][0] == "fail" and "1 of 2" in checks["Cast balance to decimal"][1]
    assert checks["Layer: bronze"][0] == "info"
    assert checks["Delta table"][0] == "fail"  # a warning: Parquet tables work too

    missing = copy.deepcopy(CUSTOMER) | {"links": []}
    missing["properties"][1]["column"] = "nope"
    assert _checks(c.post("/api/ontology/check", json={"type": missing}).json())["Columns exist"][0] == "fail"


def test_draft_publish_and_explore(client):
    c, ws = client
    assert c.put("/api/ontology/drafts/Account", json={"type": ACCOUNT}).status_code == 200
    assert c.put("/api/ontology/drafts/Account", json={"type": ACCOUNT}).status_code == 409
    assert c.put("/api/ontology/drafts/Other", json={"type": ACCOUNT}).status_code == 422
    assert [d["api_name"] for d in c.get("/api/ontology/types").json()["drafts"]] == ["Account"]

    # a link to a type that isn't published blocks
    blocked = c.post("/api/ontology/publish", json={"type": CUSTOMER})
    assert blocked.status_code == 422 and "Account" in blocked.json()["detail"]

    published = c.post("/api/ontology/publish", json={"type": ACCOUNT})
    assert published.status_code == 200 and (ws / "ontology" / "account.yaml").is_file()
    assert c.get("/api/ontology/types").json()["drafts"] == []  # publishing drops the draft

    r = c.post("/api/ontology/check", json={"type": CUSTOMER, "steps": ["links"]}).json()
    link = r["stats"]["links"]["accounts"]
    assert link["found"] == "one-to-many" and link["matched"] == 3 and link["total"] == 4  # A4's owner is unknown
    assert _checks(r)["Link accounts → Account: match rate"][0] == "fail"  # 75%: a warning
    assert _checks(r)["Link accounts → Account: mixed layers"][0] == "info"
    wrong = copy.deepcopy(CUSTOMER)
    wrong["links"][0]["cardinality"] = "one-to-one"
    assert _checks(c.post("/api/ontology/check", json={"type": wrong}).json())[
        "Link accounts → Account: cardinality"][0] == "fail"

    assert c.post("/api/ontology/publish", json={"type": CUSTOMER}).status_code == 200
    assert c.post("/api/ontology/publish", json={"type": CUSTOMER}).status_code == 409  # must say which version

    preview = c.post("/api/ontology/preview", json={"type": CUSTOMER}).json()
    assert sorted(o["title"] for o in preview["objects"]) == ["Avi Levi", "Dana Cohen"]

    found = c.get("/api/ontology/objects/search", params={"q": "coh"}).json()["groups"]
    assert {g["type"]: [o["pk"] for o in g["objects"]] for g in found} == {"Account": [], "Customer": ["1"]}
    assert c.get("/api/ontology/objects/search", params={"q": "011"}).json()["groups"][1]["objects"] == []  # sensitive

    page = c.get("/api/ontology/objects/Customer/1").json()
    assert page["object"]["properties"]["balance"] == 18240.5 and page["layer"] == "bronze"
    assert {k["name"]: k["count"] for k in page["links"]} == {"accounts": 2}
    accounts = c.get("/api/ontology/objects/Customer/1/links/accounts").json()["objects"]
    assert sorted(o["pk"] for o in accounts) == ["A1", "A2"]
    owner = c.get("/api/ontology/objects/Account/A3/links/owner").json()["objects"]
    assert [o["title"] for o in owner] == ["Avi Levi"]
    assert c.get("/api/ontology/objects/Customer/3").status_code == 404  # deleted by the row rules
    assert c.get("/api/ontology/objects/Nope/1").status_code == 404
    types = {t["api_name"]: t for t in c.get("/api/ontology/objects/types").json()}
    assert [k["name"] for k in types["Account"]["all_links"]] == ["owner"]

    assert c.delete("/api/ontology/types/Customer").status_code == 204
    assert c.get("/api/ontology/types/Customer").status_code == 404


def test_sensitive_properties_are_masked_for_non_admins(tmp_path: Path, client):
    c, ws = client
    c.post("/api/ontology/publish", json={"type": ACCOUNT})
    c.post("/api/ontology/publish", json={"type": CUSTOMER})
    settings = Settings(workspace=ws, home=tmp_path / "home2", scheduler=False, catalog=tmp_path / "catalog",
                        auth=True)
    good = "Correct-horse-9"
    with TestClient(create_app(settings)) as a:
        a.post("/api/auth/setup", json={"username": "boss", "password": good})
        assert a.get("/api/ontology/objects/Customer/1").json()["object"]["properties"]["national_id"] == "011"
        a.post("/api/users", json={"username": "ivy", "password": good, "tabs": ["objects"]})
        a.post("/api/auth/logout")
        a.post("/api/auth/login", json={"username": "ivy", "password": good})
        assert a.get("/api/ontology/objects/Customer/1").json()["object"]["properties"]["national_id"] == ontology.MASK
        assert a.get("/api/ontology/types").status_code == 403  # building is the Ontology tab's
        assert a.post("/api/ontology/check", json={"type": CUSTOMER}).status_code == 403
        a.post("/api/auth/logout")
        assert a.get("/api/ontology/objects/search").status_code == 401


# ------------------------------------------------------------ phase B: access, actions, versions, audit
GOOD = "Correct-horse-9"


def _with_actions():
    t = copy.deepcopy(ACCOUNT)
    t["properties"].append({"api_name": "status_note", "column": "kind", "description": "x"})
    t["actions"] = [{"api_name": "reclassify", "label": "Reclassify",
                     "parameters": [{"property": "kind", "choices": ["checking", "savings", "frozen"]}],
                     "allowed": ["user:dana"]}]
    return t


def test_definition_rules_for_access_and_actions():
    bad = [
        (lambda d: d.update(access={"view": ["everyone"]}), "role:admin"),
        (lambda d: d["actions"][0]["parameters"].append({"property": "nope"}), "isn't one of the properties"),
        (lambda d: d["actions"][0]["parameters"].append({"property": "account_id"}), "primary key"),
        (lambda d: d["actions"].append(dict(d["actions"][0])), "two actions"),
    ]
    for change, message in bad:
        data = _with_actions()
        change(data)
        with pytest.raises(ValueError, match=message):
            ontology.parse(data)
    t = ontology.parse(_with_actions())
    dana = type("U", (), {"role": "user", "username": "dana"})()
    sam = type("U", (), {"role": "user", "username": "sam"})()
    assert ontology.can_run(dana, t.actions[0]) and not ontology.can_run(sam, t.actions[0])
    assert ontology.can_view(sam, t) and not ontology.can_see_sensitive(sam, t)  # empty view: everyone
    assert ontology.coerce(t.prop("account_id"), "A9") == "A9"
    with pytest.raises(ValueError):
        ontology.coerce(ontology.Property(api_name="n", column="n", type="integer"), "x")


def test_store_versions_edits_and_audit(tmp_path: Path):
    from prooflix.ontology_store import OntologyStore

    s = OntologyStore(f"sqlite:///{tmp_path / 'db.sqlite'}")
    assert s.status()["ok"]
    assert s.record_version("ws", "Account", {"a": 1}, "boss") == 1
    assert s.record_version("ws", "Account", {"a": 2}, "boss") == 2
    assert s.latest_versions("ws") == {"Account": 2} and s.latest_versions("other") == {}
    s.apply_edit("ws", "Account", "A1", "reclassify", {"kind": "frozen"}, "fraud", "dana")
    s.apply_edit("ws", "Account", "A1", "reclassify", {"kind": "savings"}, "cleared", "dana")
    assert s.latest_edits("ws", "Account", ["A1", "A2"])["A1"]["kind"]["value"] == "savings"
    assert [r["values"] for r in s.history("ws", "Account", "A1")] == [{"kind": "savings"}, {"kind": "frozen"}]
    s.audit("ws", "dana", "action", "Account", "A1", {"x": 1})
    assert s.audit_log("ws")[0]["event"] == "action" and s.audit_log("ws", event="publish") == []


@pytest.fixture
def db_client(tmp_path: Path, client):
    """The same workspace, with users on and the object model's database (SQLite) set."""
    _, ws = client
    settings = Settings(workspace=ws, home=tmp_path / "home-b", scheduler=False, catalog=tmp_path / "catalog",
                        auth=True, database_url=f"sqlite:///{tmp_path / 'ontology.sqlite'}")
    with TestClient(create_app(settings)) as a:
        a.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        for name, tabs in (("dana", ["objects"]), ("sam", ["objects"]), ("olga", ["ontology"])):
            a.post("/api/users", json={"username": name, "password": GOOD, "tabs": tabs})
        yield a


def _login(a: TestClient, name: str) -> None:
    a.post("/api/auth/logout")
    assert a.post("/api/auth/login", json={"username": name, "password": GOOD}).status_code == 200


def test_access_actions_history_and_audit(db_client):
    a = db_client
    customer = copy.deepcopy(CUSTOMER) | {"access": {"view": ["user:dana"], "sensitive": ["user:dana"]}}
    first = a.post("/api/ontology/publish", json={"type": _with_actions()})
    assert first.status_code == 200 and first.json()["version"] == 1
    assert a.post("/api/ontology/publish", json={"type": customer}).json()["version"] == 1
    assert a.get("/api/ontology/types").json()["versions"] == {"Account": 1, "Customer": 1}
    assert [v["version"] for v in a.get("/api/ontology/types/Account/versions").json()] == [1]
    # access checks of the wizard
    checks = {c["name"]: c["status"] for c in a.post("/api/ontology/check", json={"type": CUSTOMER}).json()["checks"]}
    assert checks["Raw data isn't open to everyone"] == "fail"  # bronze, open to everyone
    # "view as user": sam may not see Customer; dana sees the sensitive id
    assert a.post("/api/ontology/preview", json={"type": customer, "as_user": "sam"}).json()["visible"] is False
    shown = a.post("/api/ontology/preview", json={"type": customer, "as_user": "dana"}).json()["objects"]
    assert {o["properties"]["national_id"] for o in shown} == {"011", "022"}

    _login(a, "sam")
    assert [t["api_name"] for t in a.get("/api/ontology/objects/types").json()] == ["Account"]
    assert a.get("/api/ontology/objects/Customer/1").status_code == 404  # hidden, not just masked
    assert [k["name"] for k in a.get("/api/ontology/objects/Account/A1").json()["links"]] == []  # owner hidden
    run = a.post("/api/ontology/objects/Account/A1/actions/reclassify", json={"values": {"kind": "frozen"},
                                                                              "reason": "x"})
    assert run.status_code == 403

    _login(a, "dana")
    types = {t["api_name"]: t for t in a.get("/api/ontology/objects/types").json()}
    assert types["Account"]["my_actions"] == ["reclassify"] and types["Customer"]["sees_sensitive"]
    url = "/api/ontology/objects/Account/A1/actions/reclassify"
    assert a.post(url, json={"values": {"kind": "frozen"}}).status_code == 422  # no reason
    assert a.post(url, json={"values": {"kind": "gold"}, "reason": "x"}).status_code == 422  # not a choice
    assert a.post(url, json={"values": {"kind": "frozen", "owner_id": "2"}, "reason": "x"}).status_code == 422
    done = a.post(url, json={"values": {"kind": "frozen"}, "reason": "suspicious"})
    assert done.status_code == 200 and done.json()["object"]["properties"]["kind"] == "frozen"
    page = a.get("/api/ontology/objects/Account/A1").json()["object"]
    assert page["properties"]["kind"] == "frozen" and page["edited"]["kind"]["by"] == "dana"
    found = a.get("/api/ontology/objects/search", params={"q": "A1", "type": "Account"}).json()["groups"][0]
    assert found["objects"][0]["properties"]["kind"] == "frozen"  # the edit is laid over search results too
    hist = a.get("/api/ontology/objects/Account/A1/history").json()
    assert hist["available"] and hist["runs"][0]["reason"] == "suspicious"
    assert a.get("/api/ontology/objects/Customer/1").json()["object"]["properties"]["national_id"] == "011"
    assert a.get("/api/ontology/audit").status_code == 403  # admins only

    _login(a, "boss")
    events = [e["event"] for e in a.get("/api/ontology/audit").json()]
    assert events[:2] == ["read_sensitive", "action"] and "publish" in events and "view_as" in events
    assert a.get("/api/ontology/audit", params={"event": "action"}).json()[0]["detail"]["reason"] == "suspicious"
    assert a.get("/api/ontology/objects/status").json()["database"]["ok"] is True


def test_actions_need_the_database(client):
    c, _ = client
    c.post("/api/ontology/publish", json={"type": _with_actions()})
    r = c.post("/api/ontology/objects/Account/A1/actions/reclassify", json={"values": {"kind": "frozen"},
                                                                            "reason": "x"})
    assert r.status_code == 409 and "PROOFLIX_DATABASE_URL" in r.json()["detail"]
    assert c.get("/api/ontology/objects/Account/A1/history").json()["available"] is False
    assert c.get("/api/ontology/objects/status").json()["database"]["configured"] is False

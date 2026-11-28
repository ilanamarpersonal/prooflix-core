"""AI Assist on objects: the tool loop with a scripted stand-in for Claude, access, masking, proposals."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import object_assist, ontology
from prooflix.config import Settings
from prooflix.main import create_app

GOOD = "Correct-horse-9"
CUSTOMER = {
    "api_name": "Customer", "ai": True,
    "source": {"table": "tenant1.silver.customers"}, "primary_key": "customer_id", "title": "full_name",
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
    "api_name": "Account", "ai": True,
    "source": {"table": "tenant1.silver.accounts"}, "primary_key": "account_id", "title": "account_id",
    "properties": [
        {"api_name": "account_id", "column": "account_id"},
        {"api_name": "owner_id", "column": "owner_ref"},
        {"api_name": "status", "column": "status"},
        {"api_name": "balance", "column": "balance"},
    ],
    "actions": [{"api_name": "freeze", "parameters": [{"property": "status", "choices": ["active", "frozen"]}],
                 "allowed": ["role:user"]}],
}


def _write(folder: Path, table: pa.Table) -> None:
    folder.mkdir(parents=True)
    pq.write_table(table, folder / "part-0.parquet")


class FakeClaude:
    """Answers with scripted turns and records every request it gets."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.requests.append(copy.deepcopy(kwargs))  # the loop keeps appending to the same messages list
        stop, blocks = self.turns.pop(0)
        content = []
        for b in blocks:
            if "tool" in b:
                content.append(SimpleNamespace(type="tool_use", id=b["id"], name=b["tool"], input=b["input"]))
            else:
                content.append(SimpleNamespace(type="text", text=b["text"]))
        return SimpleNamespace(stop_reason=stop, content=content, model="claude-opus-5-5")


def _use(id_, tool, **inp):
    return {"id": id_, "tool": tool, "input": inp}


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    data = ws / "data" / "tenant1" / "silver"
    _write(data / "customers", pa.table({"customer_id": [1, 2], "full_name": ["Dana Cohen", "Avi Levi"],
                                          "city": ["Haifa", "Eilat"], "email": ["d@x.io", "a@x.io"]}))
    _write(data / "accounts", pa.table({"account_id": ["A1", "A2", "A3"], "owner_ref": [1, 1, 2],
                                         "status": ["active"] * 3, "balance": [100.0, 25000.0, 50.0]}))
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog",
                        auth=True, database_url=f"sqlite:///{tmp_path / 'db.sqlite'}")
    with TestClient(create_app(settings)) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["objects"]})
        c.post("/api/users", json={"username": "olga", "password": GOOD, "tabs": ["ontology"]})
        assert c.post("/api/ontology/publish", json={"type": ACCOUNT}).status_code == 200
        assert c.post("/api/ontology/publish", json={"type": CUSTOMER}).status_code == 200
        yield c


def _login(c, name):
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json={"username": name, "password": GOOD}).status_code == 200


def _fake(monkeypatch, turns) -> FakeClaude:
    fake = FakeClaude(turns)
    monkeypatch.setattr(object_assist, "_client", lambda s: fake)
    return fake


def _tool_results(request: dict) -> dict[str, dict]:
    """The tool results the stand-in got in its last message, by tool_use id."""
    return {r["tool_use_id"]: r for r in request["messages"][-1]["content"]}


def test_tools_answer_with_masked_values_and_a_proposal(client, monkeypatch):
    c = client  # signed in as boss, an admin: emails still never go to Claude
    fake = _fake(monkeypatch, [
        ("tool_use", [_use("t1", "list_object_types"),
                      _use("t2", "run_object_set", type="Customer",
                           filters=[{"property": "city", "op": "eq", "value": "Haifa"}],
                           steps=[{"link": "accounts", "filters": [{"property": "balance", "op": "gt", "value": "1000"}]}],
                           limit=5)]),
        ("tool_use", [_use("t3", "get_object", type="Customer", key="1"),
                      _use("t4", "propose_action", type="Account", key="A2", action="freeze",
                           values=[{"property": "status", "value": "frozen"}], reason="Large balance, check it"),
                      _use("t5", "search_objects", type="Nope", text="", limit=3)]),
        ("end_turn", [{"text": "One account: [[Account:A2|A2]] of [[Customer:1|Dana Cohen]]. I proposed freezing it."}]),
    ])
    r = c.post("/api/ontology/objects/assist", json={"question": "Which Haifa accounts are over 1000?"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["answer"].startswith("One account") and out["tool_calls"] == 5
    assert [(p["type"], p["key"], p["action"], p["values"]) for p in out["proposals"]] == [
        ("Account", "A2", "freeze", {"status": "frozen"})]
    # nothing was applied: a proposal only
    assert c.get("/api/ontology/objects/Account/A2").json()["object"]["properties"]["status"] == "active"

    first = _tool_results(fake.requests[1])
    types = json.loads(first["t1"]["content"])["types"]
    assert {t["type"] for t in types} == {"Customer", "Account"}
    sets = json.loads(first["t2"]["content"])
    assert [s["count"] for s in sets["steps"]] == [1, 1] and sets["objects"][0]["key"] == "A2"
    second = _tool_results(fake.requests[2])
    obj = json.loads(second["t3"]["content"])
    assert obj["object"]["properties"]["email"] == ontology.MASK  # even for an admin
    assert obj["links"] == [{"name": "accounts", "to": "Account", "count": 2}]
    assert second["t5"]["is_error"] and "no type Nope" in second["t5"]["content"]
    assert "d@x.io" not in json.dumps(fake.requests[-1]["messages"], default=str)
    assert fake.requests[0]["tools"] == object_assist.TOOLS and fake.requests[0]["tool_choice"] == {"type": "auto"}

    events = [e for e in c.get("/api/ontology/audit").json() if e["event"].startswith("ai_")]
    assert [e["event"] for e in events].count("ai_tool") == 5 and events[-1]["event"] == "ai_question"


def test_no_sensitive_filters_and_only_open_types(client, monkeypatch):
    c = client
    fake = _fake(monkeypatch, [
        ("tool_use", [_use("t1", "run_object_set", type="Customer",
                           filters=[{"property": "email", "op": "eq", "value": "d@x.io"}], steps=[], limit=5)]),
        ("end_turn", [{"text": "I can't filter on emails."}]),
    ])
    c.post("/api/ontology/objects/assist", json={"question": "Who has d@x.io?"})
    assert "sensitive" in _tool_results(fake.requests[1])["t1"]["content"]

    # a type not opened to AI Assist doesn't exist for the tools
    modified = c.get("/api/ontology/types/Account").json()["modified"]
    c.post("/api/ontology/publish", json={"type": ACCOUNT | {"ai": False}, "modified": modified})
    fake = _fake(monkeypatch, [("tool_use", [_use("t1", "list_object_types")]), ("end_turn", [{"text": "ok"}])])
    c.post("/api/ontology/objects/assist", json={"question": "types?"})
    assert [t["type"] for t in json.loads(_tool_results(fake.requests[1])["t1"]["content"])["types"]] == ["Customer"]


def test_only_admins_open_a_type_to_ai(client):
    c = client
    _login(c, "olga")
    other = copy.deepcopy(ACCOUNT) | {"api_name": "Other"}
    assert c.post("/api/ontology/publish", json={"type": other}).status_code == 403
    assert c.post("/api/ontology/publish", json={"type": other | {"ai": False}}).status_code == 200


def test_proposals_respect_permissions_and_refusals_stop(client, monkeypatch):
    c = client
    _login(c, "dana")  # may run freeze (role:user), sees the types (no access rules)
    fake = _fake(monkeypatch, [
        ("tool_use", [_use("t1", "propose_action", type="Account", key="A1", action="freeze",
                           values=[{"property": "status", "value": "gone"}], reason="x")]),
        ("end_turn", [{"text": "That value isn't allowed."}]),
    ])
    assert c.post("/api/ontology/objects/assist", json={"question": "freeze A1"}).json()["proposals"] == []
    assert "choose one of" in _tool_results(fake.requests[1])["t1"]["content"]
    _fake(monkeypatch, [("refusal", [])])
    assert c.post("/api/ontology/objects/assist", json={"question": "x"}).status_code == 422


def test_the_loop_is_bounded(client, monkeypatch):
    c = client
    turns = [("tool_use", [_use(f"t{i}", "list_object_types")]) for i in range(object_assist.MAX_MODEL_TURNS - 1)]
    fake = _fake(monkeypatch, turns + [("end_turn", [{"text": "Done with what I had."}])])
    out = c.post("/api/ontology/objects/assist", json={"question": "loop"}).json()
    assert out["answer"] == "Done with what I had."
    assert fake.requests[-1]["tool_choice"] == {"type": "none"}  # the last turn must answer

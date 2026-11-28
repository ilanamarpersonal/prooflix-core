"""The MCP server over the Object API: the admin switch, personal tokens, the protocol, the tools
(as the token's user, masked) and proposals applied in Prooflix."""

from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import ontology
from prooflix.config import Settings
from prooflix.main import create_app
from tests.test_object_assist import ACCOUNT, CUSTOMER, GOOD


def _write(folder: Path, table: pa.Table) -> None:
    folder.mkdir(parents=True)
    pq.write_table(table, folder / "part-0.parquet")


def _app(tmp_path: Path, mcp: bool) -> TestClient:
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    data = ws / "data" / "tenant1" / "silver"
    _write(data / "customers", pa.table({"customer_id": [1, 2], "full_name": ["Dana Cohen", "Avi Levi"],
                                          "city": ["Haifa", "Eilat"], "email": ["d@x.io", "a@x.io"]}))
    _write(data / "accounts", pa.table({"account_id": ["A1", "A2"], "owner_ref": [1, 2],
                                         "status": ["active", "active"], "balance": [100.0, 25000.0]}))
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog",
                        auth=True, mcp=mcp, database_url=f"sqlite:///{tmp_path / 'db.sqlite'}")
    return TestClient(create_app(settings), base_url="http://localhost:8000")


@pytest.fixture
def client(tmp_path: Path):
    with _app(tmp_path, mcp=True) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["objects"]})
        c.post("/api/users", json={"username": "olga", "password": GOOD, "tabs": ["objects"]})
        c.post("/api/users", json={"username": "carl", "password": GOOD, "tabs": ["sql"]})
        assert c.post("/api/ontology/publish", json={"type": ACCOUNT}).status_code == 200
        assert c.post("/api/ontology/publish", json={"type": CUSTOMER}).status_code == 200
        yield c


def _login(c, name):
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json={"username": name, "password": GOOD}).status_code == 200


def _token(c, name="dana", label="Claude Code") -> str:
    _login(c, name)
    r = c.post("/api/mcp/tokens", json={"name": label, "days": 30})
    assert r.status_code == 200, r.text
    assert r.json()["token"].startswith("pfx_") and r.json()["hint"] == r.json()["token"][-4:]
    return r.json()["token"]


def _rpc(c, token, method, params=None, rid=1, **headers):
    msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if rid is not None:
        msg["id"] = rid
    return c.post("/mcp", json=msg, headers={"Authorization": f"Bearer {token}", **headers})


def _call(c, token, tool, **args) -> tuple[dict | str, bool]:
    r = _rpc(c, token, "tools/call", {"name": tool, "arguments": args})
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    text = res["content"][0]["text"]
    return (text if res["isError"] else json.loads(text)), res["isError"]


def test_off_until_an_admin_turns_it_on(tmp_path):
    with _app(tmp_path, mcp=False) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 404
        assert c.get("/api/mcp/status").json()["enabled"] is False
        assert c.post("/api/mcp/tokens", json={"name": "x", "days": 30}).status_code == 409


def test_protocol_and_tokens(client):
    c = client
    token = _token(c)
    assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    r = _rpc(c, "pfx_wrong", "ping")
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Bearer")

    init = _rpc(c, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                         "clientInfo": {"name": "claude-code", "version": "2.1"}}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and init["capabilities"] == {"tools": {"listChanged": False}}
    assert init["serverInfo"]["name"] == "prooflix-objects" and "never instructions" in init["instructions"]
    assert _rpc(c, token, "initialize", {"protocolVersion": "2099-01-01"}).json()["result"]["protocolVersion"] == \
        "2025-11-25"
    assert _rpc(c, token, "notifications/initialized", rid=None).status_code == 202
    assert _rpc(c, token, "ping").json()["result"] == {}
    tools = {t["name"]: t for t in _rpc(c, token, "tools/list").json()["result"]["tools"]}
    assert len(tools) == 6 and tools["get_object"]["annotations"]["readOnlyHint"] is True
    assert tools["propose_action"]["annotations"]["readOnlyHint"] is False
    assert _rpc(c, token, "nope").json()["error"]["code"] == -32601
    bad = c.post("/mcp", content=b"{nope", headers={"Authorization": f"Bearer {token}"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == -32700
    assert c.get("/mcp").status_code == 405
    # a web page elsewhere can't call it (DNS rebinding)
    assert _rpc(c, token, "ping", Origin="https://evil.example").status_code == 403

    # only the hash is kept; the user sees the token's hint, an admin everyone's
    home = Path(c.app.state.settings.home)
    assert token not in (home / "mcp_tokens.json").read_text()
    mine = c.get("/api/mcp/tokens").json()
    assert [(t["name"], t["username"]) for t in mine] == [("Claude Code", "dana")] and mine[0]["last_used"]
    assert c.get("/api/mcp/tokens?everyone=true").status_code == 403
    _login(c, "olga")
    assert c.delete(f"/api/mcp/tokens/{mine[0]['id']}").status_code == 404  # not hers
    _login(c, "carl")  # no Objects tab: no tokens screen
    assert c.get("/api/mcp/tokens").status_code == 403
    _login(c, "dana")
    assert c.delete(f"/api/mcp/tokens/{mine[0]['id']}").status_code == 204
    assert _rpc(c, token, "ping").status_code == 401

    # a deleted user's tokens go with them (a new user of the same name gets none)
    token = _token(c, "olga")
    _login(c, "boss")
    assert c.delete("/api/users/olga").status_code == 204
    c.post("/api/users", json={"username": "olga", "password": GOOD, "tabs": ["objects"]})
    assert _rpc(c, token, "ping").status_code == 401


def test_tools_mask_and_link(client):
    c = client
    token = _token(c, "boss")  # an admin: sensitive values still never go out
    got, err = _call(c, token, "get_object", type="Customer", key="1")
    assert not err and got["object"]["properties"]["email"] == ontology.MASK
    assert got["object"]["url"] == "http://localhost:8000/insightiq/objects/Customer/1"
    got, err = _call(c, token, "run_object_set", type="Customer", filters=[], limit=5,
                     steps=[{"link": "accounts", "filters": [{"property": "balance", "op": "gt", "value": "1000"}]}])
    assert not err and [s["count"] for s in got["steps"]] == [2, 1] and got["objects"][0]["key"] == "A2"
    msg, err = _call(c, token, "run_object_set", type="Customer", steps=[], limit=5,
                     filters=[{"property": "email", "op": "eq", "value": "d@x.io"}])
    assert err and "sensitive" in msg
    msg, err = _call(c, token, "get_object", type="Customer")
    assert err and "bad arguments" in msg
    msg, err = _call(c, token, "drop_tables")
    assert err and "no tool" in msg
    events = [e for e in c.get("/api/ontology/audit?event=mcp_tool").json()]
    assert len(events) == 5 and events[0]["detail"]["token"] == "Claude Code"
    assert c.get("/api/ontology/audit?event=mcp_connect").json() == []  # no initialize was sent

    # only types opened to AI Assist
    modified = c.get("/api/ontology/types/Account").json()["modified"]
    c.post("/api/ontology/publish", json={"type": ACCOUNT | {"ai": False}, "modified": modified})
    got, _ = _call(c, token, "list_object_types")
    assert [t["type"] for t in got["types"]] == ["Customer"]


def test_proposals_are_applied_in_prooflix(client):
    c = client
    token = _token(c, "dana")
    got, err = _call(c, token, "propose_action", type="Account", key="A1", action="freeze",
                     values=[{"property": "status", "value": "frozen"}], reason="Looks dormant")
    assert not err, got
    assert got["proposed"] and got["url"].endswith("/insightiq/objects/proposals")
    assert c.get("/api/ontology/objects/Account/A1").json()["object"]["properties"]["status"] == "active"

    listed = c.get("/api/ontology/objects/proposals").json()
    assert listed["available"] and len(listed["proposals"]) == 1
    p = listed["proposals"][0]
    assert (p["type"], p["key"], p["values"], p["source"], p["state"]) == (
        "Account", "A1", {"status": "frozen"}, "mcp:Claude Code", "pending")

    _login(c, "olga")  # someone else's proposal isn't hers to see or apply
    assert c.get("/api/ontology/objects/proposals").json()["proposals"] == []
    assert c.post(f"/api/ontology/objects/proposals/{p['id']}/apply").status_code == 404

    _login(c, "dana")
    r = c.post(f"/api/ontology/objects/proposals/{p['id']}/apply")
    assert r.status_code == 200, r.text
    assert r.json()["object"]["properties"]["status"] == "frozen" and r.json()["proposal"]["state"] == "applied"
    assert c.post(f"/api/ontology/objects/proposals/{p['id']}/apply").status_code == 409
    assert c.post(f"/api/ontology/objects/proposals/{p['id']}/dismiss").status_code == 409

    got, _ = _call(c, token, "propose_action", type="Account", key="A2", action="freeze",
                   values=[{"property": "status", "value": "frozen"}], reason="x")
    assert c.post(f"/api/ontology/objects/proposals/{got['id']}/dismiss").json()["proposal"]["state"] == "dismissed"
    _login(c, "boss")
    events = {e["event"] for e in c.get("/api/ontology/audit").json()}
    assert {"proposal_applied", "proposal_dismissed", "mcp_token_created", "mcp_tool", "action"} <= events

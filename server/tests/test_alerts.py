"""Alerts: message formats, channels, rules, cooldowns and delivery."""

from __future__ import annotations

import json
import stat
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from prooflix.alerts import MASK, AlertEngine, AlertsFileError, AlertStore, compile_rule, match
from prooflix.config import Settings
from prooflix.main import create_app

SLACK = {"url": "https://hooks.slack.com/services/T0/B0/secret"}


@pytest.mark.parametrize(
    ("pattern", "line", "fields"),
    [
        ("ALERT {severity}: {message}", "ALERT high: disk full", {"severity": "high", "message": "disk full"}),
        ("ERROR {message}", "12:00 ERROR Command exited with code 1", {"message": "Command exited with code 1"}),
        ("{table}: {rows} new rows", "accounts: 1,200 new rows", {"table": "accounts", "rows": "1,200"}),
        ("disk full", "the disk full (90%)", {}),
        ("ALERT {x}", "nothing", None),
    ],
)
def test_message_formats(pattern, line, fields):
    assert match({"mode": "format", "pattern": pattern}, line) == fields


def test_regex_and_bad_formats():
    assert match({"mode": "regex", "pattern": r"rows=(?P<n>\d+)"}, "done rows=42") == {"n": "42"}
    for mode, pattern in (("format", "{a} {a}"), ("regex", "(unclosed"), ("format", ""), ("other", "x")):
        with pytest.raises(ValueError):
            compile_rule(mode, pattern)


def test_channels_keep_secrets_private(tmp_path: Path):
    store = AlertStore(tmp_path)
    store.save_channel("ops", "slack", "Ops", SLACK)
    assert stat.S_IMODE((tmp_path / "alerts.json").stat().st_mode) == 0o600
    from prooflix.alerts import public_channel

    assert public_channel("ops", store.snapshot()["channels"]["ops"])["config"]["url"] == MASK
    store.save_channel("ops", "slack", "Ops 2", {"url": MASK})  # masked: keeps the saved URL
    assert store.snapshot()["channels"]["ops"]["config"]["url"] == SLACK["url"]
    for kind, cfg in (("slack", {"url": "https://evil.example/x"}), ("teams", {"url": "http://x"}),
                      ("webhook", {"url": "ftp://x"}), ("email", {"smtp_host": "h", "smtp_port": "25",
                                                                "security": "none", "sender": "bad",
                                                                "recipients": "a@b.c"})):
        with pytest.raises(ValueError):
            store.save_channel("x", kind, "", cfg)


def test_alerts_file_fails_closed(tmp_path: Path):
    store = AlertStore(tmp_path)
    store.save_channel("ops", "slack", "Ops", SLACK)
    (tmp_path / "alerts.json").write_text("{ broken")
    store._cache = None
    with pytest.raises(AlertsFileError):
        store.save_channel("b", "slack", "", SLACK)
    assert (tmp_path / "alerts.json").read_text() == "{ broken"


def _wait_for(fn, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.02)
    return False


def test_engine_channels_pipelines_and_cooldown(tmp_path: Path):
    store = AlertStore(tmp_path)
    store.save_channel("slack", "slack", "Slack", SLACK)
    store.save_channel("hook", "webhook", "Hook", {"url": "https://example.com/hook"})
    store.save_rule(None, {"name": "all", "pattern": "ALERT {message}", "cooldown_seconds": 60})
    store.save_rule(None, {"name": "one", "pattern": "FAIL {message}", "channels": ["hook"],
                           "pipelines": ["orders"], "cooldown_seconds": 0})
    sent = []
    engine = AlertEngine(store, sender=lambda ch, ev: sent.append((ch["name"], ev["rule"], ev["fields"])))
    run = SimpleNamespace(id="r1", pipeline="orders")
    engine.handle(run, "t", "ALERT disk full")  # every channel
    engine.handle(run, "t", "ALERT again")  # cooldown: counted, not sent
    engine.handle(run, "t", "FAIL boom")  # only the webhook
    engine.handle(SimpleNamespace(id="r2", pipeline="other"), "t", "FAIL boom")  # not this pipeline
    assert _wait_for(lambda: len(sent) == 3)
    assert sorted(sent) == sorted([("Slack", "all", {"message": "disk full"}), ("Hook", "all", {"message": "disk full"}),
                                   ("Hook", "one", {"message": "boom"})])
    assert _wait_for(lambda: all(d["status"] == "sent" for e in store.history() for d in e["deliveries"].values()))
    assert len(store.history()) == 2


def test_failed_delivery_hides_secrets(tmp_path: Path):
    store = AlertStore(tmp_path)
    store.save_channel("slack", "slack", "Slack", SLACK)
    store.save_rule(None, {"name": "r", "pattern": "ALERT", "cooldown_seconds": 0})

    def boom(ch, ev):
        raise RuntimeError(f"could not reach {ch['config']['url']}")

    AlertEngine(store, sender=boom).handle(SimpleNamespace(id="r", pipeline="p"), "t", "ALERT")
    assert _wait_for(lambda: store.history() and store.history()[0]["deliveries"]["slack"]["status"] == "failed")
    assert "secret" not in json.dumps(store.history())


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "pipelines" / "noisy.yaml").write_text(
        "tasks:\n- key: shout\n  type: shell\n  command: \"echo 'ALERT critical: tank empty'\"\n")
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog")
    with TestClient(create_app(settings)) as c:
        yield c


def test_api_and_a_run_that_raises_an_alert(client, monkeypatch):
    c = client
    sent = []
    monkeypatch.setattr(c.app.state.alerts, "sender", lambda ch, ev: sent.append(ev))
    assert c.put("/api/alerts/channels/ops", json={"kind": "webhook", "config": {"url": "https://example.com/h"}}).status_code == 200
    assert c.get("/api/alerts/channels").json()[0]["config"]["url"] == MASK
    assert c.post("/api/alerts/try", json={"pattern": "ALERT {severity}: {message}", "line": "ALERT critical: x"}).json() == {
        "matches": True, "fields": {"severity": "critical", "message": "x"}}
    r = c.post("/api/alerts/rules", json={"name": "Tank", "pattern": "ALERT {severity}: {message}", "severity": "critical"})
    assert r.status_code == 201
    assert c.post("/api/alerts/rules", json={"name": "x", "pattern": "x", "channels": ["nope"]}).status_code == 422
    assert c.delete("/api/alerts/channels/ops").status_code == 204  # a rule for "all channels" doesn't hold it
    c.put("/api/alerts/channels/ops", json={"kind": "webhook", "config": {"url": "https://example.com/h"}})
    run = c.post("/api/pipelines/noisy/runs", json={}).json()
    assert _wait_for(lambda: c.get(f"/api/runs/{run['id']}").json()["status"] == "SUCCEEDED")
    assert _wait_for(lambda: len(sent) == 1)
    assert sent[0]["fields"] == {"severity": "critical", "message": "tank empty"} and sent[0]["pipeline"] == "noisy"
    hist = c.get("/api/alerts/history").json()
    assert hist[0]["rule"] == "Tank" and hist[0]["deliveries"]["ops"]["kind"] == "webhook"
    assert c.post("/api/alerts/channels/ops/test").json() == {"ok": True, "error": None}


def test_only_admins_or_users_given_alerts_can_create_alerts(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "c", auth=True)
    rule = {"name": "r", "pattern": "ERROR {message}"}
    with TestClient(create_app(settings)) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": "Secret123"})
        assert c.post("/api/alerts/rules", json=rule).status_code == 201  # an admin may
        c.post("/api/users", json={"username": "viewer", "password": "Secret123", "tabs": ["pipelines"]})
        c.post("/api/users", json={"username": "ops", "password": "Secret123", "tabs": ["alerts"]})
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"username": "viewer", "password": "Secret123"})
        assert c.post("/api/alerts/rules", json=rule).status_code == 403
        assert c.get("/api/alerts/rules").status_code == 403
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"username": "ops", "password": "Secret123"})
        assert c.post("/api/alerts/rules", json=rule).status_code == 201  # given the Alerts permission


def test_delete_alerts_from_history(tmp_path: Path):
    store = AlertStore(tmp_path)
    for i in range(3):
        store.add_history({"id": f"a{i}", "deliveries": {}})
    assert store.delete_history(["a1"]) == 1
    assert [e["id"] for e in store.history()] == ["a2", "a0"]
    assert store.delete_history(None) == 2 and store.history() == []


def test_delete_history_route(client):
    c = client
    c.app.state.alert_store.add_history({"id": "x1", "deliveries": {}})
    c.app.state.alert_store.add_history({"id": "x2", "deliveries": {}})
    assert c.post("/api/alerts/history/delete", json={"ids": ["x1"]}).json() == {"deleted": 1}
    assert c.post("/api/alerts/history/delete", json={}).json() == {"deleted": 1}
    assert c.get("/api/alerts/history").json() == []

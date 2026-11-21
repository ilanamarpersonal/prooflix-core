"""AI Assist: the Claude account settings and the SQL editor's suggested fixes (Claude is faked)."""

from __future__ import annotations

import stat
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import ai_assist
from prooflix.ai_assist import AiAssistStore, SqlFix
from prooflix.config import Settings
from prooflix.main import create_app

KEY = "sk-ant-api03-" + "x" * 40 + "WXYZ"
GOOD = "Secret123"


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


class FakeClaude:
    """Records what Prooflix sends and answers with ``answer``."""

    calls: list[dict] = []
    answer: SqlFix | None = None
    stop_reason = "end_turn"
    raises: Exception | None = None

    def __init__(self, api_key: str, **_):
        self.api_key = api_key
        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=self._parse))
        self.models = SimpleNamespace(retrieve=lambda m: SimpleNamespace(id=m, display_name="Claude Test"))

    def _parse(self, **kw):
        FakeClaude.calls.append({"api_key": self.api_key, **kw})
        if FakeClaude.raises:
            raise FakeClaude.raises
        return SimpleNamespace(stop_reason=FakeClaude.stop_reason, parsed_output=FakeClaude.answer, model=kw["model"])


@pytest.fixture
def fake(monkeypatch):
    FakeClaude.calls = []
    FakeClaude.answer = SqlFix(diagnosis="The column is amount, not amt.", explanation="Renamed amt to amount.",
                               fixed_sql="SELECT sum(amount) FROM orders;", confidence="high")
    FakeClaude.stop_reason = "end_turn"
    FakeClaude.raises = None
    monkeypatch.setattr(ai_assist.anthropic, "Anthropic", FakeClaude)
    return FakeClaude


def test_the_key_is_private_and_never_shown(tmp_path: Path):
    store = AiAssistStore(tmp_path)
    assert ai_assist.public(store.get())["key_source"] == "none"
    with pytest.raises(ValueError, match="model"):
        store.update(enabled=True, model="gpt-4", effort="medium")
    with pytest.raises(ValueError, match="API key"):
        store.update(enabled=True, model="claude-opus-5-5", effort="medium", api_key="short")
    store.update(enabled=True, model="claude-opus-5-5", effort="medium", api_key=KEY)
    assert stat.S_IMODE((tmp_path / "ai_assist.json").stat().st_mode) == 0o600
    p = ai_assist.public(store.get())
    assert KEY not in str(p) and p["key_hint"] == "…WXYZ" and p["ready"] and p["key_source"] == "saved"
    assert p["key_prefix"] == "sk-ant-api03" and p["key_saved_at"]
    haiku = next(m for m in p["models"] if m["id"] == "claude-haiku-5-5")
    assert haiku["input_price"] == 0.10 and haiku["output_price"] == 0.50
    saved_at = p["key_saved_at"]
    # saving without a key keeps it; removing it takes it away
    store.update(enabled=True, model="claude-sonnet-5-5", effort="low")
    assert store.get().api_key == KEY and store.get().model == "claude-sonnet-5-5"
    assert store.get().key_saved_at == saved_at  # keeping the key keeps its date
    store.update(enabled=True, model="claude-sonnet-5-5", effort="low", remove_key=True)
    assert store.get().api_key == "" and store.get().key_saved_at == ""


def test_environment_key_is_used_when_none_is_saved(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    p = ai_assist.public(AiAssistStore(tmp_path).get())
    assert p["key_source"] == "environment" and p["ready"]


def test_unreadable_settings_fail_closed(tmp_path: Path):
    (tmp_path / "ai_assist.json").write_text("{ nope")
    with pytest.raises(ai_assist.AiAssistFileError):
        AiAssistStore(tmp_path).get()


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "data").mkdir()
    pq.write_table(pa.table({"order_id": [1, 2], "amount": [10.0, 5.0]}), ws / "data" / "orders.parquet")
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog", auth=True)
    with TestClient(create_app(settings)) as c:
        c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
        yield c


def test_only_admins_see_the_account_and_sql_users_ask(client, fake):
    c = client
    assert c.get("/api/auth/status").json()["user"]["visible_tabs"][-1] == "ai-assist"
    assert c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT amt FROM orders", "error": "x"}).status_code == 409
    assert c.put("/api/ai-assist/settings", json={"model": "claude-opus-5-5", "api_key": KEY}).status_code == 200
    got = c.get("/api/ai-assist/settings").json()
    assert got["ready"] and KEY not in str(got)
    assert c.post("/api/ai-assist/settings/test").json()["display_name"] == "Claude Test"

    c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["sql"]})
    c.post("/api/users", json={"username": "carl", "password": GOOD, "tabs": ["catalog"]})
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "dana", "password": GOOD})
    assert c.get("/api/ai-assist/settings").status_code == 403
    assert c.put("/api/ai-assist/settings", json={"model": "claude-opus-5-5"}).status_code == 403
    assert c.get("/api/ai-assist/status").json() == {"ready": True, "enabled": True, "model": "claude-opus-5-5"}
    r = c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT amt FROM orders", "error": 'column "amt" not found'})
    assert r.status_code == 200
    assert r.json() | {"model": None} == {
        "diagnosis": "The column is amount, not amt.", "explanation": "Renamed amt to amount.",
        "fixed_sql": "SELECT sum(amount) FROM orders", "confidence": "high", "runnable": True, "problem": None,
        "model": None,
    }
    call = fake.calls[-1]
    assert call["api_key"] == KEY and call["model"] == "claude-opus-5-5" and call["fallbacks"] == "default"
    sent = call["messages"][0]["content"]
    assert "orders (2 rows): order_id BIGINT, amount DOUBLE" in sent and 'column "amt" not found' in sent
    assert "10.0" not in sent  # table names and columns only, never rows

    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "carl", "password": GOOD})
    assert c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1"}).status_code == 403
    assert c.get("/api/ai-assist/status").status_code == 200


def test_suggestions_must_be_one_read_only_select(client, fake):
    c = client
    c.put("/api/ai-assist/settings", json={"model": "claude-haiku-5-5", "api_key": KEY})
    fake.answer = SqlFix(diagnosis="d", explanation="e", fixed_sql="DROP TABLE orders", confidence="low")
    r = c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1 FROM nope", "error": "x"}).json()
    assert r["runnable"] is False and "SELECT" in r["problem"]
    assert "fallbacks" not in fake.calls[-1]  # Haiku has no server-side fallback

    fake.stop_reason = "refusal"
    assert c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1", "error": "x"}).status_code == 422
    fake.stop_reason = "end_turn"
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    fake.raises = anthropic.AuthenticationError("bad", response=httpx.Response(401, request=req), body=None)
    r = c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1", "error": "x"})
    assert r.status_code == 400 and "API key" in r.json()["detail"]
    low = {"type": "error", "error": {"type": "invalid_request_error", "message": "Your credit balance is too low"}}
    fake.raises = anthropic.BadRequestError(
        "Your credit balance is too low", response=httpx.Response(400, request=req), body=low
    )
    r = c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1", "error": "x"})
    assert r.status_code == 402 and "out of credit" in r.json()["detail"]

    c.put("/api/ai-assist/settings", json={"enabled": False, "model": "claude-haiku-5-5"})
    assert c.post("/api/ai-assist/sql/fix", json={"sql": "SELECT 1", "error": "x"}).status_code == 409

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
from prooflix.ai_assist import AiAssistStore, RunHelp, RunReply, SqlFix
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


def _failed_run(store):
    """A failed E2E run whose bronze sub-run failed (Unity Catalog down), with a secret in the printout."""
    from prooflix.runs import Run, RunStatus, TaskRun

    child = Run(pipeline="bronze", status=RunStatus.FAILED, error="Task 'ingest' failed: Unity Catalog down")
    child.tasks["ingest"] = TaskRun(
        key="ingest", type="python", status=RunStatus.FAILED,
        error="RuntimeError: Unity Catalog is not reachable at http://localhost:8080",
        logs=["starting Spark", "password=hunter2xyz token: abc123", "sk-ant-api03-leakedkey"],
    )
    root = Run(pipeline="e2e", status=RunStatus.FAILED, parameters={"tenant_id": "tenant1"}, error="run_bronze failed")
    root.tasks["run_bronze"] = TaskRun(key="run_bronze", type="pipeline", status=RunStatus.FAILED, child_run_id=child.id)
    root.tasks["run_silver"] = TaskRun(key="run_silver", type="pipeline", status=RunStatus.SKIPPED,
                                       depends_on=["run_bronze"])
    child.parent_run_id = root.id
    child.root_run_id = root.id
    child.depth = 1
    store.save(root)
    store.save(child)
    ok = Run(pipeline="e2e", status=RunStatus.SUCCEEDED)
    store.save(ok)
    return root, ok


def test_a_failed_run_can_be_explained(client, fake):
    c = client
    root, ok = _failed_run(c.app.state.store)
    assert c.post(f"/api/ai-assist/runs/{root.id}/explain").status_code == 409  # no key yet
    c.put("/api/ai-assist/settings", json={"model": "claude-haiku-5-5", "api_key": KEY})
    fake.answer = RunHelp(diagnosis="Unity Catalog is down.", failed_task="ingest (bronze)",
                          steps=["Start Unity Catalog", " "], confidence="high")

    r = c.post(f"/api/ai-assist/runs/{root.id}/explain")
    assert r.status_code == 200
    assert r.json() | {"model": None} == {"diagnosis": "Unity Catalog is down.", "failed_task": "ingest (bronze)",
                                          "steps": ["Start Unity Catalog"], "confidence": "high", "model": None}
    sent = fake.calls[-1]["messages"][0]["content"]
    assert "Unity Catalog is not reachable" in sent and '"tenant_id": "tenant1"' in sent
    assert "run_silver (pipeline): SKIPPED, after run_bronze" in sent and "Run " + root.tasks["run_bronze"].child_run_id in sent
    assert "hunter2xyz" not in sent and "abc123" not in sent and "leakedkey" not in sent  # secrets masked

    assert c.post(f"/api/ai-assist/runs/{ok.id}/explain").status_code == 409  # only failed runs
    assert c.post("/api/ai-assist/runs/nope/explain").status_code == 404

    # Pipelines users may ask; others may not
    c.post("/api/users", json={"username": "pat", "password": GOOD, "tabs": ["pipelines"]})
    c.post("/api/users", json={"username": "sam", "password": GOOD, "tabs": ["sql"]})
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "pat", "password": GOOD})
    assert c.post(f"/api/ai-assist/runs/{root.id}/explain").status_code == 200
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "sam", "password": GOOD})
    assert c.post(f"/api/ai-assist/runs/{root.id}/explain").status_code == 403



def test_follow_up_questions_about_a_failed_run(client, fake):
    c = client
    root, ok = _failed_run(c.app.state.store)
    explanation = {"diagnosis": "Unity Catalog is down.", "failed_task": "ingest (bronze)", "steps": ["Start it"]}
    body = {"question": "How do I start it?", "explanation": explanation, "turns": []}
    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body).status_code == 409  # no key yet
    c.put("/api/ai-assist/settings", json={"model": "claude-haiku-5-5", "api_key": KEY})
    fake.answer = RunReply(answer="  Run docker start prooflix-uc.  ")

    r = c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body)
    assert r.status_code == 200 and r.json()["answer"] == "Run docker start prooflix-uc."
    msgs = fake.calls[-1]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert "Unity Catalog is not reachable" in msgs[0]["content"]  # the run is sent again
    assert "hunter2xyz" not in msgs[0]["content"]  # still masked
    assert "Unity Catalog is down." in msgs[1]["content"] and "1. Start it" in msgs[1]["content"]
    assert msgs[2]["content"] == "How do I start it?"

    # earlier turns go before the new question; secrets typed in a question are masked too
    body = {"question": "And the token=abc999?", "explanation": explanation,
            "turns": [{"question": "How do I start it?", "answer": "Run docker start prooflix-uc."}]}
    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body).status_code == 200
    msgs = fake.calls[-1]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant", "user"]
    assert msgs[3]["content"] == "Run docker start prooflix-uc." and "abc999" not in msgs[4]["content"]

    # a question before any explanation: the run and the question are one user message
    r = c.post(f"/api/ai-assist/runs/{root.id}/ask", json={"question": "Why did it fail?"})
    assert r.status_code == 200
    msgs = fake.calls[-1]["messages"]
    assert [m["role"] for m in msgs] == ["user"]
    assert msgs[0]["content"].startswith("<run>") and msgs[0]["content"].endswith("Why did it fail?")

    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body | {"question": "  "}).status_code == 422
    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body | {"question": "x" * 2001}).status_code == 413
    assert c.post(f"/api/ai-assist/runs/{ok.id}/ask", json=body).status_code == 409  # only failed runs
    assert c.post("/api/ai-assist/runs/nope/ask", json=body).status_code == 404

    # Pipelines users may ask; others may not
    c.post("/api/users", json={"username": "pat", "password": GOOD, "tabs": ["pipelines"]})
    c.post("/api/users", json={"username": "sam", "password": GOOD, "tabs": ["sql"]})
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "pat", "password": GOOD})
    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body).status_code == 200
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "sam", "password": GOOD})
    assert c.post(f"/api/ai-assist/runs/{root.id}/ask", json=body).status_code == 403


def test_general_questions_from_any_screen(client, fake):
    c = client
    body = {"question": "What is a schema?", "page": "Catalog (/catalog)"}
    assert c.post("/api/ai-assist/ask", json=body).status_code == 409  # no key yet
    c.put("/api/ai-assist/settings", json={"model": "claude-haiku-5-5", "api_key": KEY})
    fake.answer = RunReply(answer=" A folder of tables. ")

    r = c.post("/api/ai-assist/ask", json=body)
    assert r.status_code == 200 and r.json()["answer"] == "A folder of tables."
    msgs = fake.calls[-1]["messages"]
    assert [m["role"] for m in msgs] == ["user"]
    assert "<screen>Catalog (/catalog)</screen>" in msgs[0]["content"] and "error_on_screen" not in msgs[0]["content"]

    # the screen's error goes along, masked; earlier turns come first
    body = {"question": "Why?", "page": "System (/system)", "error": "Could not save: password=hunter2xyz rejected",
            "turns": [{"question": "Hi", "answer": "Hello"}]}
    assert c.post("/api/ai-assist/ask", json=body).status_code == 200
    msgs = fake.calls[-1]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert "Could not save" in msgs[2]["content"] and "hunter2xyz" not in str(msgs)
    assert "<screen>System (/system)</screen>" in msgs[2]["content"]

    assert c.post("/api/ai-assist/ask", json={"question": " "}).status_code == 422
    assert c.post("/api/ai-assist/ask", json={"question": "x" * 2001}).status_code == 413

    # any signed-in user may ask, whatever their tabs
    c.post("/api/users", json={"username": "sam", "password": GOOD, "tabs": ["sql"]})
    c.post("/api/auth/logout")
    assert c.post("/api/ai-assist/ask", json={"question": "Hi"}).status_code == 401
    c.post("/api/auth/login", json={"username": "sam", "password": GOOD})
    assert c.post("/api/ai-assist/ask", json={"question": "Hi"}).status_code == 200

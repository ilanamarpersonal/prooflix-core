"""AI Assist: Claude as an assistant inside Prooflix.

The first place it helps is the SQL editor. When a query fails, the editor offers to
ask AI Assist. Only when the user accepts are the query, the error and the catalog's
tables and columns (never their rows) sent to Claude. Claude explains the failure
and suggests a corrected query. The suggestion is checked to be one read-only
SELECT, and it runs only when the user clicks Run.

The Claude account details are secrets, so they live in
``PROOFLIX_HOME/ai_assist.json`` (mode 600) and never in a repository. An admin sets
them in the AI Assist tab. When no key is saved, the server's ``ANTHROPIC_API_KEY``
environment variable is used if it is set. The key is never sent back to the
browser: the client only sees its last four characters.
"""

from __future__ import annotations

import json
import re
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import anthropic
import duckdb
from pydantic import BaseModel, Field

from .alerts import _write_private

log = logging.getLogger(__name__)

SETTINGS_FILE = "ai_assist.json"
DEFAULT_MODEL = "claude-opus-5-5"
# model id -> (label, input $ per million tokens, output $ per million tokens).
# Anthropic's list prices (platform.claude.com pricing, November 2026); update them here when they change.
MODELS = {
    "claude-opus-5-5": ("Claude Opus 5.5 (recommended)", 4.00, 20.00),
    "claude-sonnet-5-5": ("Claude Sonnet 5.5 (faster, cheaper)", 2.00, 10.00),
    "claude-haiku-5-5": ("Claude Haiku 5.5 (fastest, cheapest)", 0.10, 0.50),
    "claude-fable-5-2": ("Claude Fable 5.2 (most capable)", 8.00, 40.00),
}
EFFORTS = ("low", "medium", "high")
# models that take the server-side refusal fallback (Haiku has none)
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TABLES = 300  # tables described to Claude; more are listed by name only
MAX_TEXT = 100_000  # characters of SQL or error text accepted


class AiAssistFileError(RuntimeError):
    """ai_assist.json exists but can't be read: refuse rather than treat it as empty."""


class AiAssistError(Exception):
    """Claude couldn't answer. ``status`` is the HTTP status to report."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class Settings(BaseModel):
    enabled: bool = True
    api_key: str = ""
    model: str = DEFAULT_MODEL
    effort: Literal["low", "medium", "high"] = "medium"
    key_saved_at: str = ""  # when the saved key was set (UTC, ISO 8601)


class AiAssistStore:
    """The Claude account settings in ``<home>/ai_assist.json`` (in memory when home is None)."""

    def __init__(self, home: Path | None):
        self.file = home / SETTINGS_FILE if home is not None else None
        self._memory = Settings()
        self._lock = threading.RLock()

    def get(self) -> Settings:
        if self.file is None:
            return self._memory.model_copy()
        try:
            data = json.loads(self.file.read_text())
            return Settings.model_validate(data)
        except FileNotFoundError:
            return Settings()
        except (OSError, ValueError) as e:
            log.error("%s can't be read: %s", self.file, e)
            raise AiAssistFileError("The AI Assist settings file can't be read; fix or remove it (see the server log)") from None

    def update(
        self,
        *,
        enabled: bool,
        model: str,
        effort: str,
        api_key: str | None = None,
        remove_key: bool = False,
    ) -> Settings:
        """Change the settings. api_key None (or empty) keeps the saved key."""
        if model not in MODELS:
            raise ValueError(f"model: one of {', '.join(MODELS)}")
        if effort not in EFFORTS:
            raise ValueError(f"effort: one of {', '.join(EFFORTS)}")
        key = (api_key or "").strip()
        if key and (len(key) < 20 or len(key) > 500 or any(c.isspace() for c in key)):
            raise ValueError("api_key: this doesn't look like a Claude API key")
        with self._lock:
            current = self.get()
            new_key = "" if remove_key else (key or current.api_key)
            if remove_key:
                saved_at = ""
            elif key:
                saved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            else:
                saved_at = current.key_saved_at
            s = Settings(enabled=enabled, model=model, effort=effort, api_key=new_key, key_saved_at=saved_at)
            if self.file is None:
                self._memory = s
            else:
                _write_private(self.file, s.model_dump())
            return s


def env_key() -> str:
    import os

    return os.environ.get("ANTHROPIC_API_KEY", "").strip()


def key_of(s: Settings) -> tuple[str, Literal["saved", "environment", "none"]]:
    if s.api_key:
        return s.api_key, "saved"
    if env_key():
        return env_key(), "environment"
    return "", "none"


def _key_prefix(key: str) -> str:
    """The key's kind, e.g. "sk-ant-api03": not secret, and tells keys apart."""
    parts = key.split("-")
    prefix = "-".join(parts[:3])
    return prefix if key.startswith("sk-ant-") and len(parts) > 3 and len(prefix) <= 14 else ""


def public(s: Settings) -> dict:
    """The settings as the browser may see them: never the key itself."""
    key, source = key_of(s)
    return {
        "enabled": s.enabled,
        "model": s.model,
        "effort": s.effort,
        "key_source": source,
        "key_hint": f"…{key[-4:]}" if key else None,
        "key_prefix": _key_prefix(key) if key else None,
        "key_saved_at": (s.key_saved_at or None) if source == "saved" else None,
        "ready": s.enabled and bool(key),
        "models": [
            {"id": k, "label": label, "input_price": inp, "output_price": out}
            for k, (label, inp, out) in MODELS.items()
        ],
    }


def _client(s: Settings) -> anthropic.Anthropic:
    key, _ = key_of(s)
    if not s.enabled:
        raise AiAssistError("AI Assist is turned off; an admin can turn it on in the AI Assist tab", 409)
    if not key:
        raise AiAssistError("AI Assist has no Claude API key yet; an admin can add one in the AI Assist tab", 409)
    return anthropic.Anthropic(api_key=key, timeout=120.0, max_retries=2)


def _out_of_credit(e: Exception) -> bool:
    """The API refuses requests once the prepaid credit is used up (a 400 naming the balance, or a 402)."""
    if not isinstance(e, anthropic.APIStatusError):
        return False
    return e.status_code == 402 or (e.status_code == 400 and "credit balance" in str(e).lower())


def _api_error(e: Exception) -> AiAssistError:
    if isinstance(e, anthropic.AuthenticationError):
        return AiAssistError("Claude rejected the API key; check it in the AI Assist tab", 400)
    if _out_of_credit(e):
        return AiAssistError("The Claude account is out of credit; add credit in the Claude Console (Billing)", 402)
    if isinstance(e, anthropic.PermissionDeniedError):
        return AiAssistError("This API key isn't allowed to use the chosen model", 400)
    if isinstance(e, anthropic.NotFoundError):
        return AiAssistError("Claude doesn't know the chosen model; pick another in the AI Assist tab", 400)
    if isinstance(e, anthropic.RateLimitError):
        return AiAssistError("Claude's rate limit was reached; try again in a minute", 429)
    if isinstance(e, anthropic.APIStatusError):
        return AiAssistError(f"Claude answered with an error ({e.status_code}); try again", 502)
    if isinstance(e, anthropic.APIConnectionError):
        return AiAssistError("Claude can't be reached from the server; check its internet access", 502)
    return AiAssistError("Claude couldn't answer; see the server log", 502)


def test_connection(s: Settings) -> dict:
    """Check that the key works and can see the chosen model (no tokens are used)."""
    client = _client(s)
    try:
        model = client.models.retrieve(s.model)
    except anthropic.APIError as e:
        raise _api_error(e) from None
    return {"ok": True, "model": model.id, "display_name": model.display_name}


# ------------------------------------------------------------------ SQL editor
class SqlFix(BaseModel):
    """Claude's answer about a failed query."""

    diagnosis: str = Field(description="Why the query failed, in one to three plain sentences for the user.")
    explanation: str = Field(description="What the corrected query changes and why. Empty when there is no fix.")
    fixed_sql: str = Field(description="The complete corrected query, one DuckDB SELECT. Empty when it can't be fixed.")
    confidence: Literal["high", "medium", "low"]


SQL_SYSTEM = """You are AI Assist, the assistant built into Prooflix, a data platform. \
You help in its SQL editor. The editor runs read-only DuckDB SQL over Parquet and \
Delta tables in a catalog. Only one SELECT statement (WITH ... SELECT is fine) runs \
at a time; there is no INSERT, UPDATE, DDL, COPY, ATTACH or file access.

A user's query just failed. You get the query, DuckDB's error and the catalog's \
tables with their columns and types. Find the cause and write a corrected query that \
does what the user meant:
- Use only tables and columns that are in the catalog list, written as listed \
(qualified names such as schema.table, quoted with "" when needed).
- Keep the user's intent, formatting and comments; change only what the fix needs.
- Use DuckDB syntax and functions.
- If the intent is unclear, pick the most likely meaning and say which you chose. \
If the query can't be fixed (for example, the data it needs isn't in the catalog), \
leave fixed_sql empty and explain why in diagnosis.
Write diagnosis and explanation for a data analyst: short and plain, no preamble."""


def _catalog_text(tables: list[dict]) -> str:
    lines = []
    for t in tables[:MAX_TABLES]:
        cols = ", ".join(f"{c['name']} {c['type']}" for c in t["columns"])
        lines.append(f"- {t['qualified']} ({t.get('row_count', '?')} rows): {cols}")
    if len(tables) > MAX_TABLES:
        rest = ", ".join(t["qualified"] for t in tables[MAX_TABLES:])
        lines.append(f"(columns not listed for the other {len(tables) - MAX_TABLES} tables: {rest})")
    return "\n".join(lines) or "(the catalog has no tables)"


def check_select(sql: str) -> str | None:
    """None when sql is one read-only SELECT, else the reason it isn't."""
    conn = duckdb.connect(":memory:")
    try:
        statements = conn.extract_statements(sql)
    except duckdb.Error as e:
        return f"It doesn't parse: {str(e).splitlines()[0]}"
    finally:
        conn.close()
    if len(statements) != 1:
        return "It isn't exactly one statement"
    if statements[0].type != duckdb.StatementType.SELECT:
        return "It isn't a read-only SELECT"
    return None


def _ask(client: anthropic.Anthropic, s: Settings, system: str, prompt: str, output_format: type[BaseModel]):
    """One request to Claude whose answer must match ``output_format``; errors become AiAssistError."""
    extra: dict = {}
    if s.model in FALLBACK_MODELS:
        extra = {"betas": [FALLBACK_BETA], "fallbacks": "default"}
    try:
        response = client.beta.messages.parse(
            model=s.model,
            max_tokens=16000,
            system=system,
            output_config={"effort": s.effort},
            messages=[{"role": "user", "content": prompt}],
            output_format=output_format,
            **extra,
        )
    except anthropic.APIError as e:
        log.warning("AI Assist request failed: %s", type(e).__name__)
        raise _api_error(e) from None
    if response.stop_reason == "refusal":
        raise AiAssistError("Claude declined to answer this one", 422)
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise AiAssistError("Claude's answer was cut off; try again", 502)
    return response


def suggest_sql_fix(s: Settings, sql: str, error: str, tables: list[dict]) -> dict:
    """Ask Claude why the query failed and for a corrected one."""
    if not sql.strip():
        raise AiAssistError("There is no query to look at", 422)
    if len(sql) > MAX_TEXT or len(error) > MAX_TEXT:
        raise AiAssistError("The query or error is too long to send (100,000 characters at most)", 413)
    client = _client(s)
    prompt = (
        f"<catalog>\n{_catalog_text(tables)}\n</catalog>\n\n"
        f"<query>\n{sql}\n</query>\n\n"
        f"<error>\n{error.strip() or '(no error text)'}\n</error>"
    )
    response = _ask(client, s, SQL_SYSTEM, prompt, SqlFix)
    fix: SqlFix = response.parsed_output
    fixed = fix.fixed_sql.strip().rstrip(";").strip()
    problem = check_select(fixed) if fixed else None
    return {
        "diagnosis": fix.diagnosis,
        "explanation": fix.explanation,
        "fixed_sql": fixed,
        "confidence": fix.confidence,
        "runnable": bool(fixed) and problem is None,
        "problem": problem,
        "model": response.model,
    }


# ------------------------------------------------------------------ failed runs
class RunHelp(BaseModel):
    """Claude's answer about a failed pipeline run."""

    diagnosis: str = Field(description="What went wrong, in one to three plain sentences for the user.")
    failed_task: str = Field(description="The task where the failure started, as task (pipeline). Empty if unclear.")
    steps: list[str] = Field(description="What the user should do to fix it, in order; short imperative sentences.")
    confidence: Literal["high", "medium", "low"]


RUN_SYSTEM = """You are AI Assist, the assistant built into Prooflix, a data platform. \
Prooflix orchestrates pipelines: each pipeline is a DAG of tasks (Python functions in \
the workspace, shell commands, or sub-pipelines), and the data work runs in Spark, \
with Delta tables registered in Unity Catalog. A run can start sub-pipeline runs.

A pipeline run just failed. You get the run, its parameters, and for every task its \
status, error and the last lines it printed, including the runs of its sub-pipelines. \
Find where the failure started (later tasks are often only skipped because of it) and \
tell the user how to fix it:
- Separate the root cause from its consequences.
- Name concrete actions: a service to start, a setting or parameter to change, a \
file or task to fix. Say where in Prooflix to do it when you can tell (Pipelines, \
Workspace, System, Ingestion tabs). Don't invent settings, files or commands you can't \
see evidence for; when unsure, say what to check.
- If the cause can't be found from what you're given, say so and say what to look at next.
Write for a data engineer: short and plain, no preamble."""

MAX_LOG_LINES = 40  # last lines of each task's printout sent to Claude
MAX_LINE = 500  # characters per printed line
_SECRET = re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)(\S+)")
_ANTHROPIC_KEY = re.compile(r"sk-ant-[A-Za-z0-9_-]+")


def _redact(text: str) -> str:
    """Hide values that look like secrets before anything is sent (task printouts can contain anything)."""
    return _ANTHROPIC_KEY.sub("sk-ant-********", _SECRET.sub(r"\1\2********", text))


def _run_text(node: dict, indent: str = "") -> list[str]:
    """A run tree (``RunStore.tree``) as plain text: the run, then each task, then its sub-run nested."""
    lines = [f"{indent}Run {node['id']} of pipeline {node['pipeline']}: {node['status']}"]
    if node.get("parameters"):
        lines.append(f"{indent}  parameters: {json.dumps(node['parameters'], default=str)}")
    if node.get("error"):
        lines.append(f"{indent}  error: {node['error']}")
    children = {c["id"]: c for c in node.get("children", []) if c}
    for key, task in node.get("tasks", {}).items():
        head = f"{indent}  - task {key} ({task['type']}): {task['status']}"
        if task.get("max_attempts", 1) > 1:
            head += f", attempt {task.get('attempt')} of {task['max_attempts']}"
        if task.get("depends_on"):
            head += f", after {', '.join(task['depends_on'])}"
        lines.append(head)
        if task.get("error"):
            lines.append(f"{indent}      error: {task['error']}")
        printed = task.get("logs") or []
        if printed:
            lines.append(f"{indent}      printed (last {min(len(printed), MAX_LOG_LINES)} of {len(printed)} lines):")
            lines += [f"{indent}        {line[:MAX_LINE]}" for line in printed[-MAX_LOG_LINES:]]
        child = children.get(task.get("child_run_id") or "")
        if child:
            lines += _run_text(child, indent + "      ")
    return lines


def explain_run(s: Settings, tree: dict) -> dict:
    """Ask Claude why the run failed and what to do about it. Nothing is changed or re-run here."""
    if tree.get("status") != "FAILED":
        raise AiAssistError("Only a failed run can be looked at", 409)
    text = _redact("\n".join(_run_text(tree)))
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + "\n(cut off: the run is too long to send in full)"
    client = _client(s)
    response = _ask(client, s, RUN_SYSTEM, f"<run>\n{text}\n</run>", RunHelp)
    help_: RunHelp = response.parsed_output
    return {
        "diagnosis": help_.diagnosis,
        "failed_task": help_.failed_task,
        "steps": [step for step in help_.steps if step.strip()],
        "confidence": help_.confidence,
        "model": response.model,
    }

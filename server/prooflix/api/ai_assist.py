"""``/api/ai-assist`` routes: the Claude account settings (admins), the SQL editor's
"ask AI Assist" for a failed query (users of the SQL tab) and the same for a failed
pipeline run, with follow-up questions (users of the Pipelines and Ingestion tabs)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .. import ai_assist
from ..ai_assist import AiAssistError, AiAssistStore
from ..runs import RunStore
from ..pipelines import Workspace
from .deps import CatalogPaths, get_catalog_paths, get_store, get_workspace
from .sql import _describe, _described_tables

router = APIRouter(prefix="/api/ai-assist", tags=["ai-assist"])


def _store(request: Request) -> AiAssistStore:
    return request.app.state.ai_assist


def _fail(e: AiAssistError) -> HTTPException:
    return HTTPException(e.status, str(e))


@router.get("/status")
def ai_assist_status(request: Request) -> dict:
    """Whether AI Assist can answer, for any signed-in user (no account details)."""
    p = ai_assist.public(_store(request).get())
    return {"ready": p["ready"], "enabled": p["enabled"], "model": p["model"]}


class SettingsIn(BaseModel):
    enabled: bool = True
    model: str = ai_assist.DEFAULT_MODEL
    effort: str = "medium"
    api_key: str | None = None  # None or "": keep the saved key
    remove_key: bool = False


@router.get("/settings")
def get_settings(request: Request) -> dict:
    return ai_assist.public(_store(request).get())


@router.put("/settings")
def save_settings(body: SettingsIn, request: Request) -> dict:
    try:
        s = _store(request).update(
            enabled=body.enabled,
            model=body.model,
            effort=body.effort,
            api_key=body.api_key,
            remove_key=body.remove_key,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    return ai_assist.public(s)


@router.post("/settings/test")
def test_settings(request: Request) -> dict:
    try:
        return ai_assist.test_connection(_store(request).get())
    except AiAssistError as e:
        raise _fail(e) from None


class SqlFixIn(BaseModel):
    sql: str = Field(..., min_length=1)
    error: str = ""


@router.post("/sql/fix")
def sql_fix(body: SqlFixIn, request: Request, paths: CatalogPaths = Depends(get_catalog_paths)) -> dict:
    """Send the failed query, its error and the catalog's tables and columns (no rows) to
    Claude; return its diagnosis and a corrected query. Nothing is run here."""
    tables = [t.model_dump(by_alias=True) for t in _describe(_described_tables(paths))]
    try:
        return ai_assist.suggest_sql_fix(_store(request).get(), body.sql, body.error, tables)
    except AiAssistError as e:
        raise _fail(e) from None


class RunExplanationIn(BaseModel):
    diagnosis: str = Field("", max_length=ai_assist.MAX_TEXT)
    failed_task: str = Field("", max_length=1_000)
    steps: list[str] = Field(default_factory=list, max_length=50)


class RunTurn(BaseModel):
    question: str = Field(..., max_length=ai_assist.MAX_QUESTION)
    answer: str = Field("", max_length=ai_assist.MAX_TEXT)


class RunQuestionIn(BaseModel):
    question: str = Field(..., min_length=1)
    explanation: RunExplanationIn | None = None  # what AI Assist answered first (from /explain), if asked
    turns: list[RunTurn] = Field(default_factory=list, max_length=100)  # earlier questions and answers


class GeneralQuestionIn(BaseModel):
    question: str = Field(..., min_length=1)
    page: str = Field("", max_length=ai_assist.MAX_PAGE)  # the screen asked from, e.g. "Catalog (/catalog)"
    error: str = ""  # the error the screen shows, if any
    turns: list[RunTurn] = Field(default_factory=list, max_length=100)


@router.post("/ask")
def ask_general(body: GeneralQuestionIn, request: Request) -> dict:
    """A question from the AI Assist panel on any screen (any signed-in user): the screen's
    name, the error it shows and the earlier questions and answers go with it, secrets
    masked. No data, files or runs are sent; nothing is changed or run."""
    try:
        return ai_assist.ask_general(
            _store(request).get(), body.page, body.error, [t.model_dump() for t in body.turns], body.question
        )
    except AiAssistError as e:
        raise _fail(e) from None


class SettingsFixIn(BaseModel):
    page: str = Field("", max_length=ai_assist.MAX_PAGE)
    error: str = ""
    turns: list[RunTurn] = Field(default_factory=list, max_length=100)


@router.post("/fix")
def propose_settings_fix(body: SettingsFixIn, request: Request) -> dict:
    """Setting changes (and manual steps) that would fix the problem shown on a screen, for the user
    to review: ``{summary, changes: [{name, current, value, reason, live}], steps, model}``. Sends the
    screen's name, its error, the conversation and the System tab's parameters without secrets.
    Nothing is saved: the client applies each change with ``PUT /api/system/parameters/{name}``
    and then restarts. Needs the System tab when users are on."""
    if request.app.state.settings.auth:
        user = getattr(request.state, "user", None)
        if user is None or not (user.role == "admin" or "system" in user.tabs):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Fixing this changes server settings; it needs the System tab, ask an admin"
            )
    from .system import _boot, _list  # the System tab's own view of the parameters

    params = [p.model_dump() for p in _list(request.app.state.settings, _boot(request))]
    try:
        return ai_assist.propose_settings_fix(
            _store(request).get(), body.page, body.error, [t.model_dump() for t in body.turns], params
        )
    except AiAssistError as e:
        raise _fail(e) from None


@router.post("/runs/{run_id}/ask")
def ask_about_run(
    run_id: str, body: RunQuestionIn, request: Request, store: RunStore = Depends(get_store)
) -> dict:
    """A question about a failed run, with or without its explanation first: the run is sent
    again (secrets masked), with the explanation and the earlier questions and answers. Returns
    Claude's answer. Nothing is changed or re-run."""
    tree = store.tree(run_id)
    if tree is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run '{run_id}' not found")
    try:
        return ai_assist.ask_about_run(
            _store(request).get(),
            tree,
            body.explanation.model_dump() if body.explanation else None,
            [t.model_dump() for t in body.turns],
            body.question,
        )
    except AiAssistError as e:
        raise _fail(e) from None


class RunFixIn(BaseModel):
    explanation: RunExplanationIn | None = None  # what AI Assist answered first, if asked


def _require_workspace_tab(request: Request) -> None:
    """A fix changes workspace code: with users on, only users with the Workspace tab (or admins)."""
    if not request.app.state.settings.auth:
        return
    user = getattr(request.state, "user", None)
    if user is None or not (user.role == "admin" or "workspace" in user.tabs):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Fixing a run changes workspace files; it needs the Workspace tab, ask an admin"
        )


@router.post("/runs/{run_id}/fix")
def propose_run_fix(
    run_id: str,
    body: RunFixIn,
    request: Request,
    store: RunStore = Depends(get_store),
    ws: Workspace = Depends(get_workspace),
) -> dict:
    """Changes to the workspace files behind a failed run that would fix it, for the user to
    review: ``{summary, changes: [{path, reason, before, after, modified, problems}], model}``.
    Sends the run (masked), its pipelines' YAML and the Python files their tasks call (files
    that look like they hold secrets are left out). Nothing is saved here: the user applies a
    change with ``PUT /api/workspace/file`` (``modified`` refuses it if the file changed since).
    Needs the Workspace tab when users are on."""
    _require_workspace_tab(request)
    tree = store.tree(run_id)
    if tree is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run '{run_id}' not found")
    files = ai_assist.fix_files(ws, tree)
    try:
        result = ai_assist.propose_run_fix(
            _store(request).get(), tree, body.explanation.model_dump() if body.explanation else None, files
        )
    except AiAssistError as e:
        raise _fail(e) from None
    # each change's file version (for the save's conflict check) and, for a pipeline, the validator's verdict
    ids = {(ws.path_for(pid) or ws.root).resolve(): pid for pid in ws.list_ids()}
    for change in result["changes"]:
        target = (ws.root / change["path"]).resolve()
        change["modified"] = target.stat().st_mtime
        pid = ids.get(target)
        change["problems"] = ws.validate_source(pid, change["after"]) if pid else []
    return result


@router.post("/runs/{run_id}/explain")
def explain_run(run_id: str, request: Request, store: RunStore = Depends(get_store)) -> dict:
    """Send the failed run, its tasks' errors and the last lines they printed (secrets masked)
    to Claude; return its diagnosis and the steps to fix it. Nothing is changed or re-run."""
    tree = store.tree(run_id)
    if tree is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run '{run_id}' not found")
    try:
        return ai_assist.explain_run(_store(request).get(), tree)
    except AiAssistError as e:
        raise _fail(e) from None

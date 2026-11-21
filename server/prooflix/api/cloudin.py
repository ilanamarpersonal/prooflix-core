"""``/api/cloudin`` routes: the Claude account settings (admins) and the SQL editor's
"ask Cloudin" for a failed query (users of the SQL tab)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .. import cloudin
from ..cloudin import CloudinError, CloudinStore
from .deps import CatalogPaths, get_catalog_paths
from .sql import _describe, _described_tables

router = APIRouter(prefix="/api/cloudin", tags=["cloudin"])


def _store(request: Request) -> CloudinStore:
    return request.app.state.cloudin


def _fail(e: CloudinError) -> HTTPException:
    return HTTPException(e.status, str(e))


@router.get("/status")
def cloudin_status(request: Request) -> dict:
    """Whether Cloudin can answer, for any signed-in user (no account details)."""
    p = cloudin.public(_store(request).get())
    return {"ready": p["ready"], "enabled": p["enabled"], "model": p["model"]}


class SettingsIn(BaseModel):
    enabled: bool = True
    model: str = cloudin.DEFAULT_MODEL
    effort: str = "medium"
    api_key: str | None = None  # None or "": keep the saved key
    remove_key: bool = False


@router.get("/settings")
def get_settings(request: Request) -> dict:
    return cloudin.public(_store(request).get())


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
    return cloudin.public(s)


@router.post("/settings/test")
def test_settings(request: Request) -> dict:
    try:
        return cloudin.test_connection(_store(request).get())
    except CloudinError as e:
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
        return cloudin.suggest_sql_fix(_store(request).get(), body.sql, body.error, tables)
    except CloudinError as e:
        raise _fail(e) from None

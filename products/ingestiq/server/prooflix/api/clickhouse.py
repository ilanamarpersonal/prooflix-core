"""``/api/clickhouse`` routes: copy gold tables into ClickHouse (the ClickHouse tab)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ..clickhouse import ClickHouse, ClickHouseError, columns, copy_table
from .deps import CatalogPaths, get_catalog_paths
from .sql import find_tables

router = APIRouter(prefix="/api/clickhouse", tags=["clickhouse"])


class ClickHouseTable(BaseModel):
    database: str
    name: str
    rows: int | None
    bytes: int | None


class ClickHouseStatus(BaseModel):
    configured: bool
    reachable: bool
    url: str | None  # where Prooflix writes
    public_url: str | None  # where people outside connect
    reader: str | None  # the read-only user they use
    version: str | None
    error: str | None
    tables: list[ClickHouseTable]


class GoldColumn(BaseModel):
    name: str
    clickhouse_type: str


class GoldTable(BaseModel):
    table: str  # "tenant1.gold.agg_transactions_per_date"
    target: str  # the ClickHouse table it becomes: "tenant1.agg_transactions_per_date"
    rows: int
    columns: list[GoldColumn]
    error: str | None = None  # a column type ClickHouse can't hold


class ImportBody(BaseModel):
    tables: list[str]


class ImportResult(BaseModel):
    table: str
    target: str | None
    ok: bool
    rows: int | None = None
    columns: int | None = None
    replaced: bool | None = None
    seconds: float | None = None
    error: str | None = None


def _client(request: Request) -> ClickHouse | None:
    s = request.app.state.settings
    if not s.clickhouse_url:
        return None
    return ClickHouse(s.clickhouse_url, s.clickhouse_user, s.clickhouse_password)


def _gold_tables(paths: CatalogPaths):
    """Tables of every schema named gold (tenant1.gold, or gold)."""
    return [t for t in find_tables(paths) if (t.schema[len(t.catalog) + 1:] if t.catalog else t.schema) == "gold"]


def _target(t) -> tuple[str, str]:
    return (t.catalog or "default", t.name)


@router.get("/status", response_model=ClickHouseStatus)
def clickhouse_status(request: Request) -> ClickHouseStatus:
    s = request.app.state.settings
    ch = _client(request)
    base = dict(configured=ch is not None, url=s.clickhouse_url,
                public_url=s.clickhouse_public_url or s.clickhouse_url, reader=s.clickhouse_reader)
    if ch is None:
        return ClickHouseStatus(**base, reachable=False, version=None, error=None, tables=[])
    try:
        return ClickHouseStatus(**base, reachable=True, version=ch.version(), error=None,
                                tables=[ClickHouseTable(**t) for t in ch.tables()])
    except ClickHouseError as e:
        return ClickHouseStatus(**base, reachable=False, version=None, error=str(e), tables=[])


@router.get("/gold-tables", response_model=list[GoldTable])
def gold_tables(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[GoldTable]:
    out = []
    for t in _gold_tables(paths):
        database, name = _target(t)
        try:
            cols = [GoldColumn(name=n, clickhouse_type=ty) for n, ty in columns(t.files)]
            error = None
        except (ClickHouseError, Exception) as e:  # noqa: BLE001 - shown next to the table
            cols, error = [], str(e)
        out.append(GoldTable(table=f"{t.schema}.{t.name}", target=f"{database}.{name}",
                             rows=t.row_count, columns=cols, error=error))
    return out


@router.post("/import", response_model=list[ImportResult])
def import_tables(body: ImportBody, request: Request,
                  paths: CatalogPaths = Depends(get_catalog_paths)) -> list[ImportResult]:
    """Copy the chosen gold tables into ClickHouse, one after the other.

    Each table is replaced as a whole: a table that fails keeps its previous copy,
    and the others are still copied.
    """
    ch = _client(request)
    if ch is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "ClickHouse is not configured (PROOFLIX_CLICKHOUSE_URL)")
    if not body.tables:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose at least one table")
    by_name = {f"{t.schema}.{t.name}": t for t in _gold_tables(paths)}
    results = []
    for name in body.tables:
        t = by_name.get(name)
        if t is None:
            results.append(ImportResult(table=name, target=None, ok=False, error="not a gold table"))
            continue
        database, table = _target(t)
        try:
            results.append(ImportResult(table=name, ok=True, **copy_table(ch, t.files, database, table)))
        except (ClickHouseError, OSError, ValueError) as e:
            results.append(ImportResult(table=name, target=f"{database}.{table}", ok=False, error=str(e)))
    return results

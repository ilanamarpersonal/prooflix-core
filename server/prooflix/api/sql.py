"""``/api/sql`` routes: run SQL over the workspace's data files.

Every CSV and JSON file under ``workspace/data/`` (schema ``main``) and each
project's ``data/`` folder (a schema named after the project) is loaded into a fresh
in-memory SQLite database for each request, one table per file. The database
is read only and thrown away afterwards, so queries never change the files.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..pipelines import Workspace
from .deps import get_workspace

router = APIRouter(prefix="/api/sql", tags=["sql"])

QUERY_TIMEOUT_S = 10.0
MAX_ROWS = 10_000


class SqlColumn(BaseModel):
    name: str
    type: str


class SqlTable(BaseModel):
    name: str  # table name inside its schema
    schema_name: str = Field(serialization_alias="schema")  # "main" or a project's schema
    qualified: str  # how to write it in SQL: "orders" in main, "my_project.orders" otherwise
    source: str  # file path relative to the workspace
    row_count: int
    columns: list[SqlColumn]


class CatalogSchema(BaseModel):
    name: str
    project: str  # project folder relative to the workspace; "" for the workspace's own data
    data_dir: str | None  # the folder its tables come from, relative to the workspace
    tables: list[SqlTable]


class SqlQueryIn(BaseModel):
    sql: str = Field(..., min_length=1)
    limit: int = Field(1000, ge=1, le=MAX_ROWS)


class SqlResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    elapsed_ms: float


@dataclass
class _Loaded:
    schema: str
    name: str
    source: str
    columns: list[str]
    rows: list[list[Any]]

    @property
    def qualified(self) -> str:
        return self.name if self.schema == MAIN else f"{self.schema}.{self.name}"


MAIN = "main"


# ------------------------------------------------------------------ loading
def table_name(rel: Path) -> str:
    """``output/2026-11-07/clean_orders.json`` -> ``output_2026_11_07_clean_orders``."""
    name = re.sub(r"[^0-9a-zA-Z]+", "_", rel.with_suffix("").as_posix()).strip("_").lower()
    return name if name and not name[0].isdigit() else f"t_{name}"


def _cell(value: Any) -> Any:
    """Store numbers as numbers, nested values as JSON text, blanks as NULL."""
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, (int, float)):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    text = str(value)
    if text.strip() == "":
        return None
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            pass
    return text


def _from_records(records: list[dict]) -> tuple[list[str], list[list[Any]]]:
    columns: list[str] = []
    for rec in records:
        for key in rec:
            if key not in columns:
                columns.append(key)
    return columns, [[_cell(rec.get(c)) for c in columns] for rec in records]


def _load_file(path: Path) -> tuple[list[str], list[list[Any]]] | None:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if not header:
                return None
            return [h.strip() for h in header], [
                [_cell(v) for v in row] + [None] * (len(header) - len(row)) for row in reader
            ]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if isinstance(data, dict):
        data = [data]
    if isinstance(data, list) and data and all(isinstance(r, dict) for r in data):
        return _from_records(data)
    return None


def schema_name(project_folder: str) -> str:
    """``prooflix-test`` -> ``prooflix_test`` (a SQL identifier)."""
    name = re.sub(r"[^0-9a-zA-Z]+", "_", project_folder).strip("_").lower()
    name = name if name and not name[0].isdigit() else f"s_{name}"
    return f"{name}_" if name in (MAIN, "temp") else name


def schemas(workspace_root: Path) -> list[tuple[str, str, Path]]:
    """(schema, project folder, data dir) for the workspace and each project.

    The workspace's own ``data/`` is the ``main`` schema, so its tables need no
    prefix in SQL. Each imported project is a schema named after its folder:
    ``my-project/data/orders.csv`` is ``my_project.orders``.
    """
    out = [(MAIN, "", workspace_root / "data")]
    taken = {MAIN}
    for project in Workspace(workspace_root).projects():
        if project == workspace_root:
            continue
        name = schema_name(project.name)
        while name in taken:
            name += "_"
        taken.add(name)
        out.append((name, project.name, project / "data"))
    return out


def load_tables(workspace_root: Path) -> list[_Loaded]:
    tables: list[_Loaded] = []
    for schema, _project, data_dir in schemas(workspace_root):
        if data_dir.is_dir():
            _load_dir(workspace_root, data_dir, schema, tables)
    return tables


def _load_dir(workspace_root: Path, data_dir: Path, schema: str, tables: list[_Loaded]) -> None:
    seen: set[str] = set()
    for path in sorted(data_dir.rglob("*")):
        rel = path.relative_to(data_dir)
        if (
            not path.is_file()
            or path.suffix.lower() not in (".csv", ".json")
            or any(p.startswith(".") for p in rel.parts)
        ):
            continue
        loaded = _load_file(path)
        if loaded is None:
            continue
        name = table_name(rel)
        while name in seen:
            name += "_"
        seen.add(name)
        tables.append(
            _Loaded(schema, name, path.relative_to(workspace_root).as_posix(), loaded[0], loaded[1])
        )


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _deny_attach(action: int, *_args: Any) -> int:
    # ATTACH could create database files on disk; nothing else needs blocking
    # because the database itself is in memory and set to query_only.
    return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK


def open_database(workspace_root: Path) -> tuple[sqlite3.Connection, list[_Loaded]]:
    tables = load_tables(workspace_root)
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    # One in-memory database per project schema, attached before ATTACH is denied.
    for schema in sorted({t.schema for t in tables} - {MAIN}):
        conn.execute(f"ATTACH DATABASE ':memory:' AS {_quote(schema)}")
    for t in tables:
        target = f"{_quote(t.schema)}.{_quote(t.name)}"
        cols = ", ".join(_quote(c or f"column_{i + 1}") for i, c in enumerate(t.columns))
        conn.execute(f"CREATE TABLE {target} ({cols})")
        if t.rows:
            marks = ", ".join("?" * len(t.columns))
            conn.executemany(
                f"INSERT INTO {target} VALUES ({marks})",
                [row[: len(t.columns)] for row in t.rows],
            )
    conn.commit()
    conn.execute("PRAGMA query_only = ON")
    conn.set_authorizer(_deny_attach)
    return conn, tables


# ------------------------------------------------------------------ routes
def _describe(tables: list[_Loaded]) -> list[SqlTable]:
    out = []
    for t in tables:
        sample = t.rows[:200]
        columns = []
        for i, c in enumerate(t.columns):
            kinds = {type(r[i]).__name__ for r in sample if i < len(r) and r[i] is not None}
            kind = (
                "INTEGER" if kinds == {"int"}
                else "REAL" if kinds and kinds <= {"int", "float"}
                else "TEXT"
            )
            columns.append(SqlColumn(name=c or f"column_{i + 1}", type=kind))
        out.append(
            SqlTable(
                name=t.name,
                schema_name=t.schema,
                qualified=t.qualified,
                source=t.source,
                row_count=len(t.rows),
                columns=columns,
            )
        )
    return out


@router.get("/tables", response_model=list[SqlTable], response_model_by_alias=True)
def list_tables(ws: Workspace = Depends(get_workspace)) -> list[SqlTable]:
    return _describe(load_tables(ws.root))


catalog_router = APIRouter(prefix="/api/catalog", tags=["catalog"])


@catalog_router.get("", response_model=list[CatalogSchema], response_model_by_alias=True)
def catalog(ws: Workspace = Depends(get_workspace)) -> list[CatalogSchema]:
    """Schemas (the workspace's ``main`` and one per project) and their tables.

    ``main`` is listed only when the workspace has its own ``data/`` folder;
    every project is listed, even without data, so it's clear where to add it.
    """
    root = ws.root.resolve()
    described = _describe(load_tables(root))
    out = []
    for schema, project, data_dir in schemas(root):
        if schema == MAIN and not data_dir.is_dir():
            continue
        out.append(
            CatalogSchema(
                name=schema,
                project=project,
                data_dir=data_dir.relative_to(root).as_posix() if data_dir.is_dir() else None,
                tables=[t for t in described if t.schema_name == schema],
            )
        )
    return out


@router.post("/query", response_model=SqlResult)
def run_query(body: SqlQueryIn, ws: Workspace = Depends(get_workspace)) -> SqlResult:
    conn, _ = open_database(ws.root)
    started = time.perf_counter()
    deadline = started + QUERY_TIMEOUT_S
    conn.set_progress_handler(lambda: 1 if time.perf_counter() > deadline else 0, 10_000)
    try:
        cur = conn.execute(body.sql)
        columns = [d[0] for d in cur.description or []]
        fetched = cur.fetchmany(body.limit + 1) if columns else []
    except sqlite3.Error as exc:
        message = str(exc)
        if message == "interrupted":
            message = f"Query took longer than {QUERY_TIMEOUT_S:g} seconds and was stopped"
        elif "readonly" in message or "not authorized" in message:
            message = "The SQL editor is read only: only queries that read data are allowed"
        raise HTTPException(status.HTTP_400_BAD_REQUEST, message) from exc
    except sqlite3.Warning as exc:  # e.g. more than one statement
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    finally:
        elapsed = (time.perf_counter() - started) * 1000
        conn.close()
    rows = [list(r) for r in fetched[: body.limit]]
    return SqlResult(
        columns=columns,
        rows=rows,
        row_count=len(rows),
        truncated=len(fetched) > body.limit,
        elapsed_ms=round(elapsed, 1),
    )

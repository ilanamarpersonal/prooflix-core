"""``/api/sql`` routes: run SQL over the workspace's data files.

Every CSV and JSON file under ``workspace/data/`` is loaded into a fresh
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
    name: str
    source: str  # file path relative to the workspace
    row_count: int
    columns: list[SqlColumn]


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
    name: str
    source: str
    columns: list[str]
    rows: list[list[Any]]


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


def load_tables(workspace_root: Path) -> list[_Loaded]:
    data_dir = workspace_root / "data"
    if not data_dir.is_dir():
        return []
    tables: list[_Loaded] = []
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
            _Loaded(name, path.relative_to(workspace_root).as_posix(), loaded[0], loaded[1])
        )
    return tables


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _deny_attach(action: int, *_args: Any) -> int:
    # ATTACH could create database files on disk; nothing else needs blocking
    # because the database itself is in memory and set to query_only.
    return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK


def open_database(workspace_root: Path) -> tuple[sqlite3.Connection, list[_Loaded]]:
    tables = load_tables(workspace_root)
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    for t in tables:
        cols = ", ".join(_quote(c or f"column_{i + 1}") for i, c in enumerate(t.columns))
        conn.execute(f"CREATE TABLE {_quote(t.name)} ({cols})")
        if t.rows:
            marks = ", ".join("?" * len(t.columns))
            conn.executemany(
                f"INSERT INTO {_quote(t.name)} VALUES ({marks})",
                [row[: len(t.columns)] for row in t.rows],
            )
    conn.commit()
    conn.execute("PRAGMA query_only = ON")
    conn.set_authorizer(_deny_attach)
    return conn, tables


# ------------------------------------------------------------------ routes
@router.get("/tables", response_model=list[SqlTable])
def list_tables(ws: Workspace = Depends(get_workspace)) -> list[SqlTable]:
    conn, tables = open_database(ws.root)
    try:
        out = []
        for t in tables:
            info = conn.execute(f"SELECT * FROM {_quote(t.name)} LIMIT 200").fetchall()
            types = []
            for i, c in enumerate(t.columns):
                kinds = {type(r[i]).__name__ for r in info if r[i] is not None}
                kind = (
                    "INTEGER" if kinds == {"int"}
                    else "REAL" if kinds and kinds <= {"int", "float"}
                    else "TEXT"
                )
                types.append(SqlColumn(name=c, type=kind))
            out.append(SqlTable(name=t.name, source=t.source, row_count=len(t.rows), columns=types))
        return out
    finally:
        conn.close()


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

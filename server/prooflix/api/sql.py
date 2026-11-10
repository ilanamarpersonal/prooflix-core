"""``/api/sql`` routes: run SQL over the workspace's data files.

The catalog reads data lake files only (Parquet):

- ``workspace/data/<catalog>/<schema>/``: three-level names. Each folder in ``data/``
  is a catalog (usually a tenant ID such as ``tenant1``) and each folder in it a schema
  (a layer such as ``bronze``), so ``data/tenant1/bronze/customers/`` is the table
  ``tenant1.bronze.customers``. Folders without Parquet files (``source/``,
  ``checkpoint/``) add nothing.
- Parquet files directly in ``data/``: schema ``main`` (no prefix in SQL).
- each project's ``data/`` folder (a schema named after the project) and each
  catalog sub-folder: two-level names, ``my_project.orders``.

A folder of Parquet files is one table (its files are read together), and a Parquet
file directly in a schema's folder is a table of its own. The tables are loaded into a
fresh in-memory SQLite database for each request. SQLite only has ``schema.table``, so
a three-level schema is attached as a database named ``"tenant1.bronze"`` and queries
are rewritten from ``tenant1.bronze.customers`` to ``"tenant1.bronze".customers``. The
database is read only and thrown away afterwards, so queries never change the files.
"""

from __future__ import annotations

import base64
import binascii
import csv
import datetime as dt
import decimal
import io
import json
import re
import sqlite3
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..pipelines import Workspace
from .deps import CatalogPaths, get_catalog_paths

router = APIRouter(prefix="/api/sql", tags=["sql"])

QUERY_TIMEOUT_S = 10.0
MAX_ROWS = 10_000


class SqlColumn(BaseModel):
    name: str
    type: str


class SqlTable(BaseModel):
    name: str  # table name inside its schema
    # "main", a project's schema, or "<catalog>.<schema>" such as "tenant1.bronze"
    schema_name: str = Field(serialization_alias="schema")
    catalog: str = ""  # "tenant1" for three-level names, "" otherwise
    # how to write it in SQL: "orders" in main, "my_project.orders", "tenant1.bronze.orders"
    qualified: str
    source: str  # file path, relative to the workspace or (for catalog schemas) starting with "catalog/"
    in_workspace: bool  # the file is part of the workspace (a project's data), not the catalog folder
    row_count: int
    columns: list[SqlColumn]


class CatalogSchema(BaseModel):
    name: str  # as written in SQL: "my_project" or "tenant1.bronze"
    catalog: str = ""  # "tenant1" for a schema inside a catalog folder, "" otherwise
    location: Literal["workspace", "catalog"]  # a project's data, or the catalog folder
    project: str  # project folder relative to the workspace; "" for main and catalog schemas
    data_dir: str | None  # where its tables come from ("catalog/<name>" for catalog schemas)
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
    in_workspace: bool = True
    catalog: str = ""

    @property
    def qualified(self) -> str:
        return self.name if self.schema == MAIN else f"{self.schema}.{self.name}"


MAIN = "main"
DATA_SUFFIX = ".parquet"  # the catalog reads data lake (Parquet) files only


# ------------------------------------------------------------------ loading
def table_name(rel: Path) -> str:
    """``output/2026-11-07/clean_orders`` -> ``output_2026_11_07_clean_orders``.

    ``rel`` is a table's folder (or, for a file directly in a schema's folder, the
    file) relative to the schema's folder; a file extension is dropped.
    """
    rel = rel.with_suffix("") if rel.suffix.lower() == DATA_SUFFIX else rel
    name = re.sub(r"[^0-9a-zA-Z]+", "_", rel.as_posix()).strip("_").lower()
    return name if name and not name[0].isdigit() else f"t_{name}"


def table_key(rel_file: Path) -> Path:
    """Which table a Parquet file belongs to: its folder, or the file itself when
    it sits directly in the schema's folder.

    ``destination/customers/part-0.parquet`` -> ``destination/customers``;
    ``orders.parquet`` -> ``orders.parquet``.
    """
    return rel_file if rel_file.parent == Path(".") else rel_file.parent


def _cell(value: Any) -> Any:
    """A Parquet value as a SQLite value: numbers stay numbers, booleans become
    0/1, dates and timestamps ISO 8601 text, nested values JSON text. Parquet
    columns are typed, so text stays text."""
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, (int, float)):
        return value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def _load_parquet(files: list[Path]) -> tuple[list[str], list[list[Any]]] | None:
    """Columns and rows of one or more Parquet files read as a single table
    (columns are the union of the files' columns, in first-seen order).
    None if any file is not readable Parquet."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    records: list[dict] = []
    columns: list[str] = []
    for path in files:
        try:
            table = pq.read_table(path)
        except (pa.ArrowException, OSError):
            return None
        for name in table.column_names:
            if name not in columns:
                columns.append(name)
        records.extend(table.to_pylist())
    if not columns:
        return None
    return columns, [[_cell(rec.get(c)) for c in columns] for rec in records]


def schema_name(project_folder: str) -> str:
    """``prooflix-test`` -> ``prooflix_test`` (a SQL identifier)."""
    name = re.sub(r"[^0-9a-zA-Z]+", "_", project_folder).strip("_").lower()
    name = name if name and not name[0].isdigit() else f"s_{name}"
    return f"{name}_" if name in (MAIN, "temp") else name


@dataclass
class _Schema:
    name: str  # as written in SQL, "tenant1.bronze" for a schema inside a catalog
    location: Literal["workspace", "catalog"]
    project: str  # project folder ("" for main, tenant and catalog schemas)
    data_dir: Path
    recursive: bool = True  # False for main: its sub-folders are catalogs of their own
    catalog: str = ""  # "tenant1" for data/tenant1/<schema>/, "" otherwise


def schemas(paths: CatalogPaths) -> list[_Schema]:
    """Schemas and the folders their tables come from.

    - ``main``: Parquet files directly in the workspace's ``data/`` folder (tables
      need no prefix in SQL)
    - one per folder inside each folder of the workspace's ``data/`` folder: the outer
      folder is the catalog (a tenant ID), the inner one the schema (a layer), so
      ``data/tenant1/bronze/customers/`` is ``tenant1.bronze.customers``
    - one per project (a workspace folder with ``pipelines/``): its ``data/``
      folder, named after the project, so ``my-project/data/orders.parquet`` is
      ``my_project.orders``
    - one per sub-folder of the catalog folder, for data that is not part of a
      project (imported tables, datasets): ``catalog/banking/customers.parquet``
      is ``banking.customers``
    """
    root = paths.root
    data = root / "data"
    out = [_Schema(MAIN, "workspace", "", data, recursive=False)]
    taken = {MAIN}

    def unique(name: str) -> str:
        while name in taken:
            name += "_"
        taken.add(name)
        return name

    def folders(parent: Path) -> list[Path]:
        return [f for f in sorted(parent.iterdir()) if f.is_dir() and not f.name.startswith((".", "_"))]

    if data.is_dir():
        for catalog_folder in folders(data):
            cat = schema_name(catalog_folder.name)
            for schema_folder in folders(catalog_folder):
                name = unique(f"{cat}.{schema_name(schema_folder.name)}")
                out.append(_Schema(name, "workspace", "", schema_folder, catalog=cat))

    for project in Workspace(root).projects():
        if project != root:
            out.append(_Schema(unique(schema_name(project.name)), "workspace", project.name, project / "data"))
    if paths.catalog_dir.is_dir():
        for folder in sorted(paths.catalog_dir.iterdir()):
            if folder.is_dir() and not folder.name.startswith((".", "_")):
                out.append(_Schema(unique(schema_name(folder.name)), "catalog", "", folder))
    return out


def _display_path(paths: CatalogPaths, path: Path, in_workspace: bool) -> str:
    if in_workspace:
        return path.relative_to(paths.root).as_posix()
    return "catalog/" + path.relative_to(paths.catalog_dir).as_posix()


def load_tables(paths: CatalogPaths) -> list[_Loaded]:
    tables: list[_Loaded] = []
    for sch in schemas(paths):
        if sch.data_dir.is_dir():
            _load_dir(paths, sch, tables)
    return tables


def _load_dir(paths: CatalogPaths, sch: _Schema, tables: list[_Loaded]) -> None:
    """Add the schema's tables: one per folder of Parquet files, plus one per
    Parquet file directly in the schema's folder. Other files are ignored."""
    groups: dict[Path, list[Path]] = {}
    found = sch.data_dir.rglob(f"*{DATA_SUFFIX}") if sch.recursive else sch.data_dir.glob(f"*{DATA_SUFFIX}")
    for path in sorted(found, key=lambda p: p.as_posix()):
        rel = path.relative_to(sch.data_dir)
        if path.is_file() and path.suffix.lower() == DATA_SUFFIX and not any(
            p.startswith((".", "_")) for p in rel.parts
        ):
            groups.setdefault(table_key(rel), []).append(path)
    seen: set[str] = set()
    in_workspace = sch.location == "workspace"
    for key, files in groups.items():
        loaded = _load_parquet(files)
        if loaded is None:
            continue
        name = table_name(key)
        while name in seen:
            name += "_"
        seen.add(name)
        source = sch.data_dir / key
        tables.append(
            _Loaded(
                sch.name,
                name,
                _display_path(paths, source, in_workspace),
                loaded[0],
                loaded[1],
                in_workspace,
                sch.catalog,
            )
        )


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


# Parts of a query the three-level rewrite must leave alone: strings, quoted
# identifiers and comments.
_UNTOUCHED = re.compile(r"""('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|/\*.*?(?:\*/|$))""", re.S)


def rewrite_three_part_names(sql: str, schema_names: list[str]) -> str:
    """``tenant1.bronze.customers`` -> ``"tenant1.bronze".customers`` for every
    three-level schema (a name with a dot), outside strings and comments."""
    dotted = sorted((n for n in schema_names if "." in n), key=len, reverse=True)
    if not dotted:
        return sql
    patterns = []
    for name in dotted:
        cat, sch = name.split(".", 1)
        patterns.append(
            (re.compile(rf"(?<![\w$.\"]){re.escape(cat)}\s*\.\s*{re.escape(sch)}\s*\.(?=\s*[\w\"`\[])", re.I), _quote(name) + ".")
        )
    parts = _UNTOUCHED.split(sql)
    for i in range(0, len(parts), 2):  # even indexes are code, odd ones untouched
        for pattern, replacement in patterns:
            parts[i] = pattern.sub(replacement, parts[i])
    return "".join(parts)


def _deny_attach(action: int, *_args: Any) -> int:
    # ATTACH could create database files on disk; nothing else needs blocking
    # because the database itself is in memory and set to query_only.
    return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK


def open_database(paths: CatalogPaths) -> tuple[sqlite3.Connection, list[_Loaded]]:
    tables = load_tables(paths)
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
                catalog=t.catalog,
                qualified=t.qualified,
                source=t.source,
                in_workspace=t.in_workspace,
                row_count=len(t.rows),
                columns=columns,
            )
        )
    return out


@router.get("/tables", response_model=list[SqlTable], response_model_by_alias=True)
def list_tables(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[SqlTable]:
    return _describe(load_tables(paths))


catalog_router = APIRouter(prefix="/api/catalog", tags=["catalog"])


@catalog_router.get("", response_model=list[CatalogSchema], response_model_by_alias=True)
def catalog(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[CatalogSchema]:
    """Schemas and their tables. Only schemas that have at least one table are listed."""
    described = _describe(load_tables(paths))
    out = []
    for sch in schemas(paths):
        tables = [t for t in described if t.schema_name == sch.name]
        if not tables:
            continue
        out.append(
            CatalogSchema(
                name=sch.name,
                catalog=sch.catalog,
                location=sch.location,
                project=sch.project,
                data_dir=_display_path(paths, sch.data_dir, sch.location == "workspace"),
                tables=tables,
            )
        )
    return out


@router.post("/query", response_model=SqlResult)
def run_query(body: SqlQueryIn, paths: CatalogPaths = Depends(get_catalog_paths)) -> SqlResult:
    conn, tables = open_database(paths)
    sql = rewrite_three_part_names(body.sql, sorted({t.schema for t in tables}))
    started = time.perf_counter()
    deadline = started + QUERY_TIMEOUT_S
    conn.set_progress_handler(lambda: 1 if time.perf_counter() > deadline else 0, 10_000)
    try:
        cur = conn.execute(sql)
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


# ------------------------------------------------------------------ export / import
def _csv_bytes(columns: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _download(data: bytes, filename: str, media_type: str) -> Response:
    return Response(
        data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _parquet_bytes(columns: list[str], rows: list[list[Any]]) -> bytes:
    """One Parquet file. A column whose values are all integers (or all numbers)
    gets an integer (or float) type; anything else is stored as text."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    arrays = []
    for i, _name in enumerate(columns):
        values = [row[i] if i < len(row) else None for row in rows]
        present = [v for v in values if v is not None]
        if present and all(isinstance(v, int) and not isinstance(v, bool) for v in present):
            arrays.append(pa.array(values, type=pa.int64()))
        elif present and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
            arrays.append(pa.array([None if v is None else float(v) for v in values], type=pa.float64()))
        else:
            arrays.append(pa.array([None if v is None else str(v) for v in values], type=pa.string()))
    names = [c or f"column_{i + 1}" for i, c in enumerate(columns)]
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_arrays(arrays, names=names), buf)
    return buf.getvalue()


ExportFormat = Literal["csv", "parquet"]


@catalog_router.get("/export")
def export(
    table: str | None = Query(None, description="schema.table: export only that table"),
    schema: str | None = Query(None, description="export every table of the schema"),
    format: ExportFormat = Query("csv", description="csv, or parquet (always delivered in a ZIP)"),
    paths: CatalogPaths = Depends(get_catalog_paths),
) -> Response:
    """Download a table, a schema or, with neither, the whole catalog.

    ``format=csv``: a table is a single ``.csv`` file; a schema or the catalog
    is a ZIP of CSV files. ``format=parquet``: always a ZIP of ``.parquet``
    files (one for a table).
    """
    ext = format
    encode = _csv_bytes if format == "csv" else _parquet_bytes
    tables = load_tables(paths)
    if table:
        found = next((t for t in tables if f"{t.schema}.{t.name}" == table), None)
        if found is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Table '{table}' not found")
        picked, base = [found], f"{found.schema}.{found.name}"
        if format == "csv":
            return _download(_csv_bytes(found.columns, found.rows), f"{base}.csv", "text/csv")
    else:
        picked = [t for t in tables if schema is None or t.schema == schema]
        if schema is not None and not picked:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Schema '{schema}' has no tables")
        base = schema or "catalog"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for t in picked:
            if table:
                name = f"{t.schema}.{t.name}.{ext}"
            elif schema:
                name = f"{t.name}.{ext}"
            else:
                name = f"{t.schema}/{t.name}.{ext}"
            zf.writestr(name, encode(t.columns, t.rows))
    suffix = "" if format == "csv" else "-parquet"
    return _download(buf.getvalue(), f"{base}{suffix}.zip", "application/zip")


class CatalogImportFile(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)  # file name, e.g. "orders.parquet"
    content_base64: str


class CatalogImportIn(BaseModel):
    schema_name: str = Field(..., min_length=1, max_length=64, alias="schema")
    files: list[CatalogImportFile] = Field(..., min_length=1, max_length=100)
    overwrite: bool = False

    model_config = {"populate_by_name": True}


class CatalogImportResult(BaseModel):
    schema_name: str = Field(serialization_alias="schema")
    folder: str  # the data folder the files were written to, relative to the workspace
    tables: list[str]
    created_schema: bool


MAX_CATALOG_IMPORT_BYTES = 50 * 1024 * 1024


@catalog_router.post("/import", response_model=CatalogImportResult, response_model_by_alias=True)
def import_tables(
    body: CatalogImportIn, paths: CatalogPaths = Depends(get_catalog_paths)
) -> CatalogImportResult:
    """Add Parquet files as tables of a schema.

    An existing schema gets the files in its folder (a project's ``data/``, or
    its catalog folder). A new schema name creates a folder for it in the
    catalog folder, outside the workspace. Nothing is written if any file is
    not a readable table, or if a table already exists and ``overwrite`` is
    false (409 with the conflicting names).
    """
    existing = {sch.name: sch for sch in schemas(paths)}
    requested = body.schema_name.strip()
    target = existing.get(requested) or existing.get(schema_name(requested))
    if target is not None:
        schema, data_dir = target.name, target.data_dir
        created = not data_dir.is_dir() and target.name != MAIN
    else:
        schema = schema_name(requested)
        folder = re.sub(r"[^0-9A-Za-z_-]+", "-", requested).strip("-_") or schema
        if folder.startswith((".", "_")):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"'{requested}' can't be used as a schema name")
        data_dir = paths.catalog_dir / folder
        created = True

    decoded: dict[str, bytes] = {}
    total = 0
    errors: list[str] = []
    for f in body.files:
        name = Path(f.name.replace("\\", "/")).name
        if name.startswith((".", "_")) or Path(name).suffix.lower() != DATA_SUFFIX:
            errors.append(f"'{f.name}': only Parquet (.parquet) files can be imported")
            continue
        try:
            data = base64.b64decode(f.content_base64, validate=True)
        except (binascii.Error, ValueError):
            errors.append(f"'{f.name}' is not valid base64")
            continue
        total += len(data)
        decoded[name] = data
    if total > MAX_CATALOG_IMPORT_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Import is larger than 50 MB")

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        for name, data in decoded.items():
            probe = Path(tmp) / name
            probe.write_bytes(data)
            if _load_parquet([probe]) is None:
                errors.append(f"'{name}' could not be read as a Parquet table")
    if errors:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"errors": errors})

    names = {name: table_name(Path(name)) for name in decoded}
    current = {t.name for t in load_tables(paths) if t.schema == schema}
    conflicts = sorted(t for t in names.values() if t in current)
    if conflicts and not body.overwrite:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "errors": [f"{len(conflicts)} table(s) already exist in {schema}; choose overwrite to replace them"],
                "conflicts": conflicts,
            },
        )

    data_dir.mkdir(parents=True, exist_ok=True)
    for name, data in decoded.items():
        (data_dir / name).write_bytes(data)

    final = next(sch for sch in schemas(paths) if sch.data_dir.resolve() == data_dir.resolve())
    return CatalogImportResult(
        schema_name=final.name,
        folder=_display_path(paths, data_dir, final.location == "workspace"),
        tables=sorted(names.values()),
        created_schema=created,
    )

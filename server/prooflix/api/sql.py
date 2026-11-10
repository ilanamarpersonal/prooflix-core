"""``/api/sql`` and ``/api/catalog`` routes: query the workspace's data lake with DuckDB.

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
file directly in a schema's folder is a table of its own.

Queries run in DuckDB, which reads the Parquet files directly: every table is a view
over its files, so nothing is loaded up front and tables of any size can be queried.
Listing tables only reads the files' footers (row counts and columns). Each request
gets a fresh in-memory DuckDB that can only read the data folders: no other files,
no writing, no extensions, and only single SELECT statements are run.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import decimal
import io
import json
import re
import shutil
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..pipelines import Workspace
from .deps import CatalogPaths, get_catalog_paths

router = APIRouter(prefix="/api/sql", tags=["sql"])

QUERY_TIMEOUT_S = 30.0
MAX_ROWS = 10_000


class SqlColumn(BaseModel):
    name: str
    type: str  # DuckDB type, e.g. BIGINT, DOUBLE, VARCHAR, DATE, TIMESTAMP WITH TIME ZONE


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


MAIN = "main"
DATA_SUFFIX = ".parquet"  # the catalog reads data lake (Parquet) files only
# names DuckDB uses itself; a catalog or schema folder with one of these names gets a "_"
RESERVED = {MAIN, "temp", "memory", "system", "information_schema", "pg_catalog"}


# ------------------------------------------------------------------ names
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


def schema_name(project_folder: str) -> str:
    """``prooflix-test`` -> ``prooflix_test`` (a SQL identifier)."""
    name = re.sub(r"[^0-9a-zA-Z]+", "_", project_folder).strip("_").lower()
    name = name if name and not name[0].isdigit() else f"s_{name}"
    return f"{name}_" if name in RESERVED else name


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _sql_string(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


# ------------------------------------------------------------------ discovery
@dataclass
class _Schema:
    name: str  # as written in SQL, "tenant1.bronze" for a schema inside a catalog
    location: Literal["workspace", "catalog"]
    project: str  # project folder ("" for main, tenant and catalog schemas)
    data_dir: Path
    recursive: bool = True  # False for main: its sub-folders are catalogs of their own
    catalog: str = ""  # "tenant1" for data/tenant1/<schema>/, "" otherwise

    @property
    def short(self) -> str:
        """The schema's own name: "bronze" for "tenant1.bronze"."""
        return self.name[len(self.catalog) + 1 :] if self.catalog else self.name


@dataclass
class _Table:
    schema: str
    name: str
    source: str
    files: list[Path]
    row_count: int
    in_workspace: bool = True
    catalog: str = ""
    columns: list[tuple[str, str]] = field(default_factory=list)  # (name, DuckDB type), filled by describe

    @property
    def qualified(self) -> str:
        return self.name if self.schema == MAIN else f"{self.schema}.{self.name}"

    @property
    def sql_ref(self) -> str:
        """The view's name, quoted, as DuckDB resolves it."""
        if self.schema == MAIN:
            return _quote(self.name)
        if self.catalog:
            short = self.schema[len(self.catalog) + 1 :]
            return f"{_quote(self.catalog)}.{_quote(short)}.{_quote(self.name)}"
        return f"{_quote(self.schema)}.{_quote(self.name)}"


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

    Catalog names and two-level schema names never clash (a clash gets a "_"), so
    ``x.y`` always means one thing.
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
            cat = unique(schema_name(catalog_folder.name))
            for schema_folder in folders(catalog_folder):
                out.append(
                    _Schema(f"{cat}.{schema_name(schema_folder.name)}", "workspace", "", schema_folder, catalog=cat)
                )

    for project in Workspace(root).projects():
        if project != root:
            out.append(_Schema(unique(schema_name(project.name)), "workspace", project.name, project / "data"))
    if paths.catalog_dir.is_dir():
        for folder in folders(paths.catalog_dir):
            out.append(_Schema(unique(schema_name(folder.name)), "catalog", "", folder))
    return out


def _display_path(paths: CatalogPaths, path: Path, in_workspace: bool) -> str:
    if in_workspace:
        return path.relative_to(paths.root).as_posix()
    return "catalog/" + path.relative_to(paths.catalog_dir).as_posix()


def _parquet_rows(path: Path) -> int | None:
    """Row count from the file's footer, without reading its data; None if it isn't Parquet."""
    try:
        meta = pq.ParquetFile(path).metadata
    except (pa.ArrowException, OSError):
        return None
    return meta.num_rows if meta.num_columns else None


def find_tables(paths: CatalogPaths) -> list[_Table]:
    """Every table: one per folder of Parquet files, plus one per Parquet file directly
    in a schema's folder. Unreadable files are left out; other files are ignored."""
    tables: list[_Table] = []
    for sch in schemas(paths):
        if not sch.data_dir.is_dir():
            continue
        groups: dict[Path, list[tuple[Path, int]]] = {}
        found = sch.data_dir.rglob(f"*{DATA_SUFFIX}") if sch.recursive else sch.data_dir.glob(f"*{DATA_SUFFIX}")
        for path in sorted(found, key=lambda p: p.as_posix()):
            rel = path.relative_to(sch.data_dir)
            if not path.is_file() or path.suffix.lower() != DATA_SUFFIX:
                continue
            if any(p.startswith((".", "_")) for p in rel.parts):
                continue
            rows = _parquet_rows(path)
            if rows is not None:
                groups.setdefault(table_key(rel), []).append((path, rows))
        seen: set[str] = set()
        in_workspace = sch.location == "workspace"
        for key, files in groups.items():
            name = table_name(key)
            while name in seen:
                name += "_"
            seen.add(name)
            tables.append(
                _Table(
                    schema=sch.name,
                    name=name,
                    source=_display_path(paths, sch.data_dir / key, in_workspace),
                    files=[p for p, _ in files],
                    row_count=sum(r for _, r in files),
                    in_workspace=in_workspace,
                    catalog=sch.catalog,
                )
            )
    return tables


# ------------------------------------------------------------------ DuckDB
def open_database(paths: CatalogPaths, tables: list[_Table] | None = None) -> tuple[duckdb.DuckDBPyConnection, list[_Table]]:
    """A fresh in-memory DuckDB with one view per table, locked down so it can only
    read the data folders. Tables whose files can't be read together are left out."""
    tables = find_tables(paths) if tables is None else tables
    conn = duckdb.connect(":memory:")
    # only the folders the tables' files are in
    allowed = sorted({str(sch.data_dir.resolve()) + "/" for sch in schemas(paths) if sch.data_dir.is_dir()})
    conn.execute("SET allowed_directories = ?", [allowed])
    conn.execute("SET enable_external_access = false")  # no other files, network, extensions or writes
    conn.execute("SET autoinstall_known_extensions = false")
    conn.execute("SET TimeZone = 'UTC'")

    created_schemas: set[tuple[str, str]] = set()
    usable: list[_Table] = []
    for t in tables:
        db = t.catalog or "memory"
        schema = t.schema[len(t.catalog) + 1 :] if t.catalog else t.schema
        if t.catalog and (db, "") not in created_schemas:
            conn.execute(f"ATTACH ':memory:' AS {_quote(db)}")
            created_schemas.add((db, ""))
        if schema != MAIN and (db, schema) not in created_schemas:
            conn.execute(f"CREATE SCHEMA IF NOT EXISTS {_quote(db)}.{_quote(schema)}")
            created_schemas.add((db, schema))
        files = "[" + ", ".join(_sql_string(str(p.resolve())) for p in t.files) + "]"
        try:
            conn.execute(
                f"CREATE VIEW {t.sql_ref} AS SELECT * FROM read_parquet({files}, union_by_name = true)"
            )
            t.columns = [(row[0], row[1]) for row in conn.execute(f"DESCRIBE {t.sql_ref}").fetchall()]
        except duckdb.Error:
            continue  # files with columns that can't be combined
        usable.append(t)
    conn.execute("SET lock_configuration = true")  # queries can't loosen any of the above
    return conn, usable


def _cell(value: Any) -> Any:
    """A query result value as JSON: numbers stay numbers, booleans become 0/1, dates
    and timestamps ISO 8601 text, nested values JSON text."""
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, (int, float, str)):
        return value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def _only_select(conn: duckdb.DuckDBPyConnection, sql: str) -> str:
    """The single SELECT statement in sql (without a trailing ";"), or a 400."""
    try:
        statements = conn.extract_statements(sql)
    except duckdb.Error as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if len(statements) != 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Run one statement at a time")
    if statements[0].type != duckdb.StatementType.SELECT:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "The SQL editor is read only: only queries that read data are allowed"
        )
    return statements[0].query.strip().rstrip(";")


# ------------------------------------------------------------------ routes
def _describe(tables: list[_Table]) -> list[SqlTable]:
    return [
        SqlTable(
            name=t.name,
            schema_name=t.schema,
            catalog=t.catalog,
            qualified=t.qualified,
            source=t.source,
            in_workspace=t.in_workspace,
            row_count=t.row_count,
            columns=[SqlColumn(name=n, type=k) for n, k in t.columns],
        )
        for t in tables
    ]


def _described_tables(paths: CatalogPaths) -> list[_Table]:
    conn, tables = open_database(paths)
    conn.close()
    return tables


@router.get("/tables", response_model=list[SqlTable], response_model_by_alias=True)
def list_tables(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[SqlTable]:
    return _describe(_described_tables(paths))


catalog_router = APIRouter(prefix="/api/catalog", tags=["catalog"])


@catalog_router.get("", response_model=list[CatalogSchema], response_model_by_alias=True)
def catalog(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[CatalogSchema]:
    """Schemas and their tables. Only schemas that have at least one table are listed."""
    described = _describe(_described_tables(paths))
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
    conn, _ = open_database(paths)
    sql = _only_select(conn, body.sql)
    # stop the query if it runs too long
    timer = threading.Timer(QUERY_TIMEOUT_S, conn.interrupt)
    started = time.perf_counter()
    timer.start()
    try:
        # only the first limit+1 rows are produced, however large the result would be
        result = conn.sql(f"SELECT * FROM ({sql}) AS q LIMIT {body.limit + 1}").to_arrow_table()
    except duckdb.InterruptException as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Query took longer than {QUERY_TIMEOUT_S:g} seconds and was stopped"
        ) from exc
    except duckdb.PermissionException as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The SQL editor can only read the catalog's tables") from exc
    except duckdb.Error as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc).split("\n\n")[0]) from exc
    finally:
        timer.cancel()
        elapsed = (time.perf_counter() - started) * 1000
        conn.close()
    columns = result.column_names
    # column by column through Arrow (no extra Python packages for time zones), which
    # also keeps duplicate column names such as SELECT a, a
    kept = result.slice(0, body.limit)
    values = [kept.column(i).to_pylist() for i in range(kept.num_columns)]
    rows = [[_cell(v) for v in row] for row in zip(*values)] if values else []
    return SqlResult(
        columns=columns,
        rows=rows,
        row_count=len(rows),
        truncated=result.num_rows > body.limit,
        elapsed_ms=round(elapsed, 1),
    )


# ------------------------------------------------------------------ export / import
ExportFormat = Literal["csv", "parquet"]


def _copy_out(conn: duckdb.DuckDBPyConnection, table: _Table, target: Path, fmt: ExportFormat) -> None:
    options = "FORMAT csv, HEADER true" if fmt == "csv" else "FORMAT parquet"
    conn.execute(f"COPY (SELECT * FROM {table.sql_ref}) TO {_sql_string(str(target))} ({options})")


@catalog_router.get("/export")
def export(
    background: BackgroundTasks,
    table: str | None = Query(None, description="schema.table: export only that table"),
    schema: str | None = Query(None, description="export every table of the schema"),
    format: ExportFormat = Query("csv", description="csv, or parquet (always delivered in a ZIP)"),
    paths: CatalogPaths = Depends(get_catalog_paths),
) -> FileResponse:
    """Download a table, a schema or, with neither, the whole catalog.

    ``format=csv``: a table is a single ``.csv`` file; a schema or the catalog
    is a ZIP of CSV files. ``format=parquet``: always a ZIP of ``.parquet``
    files (one for a table). DuckDB writes the files straight from the Parquet
    sources, so large tables are never held in memory.
    """
    tables = find_tables(paths)
    if table:
        picked = [t for t in tables if f"{t.schema}.{t.name}" == table]
        if not picked:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Table '{table}' not found")
        base = table
    else:
        picked = [t for t in tables if schema is None or t.schema == schema]
        if schema is not None and not picked:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Schema '{schema}' has no tables")
        base = schema or "catalog"

    work = Path(tempfile.mkdtemp(prefix="prooflix-export-"))
    background.add_task(shutil.rmtree, work, True)
    # This connection writes into the temporary folder, so it is the internal, unlocked
    # kind; no user SQL ever runs on it.
    conn = duckdb.connect(":memory:")
    try:
        conn.execute("SET TimeZone = 'UTC'")
        checked, picked = open_database(paths, picked)  # keep only tables DuckDB can read
        checked.close()
        for t in picked:
            files = "[" + ", ".join(_sql_string(str(p.resolve())) for p in t.files) + "]"
            if t.catalog:
                conn.execute(f"ATTACH IF NOT EXISTS ':memory:' AS {_quote(t.catalog)}")
            db, sch = (t.catalog, t.schema[len(t.catalog) + 1 :]) if t.catalog else ("memory", t.schema)
            if sch != MAIN:
                conn.execute(f"CREATE SCHEMA IF NOT EXISTS {_quote(db)}.{_quote(sch)}")
            conn.execute(f"CREATE OR REPLACE VIEW {t.sql_ref} AS SELECT * FROM read_parquet({files}, union_by_name = true)")
        if table and format == "csv":
            target = work / f"{base}.csv"
            _copy_out(conn, picked[0], target, "csv")
            return FileResponse(target, media_type="text/csv", filename=target.name)
        zipped = work / (f"{base}.zip" if format == "csv" else f"{base}-parquet.zip")
        with zipfile.ZipFile(zipped, "w", zipfile.ZIP_DEFLATED) as zf:
            for t in picked:
                if table:
                    name = f"{t.schema}.{t.name}.{format}"
                elif schema:
                    name = f"{t.name}.{format}"
                else:
                    name = f"{t.schema}/{t.name}.{format}"
                part = work / f"part-{len(zf.namelist())}.{format}"
                _copy_out(conn, t, part, format)
                zf.write(part, name)
                part.unlink()
        return FileResponse(zipped, media_type="application/zip", filename=zipped.name)
    finally:
        conn.close()


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

    for name, data in decoded.items():
        try:
            meta = pq.ParquetFile(io.BytesIO(data)).metadata
            if not meta.num_columns:
                raise ValueError
        except (pa.ArrowException, OSError, ValueError):
            errors.append(f"'{name}' could not be read as a Parquet table")
    if errors:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"errors": errors})

    names = {name: table_name(Path(name)) for name in decoded}
    current = {t.name for t in find_tables(paths) if t.schema == schema}
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

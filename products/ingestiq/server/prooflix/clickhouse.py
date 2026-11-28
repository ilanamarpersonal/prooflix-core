"""Copying catalog tables into ClickHouse, with the same columns and types.

The ClickHouse tab copies gold tables (Delta tables of a ``gold`` schema) into a
ClickHouse server, where people outside Prooflix can query them with a read-only
user. Only ClickHouse's HTTP interface is used (no client library):

1. The table's columns are read through DuckDB (Delta tables at their current
   version, see ``delta_log.py``) and mapped to ClickHouse types: ``Int64``,
   ``Float64``, ``String``, ``Date32``, ``DateTime64(6, 'UTC')``, ``Decimal(p, s)``,
   ... each ``Nullable`` like the source column.
2. DuckDB writes the rows to a temporary Parquet file, which is sent with
   ``INSERT INTO ... FORMAT Parquet`` into a new table next to the old one.
3. The new table is swapped in (``EXCHANGE TABLES``) and the old one dropped, so a
   reader never sees a half-loaded table, and a failed import leaves the old one.

Catalog ``tenant1``, schema ``gold``, table ``daily`` becomes the ClickHouse table
``tenant1.daily`` (database = the catalog).
"""

from __future__ import annotations

import base64
import json
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa

STAGING_SUFFIX = "__prooflix_new"


class ClickHouseError(RuntimeError):
    pass


def _ident(name: str) -> str:
    return "`" + name.replace("\\", "\\\\").replace("`", "\\`") + "`"


def clickhouse_type(t: pa.DataType) -> str:
    """The ClickHouse type for an Arrow type (as DuckDB produces them), Nullable."""
    return f"Nullable({_base_type(t)})"


def _base_type(t: pa.DataType) -> str:
    if pa.types.is_boolean(t):
        return "Bool"
    if pa.types.is_integer(t):
        width = t.bit_width
        return f"{'Int' if pa.types.is_signed_integer(t) else 'UInt'}{width}"
    if pa.types.is_float32(t):
        return "Float32"
    if pa.types.is_floating(t):
        return "Float64"
    if pa.types.is_decimal(t):
        return f"Decimal({t.precision}, {t.scale})"
    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return "String"
    if pa.types.is_binary(t) or pa.types.is_large_binary(t):
        return "String"
    if pa.types.is_date(t):
        return "Date32"
    if pa.types.is_timestamp(t):
        precision = {"s": 0, "ms": 3, "us": 6, "ns": 9}[t.unit]
        return f"DateTime64({precision}, 'UTC')" if t.tz else f"DateTime64({precision})"
    if pa.types.is_time(t):
        return "String"
    raise ClickHouseError(f"no ClickHouse type for {t} (lists, maps and structs aren't copied)")


@dataclass
class ClickHouse:
    url: str
    user: str = "default"
    password: str = ""
    timeout: float = 30.0

    def _request(self, query: str, body=None, length: int | None = None, timeout: float | None = None) -> str:
        if body is None:
            url, data = self.url + "/", query.encode()
        else:
            url, data = self.url + "/?" + urllib.parse.urlencode({"query": query}), body
        req = urllib.request.Request(url, data=data, method="POST")
        token = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
        if length is not None:
            req.add_header("Content-Length", str(length))
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as res:
                return res.read().decode()
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace").strip()
            raise ClickHouseError(re.sub(r"\s*\(version [^)]*\)\s*$", "", text) or f"HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ClickHouseError(f"ClickHouse is not reachable at {self.url}: {getattr(e, 'reason', e)}") from None

    def execute(self, sql: str) -> str:
        return self._request(sql)

    def rows(self, sql: str) -> list[dict]:
        return json.loads(self._request(sql + " FORMAT JSON"))["data"]

    def version(self) -> str:
        return self._request("SELECT version()").strip()

    def tables(self) -> list[dict]:
        return self.rows(
            "SELECT database, name, total_rows AS rows, total_bytes AS bytes FROM system.tables "
            "WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') "
            f"AND NOT endsWith(name, '{STAGING_SUFFIX}') ORDER BY database, name"
        )

    def insert_parquet(self, table: str, path: Path) -> None:
        with path.open("rb") as f:
            self._request(f"INSERT INTO {table} FORMAT Parquet", body=f, length=path.stat().st_size, timeout=3600)


def _connection_with_view(files: list[Path]) -> duckdb.DuckDBPyConnection:
    """An internal DuckDB connection (no user SQL runs on it) with the table as view t."""
    conn = duckdb.connect(":memory:")
    conn.execute("SET TimeZone = 'UTC'")
    listing = "[" + ", ".join("'" + str(p.resolve()).replace("'", "''") + "'" for p in files) + "]"
    conn.execute(f"CREATE VIEW t AS SELECT * FROM read_parquet({listing}, union_by_name = true)")
    return conn


def columns(files: list[Path]) -> list[tuple[str, str]]:
    """(name, ClickHouse type) of each column of the table made of these files."""
    conn = _connection_with_view(files)
    try:
        schema = conn.execute("SELECT * FROM t LIMIT 0").to_arrow_table().schema
    finally:
        conn.close()
    return [(f.name, clickhouse_type(f.type)) for f in schema]


def copy_table(ch: ClickHouse, files: list[Path], database: str, name: str) -> dict:
    """Create (or replace) database.name in ClickHouse with the rows of these files."""
    started = time.time()
    cols = columns(files)
    target = f"{_ident(database)}.{_ident(name)}"
    staging = f"{_ident(database)}.{_ident(name + STAGING_SUFFIX)}"
    ch.execute(f"CREATE DATABASE IF NOT EXISTS {_ident(database)}")
    ch.execute(f"DROP TABLE IF EXISTS {staging}")
    ddl = ", ".join(f"{_ident(c)} {t}" for c, t in cols)
    ch.execute(f"CREATE TABLE {staging} ({ddl}) ENGINE = MergeTree ORDER BY tuple()")
    try:
        with tempfile.TemporaryDirectory(prefix="prooflix-clickhouse-") as work:
            parquet = Path(work) / "rows.parquet"
            conn = _connection_with_view(files)
            try:
                conn.execute(f"COPY (SELECT * FROM t) TO '{parquet}' (FORMAT parquet)")
            finally:
                conn.close()
            ch.insert_parquet(staging, parquet)
        exists = ch.execute(f"EXISTS TABLE {target}").strip() == "1"
        if exists:
            ch.execute(f"EXCHANGE TABLES {staging} AND {target}")
            ch.execute(f"DROP TABLE {staging}")
        else:
            ch.execute(f"RENAME TABLE {staging} TO {target}")
    except BaseException:
        try:
            ch.execute(f"DROP TABLE IF EXISTS {staging}")
        except ClickHouseError:
            pass
        raise
    rows = int(ch.execute(f"SELECT count() FROM {target}").strip())
    return {"target": f"{database}.{name}", "rows": rows, "columns": len(cols),
            "replaced": exists, "seconds": round(time.time() - started, 1)}

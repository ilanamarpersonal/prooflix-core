"""Database connections that ingestion jobs read from (the Ingestion tab).

A connection is a relational database: Oracle, SQL Server, MySQL or PostgreSQL.
Each type asks for its own fields (``KINDS``): Oracle connects to a service name
or a SID, SQL Server has encryption settings, MySQL and PostgreSQL a database.
Connections are server-wide and kept in ``PROOFLIX_HOME/connections.json``
(readable by the server's user only), never in the workspace, so passwords don't
end up in git. A pipeline names a connection (``connection: bankdb``) and its
task asks for the details with ``ctx.connection("bankdb")``, which include the
JDBC URL and driver class Spark reads with.

Listing a database's tables and columns (to pick what to ingest) uses small
pure-Python drivers, so no database client has to be installed: pg8000, PyMySQL,
python-oracledb (thin mode) and python-tds. The ingestion itself runs in Spark
over JDBC.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONNECTIONS_FILE = "connections.json"
NAME_PATTERN = r"^[a-z][a-z0-9_]*$"
MASK = "********"
TIMEOUT = 10  # seconds to connect


class DatabaseUnreachable(RuntimeError):
    """The database can't be reached or listed; the message says why."""


@dataclass(frozen=True)
class FieldSpec:
    """One field of a connection form."""

    key: str
    label: str
    type: str = "text"  # text | number | password | select | bool
    default: object = None
    required: bool = True
    options: tuple[tuple[str, str], ...] = ()  # (value, label) for "select"
    help: str | None = None


_HOST = FieldSpec("host", "Host", help="Name or IP address the Prooflix server reaches the database at")
_USER = FieldSpec("user", "User", help="A read-only user is enough")
_PASSWORD = FieldSpec("password", "Password", "password", required=False)


def _port(default: int) -> FieldSpec:
    return FieldSpec("port", "Port", "number", default)


@dataclass(frozen=True)
class Kind:
    kind: str
    label: str
    driver: str  # JDBC driver class
    fields: tuple[FieldSpec, ...]
    jdbc_url: Callable[["Connection"], str]
    watermark: Callable[[str, int | None], bool]  # (column type, scale) -> can mark new rows


_DATE_TIME = re.compile(r"^(DATE|TIMESTAMP.*|DATETIME.*|SMALLDATETIME)$")
_INTEGER = re.compile(r"^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(\(\d+\))?( UNSIGNED)?$")


def _generic_watermark(t: str, scale: int | None) -> bool:
    return bool(_DATE_TIME.match(t) or _INTEGER.match(t))


def _sqlserver_watermark(t: str, scale: int | None) -> bool:
    if t == "TIMESTAMP":  # SQL Server's timestamp is rowversion, a binary counter
        return False
    return t in ("DATE", "DATETIME", "DATETIME2", "SMALLDATETIME", "DATETIMEOFFSET") or bool(_INTEGER.match(t))


def _oracle_watermark(t: str, scale: int | None) -> bool:
    return t == "DATE" or t.startswith("TIMESTAMP") or (t in ("NUMBER", "INTEGER") and scale == 0)


def _oracle_url(c: "Connection") -> str:
    if c.options.get("connect_by") == "sid":
        return f"jdbc:oracle:thin:@{c.host}:{c.port}:{c.database}"
    return f"jdbc:oracle:thin:@//{c.host}:{c.port}/{c.database}"


def _sqlserver_url(c: "Connection") -> str:
    encrypt = "true" if c.options.get("encrypt", True) else "false"
    trust = "true" if c.options.get("trust_server_certificate", False) else "false"
    return (f"jdbc:sqlserver://{c.host}:{c.port};databaseName={c.database};"
            f"encrypt={encrypt};trustServerCertificate={trust}")


KINDS: dict[str, Kind] = {
    k.kind: k
    for k in (
        Kind("oracle", "Oracle", "oracle.jdbc.OracleDriver", (
            _HOST, _port(1521),
            FieldSpec("connect_by", "Connect with", "select", "service",
                      options=(("service", "Service name"), ("sid", "SID"))),
            FieldSpec("database", "Service name or SID", help="e.g. FREEPDB1, ORCLPDB1 or ORCL"),
            _USER, _PASSWORD,
        ), _oracle_url, _oracle_watermark),
        Kind("sqlserver", "SQL Server", "com.microsoft.sqlserver.jdbc.SQLServerDriver", (
            _HOST, _port(1433), FieldSpec("database", "Database"), _USER, _PASSWORD,
            FieldSpec("encrypt", "Encrypt the connection", "bool", True, required=False),
            FieldSpec("trust_server_certificate", "Trust the server certificate", "bool", False, required=False,
                      help="Accept a self-signed certificate (test servers)"),
        ), _sqlserver_url, _sqlserver_watermark),
        Kind("mysql", "MySQL", "com.mysql.cj.jdbc.Driver", (
            _HOST, _port(3306), FieldSpec("database", "Database"), _USER, _PASSWORD,
        ), lambda c: f"jdbc:mysql://{c.host}:{c.port}/{c.database}", _generic_watermark),
        Kind("postgresql", "PostgreSQL", "org.postgresql.Driver", (
            _HOST, _port(5432), FieldSpec("database", "Database"), _USER, _PASSWORD,
        ), lambda c: f"jdbc:postgresql://{c.host}:{c.port}/{c.database}", _generic_watermark),
    )
}
OPTION_KEYS = {"connect_by", "encrypt", "trust_server_certificate"}


@dataclass
class Connection:
    name: str
    kind: str
    host: str
    port: int
    database: str
    user: str
    password: str = ""
    options: dict = field(default_factory=dict)  # per-kind settings: connect_by, encrypt, ...

    @property
    def driver(self) -> str:
        return KINDS[self.kind].driver

    @property
    def jdbc_url(self) -> str:
        return KINDS[self.kind].jdbc_url(self)

    def for_task(self) -> dict:
        """What a task gets from ctx.connection(name)."""
        return {**asdict(self), "driver": self.driver, "jdbc_url": self.jdbc_url}

    def public(self) -> dict:
        return {**asdict(self), "password": MASK if self.password else "", "jdbc_url": self.jdbc_url}


def kinds_for_client() -> list[dict]:
    return [{"kind": k.kind, "label": k.label, "fields": [asdict(f) for f in k.fields]} for k in KINDS.values()]


class ConnectionStore:
    """The connections in ``<home>/connections.json`` (in memory when home is None)."""

    def __init__(self, home: Path | None):
        self.file = home / CONNECTIONS_FILE if home is not None else None
        self._memory: dict[str, dict] = {}

    def _read(self) -> dict[str, dict]:
        if self.file is None:
            return dict(self._memory)
        try:
            data = json.loads(self.file.read_text())
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, dict]) -> None:
        if self.file is None:
            self._memory = dict(data)
            return
        self.file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.file.parent, prefix=f".{CONNECTIONS_FILE}.")
        os.chmod(tmp, 0o600)  # holds passwords
        with os.fdopen(fd, "w") as f:
            json.dump(dict(sorted(data.items())), f, indent=2)
        os.replace(tmp, self.file)

    def list(self) -> list[Connection]:
        out = []
        for name, values in sorted(self._read().items()):
            try:
                out.append(Connection(name=name, **{k: v for k, v in values.items() if k != "name"}))
            except TypeError:
                continue  # a hand-edited entry with unknown keys
        return out

    def get(self, name: str) -> Connection | None:
        return next((c for c in self.list() if c.name == name), None)

    def save(self, conn: Connection) -> Connection:
        """Add or replace a connection. A password of MASK keeps the saved one."""
        if not re.match(NAME_PATTERN, conn.name):
            raise ValueError("name: lowercase letters, digits and _, starting with a letter")
        if conn.kind not in KINDS:
            raise ValueError(f"type: one of {', '.join(KINDS)}")
        allowed = {f.key for f in KINDS[conn.kind].fields} & OPTION_KEYS
        conn.options = {k: v for k, v in conn.options.items() if k in allowed}
        data = self._read()
        if conn.password == MASK:
            conn.password = data.get(conn.name, {}).get("password", "")
        values = asdict(conn)
        values.pop("name")
        data[conn.name] = values
        self._write(data)
        return conn

    def delete(self, name: str) -> bool:
        data = self._read()
        if data.pop(name, None) is None:
            return False
        self._write(data)
        return True


# ------------------------------------------------------------ browsing
# (schema, table, column, type, numeric scale) of every column of the user's tables
_COLUMNS_SQL = {
    "postgresql": (
        "SELECT table_schema, table_name, column_name, data_type, numeric_scale FROM information_schema.columns "
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%' "
        "ORDER BY table_schema, table_name, ordinal_position"
    ),
    "mysql": (
        "SELECT table_schema, table_name, column_name, column_type, numeric_scale FROM information_schema.columns "
        "WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position"
    ),
    "sqlserver": (
        "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NUMERIC_SCALE "
        "FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t "
        "ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME "
        "WHERE c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA') "
        "ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION"
    ),
    "oracle": (
        "SELECT c.owner, c.table_name, c.column_name, c.data_type, c.data_scale FROM all_tab_columns c "
        "JOIN all_users u ON u.username = c.owner WHERE u.oracle_maintained = 'N' "
        "AND c.table_name NOT LIKE 'BIN$%' ORDER BY c.owner, c.table_name, c.column_id"
    ),
}


# (schema, table, column) of each primary key column, in key order
_PRIMARY_KEY_SQL = {
    "postgresql": (
        "SELECT kcu.table_schema, kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc "
        "JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name "
        "AND kcu.constraint_schema = tc.constraint_schema AND kcu.table_name = tc.table_name "
        "WHERE tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position"
    ),
    "mysql": (
        "SELECT table_schema, table_name, column_name FROM information_schema.key_column_usage "
        "WHERE constraint_name = 'PRIMARY' AND table_schema = DATABASE() ORDER BY table_name, ordinal_position"
    ),
    "sqlserver": (
        "SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc "
        "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME "
        "AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' "
        "ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION"
    ),
    "oracle": (
        "SELECT cc.owner, cc.table_name, cc.column_name FROM all_constraints c "
        "JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name "
        "JOIN all_users u ON u.username = c.owner WHERE c.constraint_type = 'P' AND u.oracle_maintained = 'N' "
        "ORDER BY cc.owner, cc.table_name, cc.position"
    ),
}


def _connect(conn: Connection):
    """A DB-API connection with the pure-Python driver for the kind."""
    if conn.kind == "postgresql":
        import pg8000.dbapi

        return pg8000.dbapi.connect(host=conn.host, port=int(conn.port), database=conn.database,
                                    user=conn.user, password=conn.password, timeout=TIMEOUT)
    if conn.kind == "mysql":
        import pymysql

        return pymysql.connect(host=conn.host, port=int(conn.port), database=conn.database, user=conn.user,
                               password=conn.password, connect_timeout=TIMEOUT, read_timeout=60)
    if conn.kind == "sqlserver":
        import pytds

        return pytds.connect(server=conn.host, port=int(conn.port), database=conn.database, user=conn.user,
                             password=conn.password, login_timeout=TIMEOUT, timeout=60)
    if conn.kind == "oracle":
        import oracledb

        params = {"sid": conn.database} if conn.options.get("connect_by") == "sid" else {"service_name": conn.database}
        return oracledb.connect(user=conn.user, password=conn.password, host=conn.host, port=int(conn.port),
                                tcp_connect_timeout=TIMEOUT, **params)
    raise DatabaseUnreachable(f"unknown database type {conn.kind}")


def _clean(e: Exception, password: str) -> str:
    first = e.args[0] if e.args else None
    if isinstance(first, dict) and "M" in first:  # pg8000
        first = first["M"]
    text = str(first if isinstance(first, str) else e).strip() or type(e).__name__
    if password:
        text = text.replace(password, MASK)  # never show the password
    return text.splitlines()[0][:500]


def describe(conn: Connection) -> list[dict]:
    """The database's tables: [{schema, name, primary_key, columns: [{name, type, watermark}]}]."""
    kind = KINDS[conn.kind]
    try:
        db = _connect(conn)
        try:
            cur = db.cursor()
            cur.execute(_COLUMNS_SQL[conn.kind])
            rows = cur.fetchall()
            cur.execute(_PRIMARY_KEY_SQL[conn.kind])
            keys = cur.fetchall()
        finally:
            db.close()
    except DatabaseUnreachable:
        raise
    except Exception as e:  # noqa: BLE001 - every driver has its own errors
        raise DatabaseUnreachable(_clean(e, conn.password)) from None
    tables: dict[tuple[str, str], dict] = {}
    for schema, table, column, data_type, scale in rows:
        t = tables.setdefault((schema, table), {"schema": schema, "name": table, "primary_key": [], "columns": []})
        shown = str(data_type)
        t["columns"].append({"name": column, "type": shown,
                             "watermark": kind.watermark(shown.upper(), None if scale is None else int(scale))})
    for schema, table, column in keys:
        if (schema, table) in tables:
            tables[(schema, table)]["primary_key"].append(column)
    return list(tables.values())

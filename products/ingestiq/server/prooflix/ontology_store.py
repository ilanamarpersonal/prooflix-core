"""The object model's database (PostgreSQL): versions of published types, actions' edits, the audit log.

The definitions themselves stay YAML files in the workspace (``ontology.py``, principle 4); every
publish also records a numbered version here, with who published it. An **action** never writes
the lake (principle 3): its edits are rows here, laid over the objects when they are read
(``latest_edits``), so a pipeline can also read them. The **audit log** records publishing,
actions, and reads of sensitive properties.

Everything is keyed by the workspace's folder: each workspace has its own object model
(principle 5). ``PROOFLIX_DATABASE_URL`` is ``postgresql://host:port/db`` (user and password are
parameters of their own); ``sqlite:///path`` works too, for tests. Without it, actions and the
audit log are off and the rest of the object model works as before.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse

SCHEMA_VERSION = 1


class StoreError(Exception):
    """The database can't be reached or answered with an error."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class OntologyStore:
    def __init__(self, url: str, user: str = "", password: str = ""):
        self.url = url
        self.user = user
        self.password = password
        self.kind = "sqlite" if url.startswith("sqlite:") else "postgresql"
        self._ready = False
        self._lock = threading.Lock()

    # ------------------------------------------------------------ connection
    def _connect(self):
        if self.kind == "sqlite":
            return sqlite3.connect(urlparse(self.url).path, timeout=10)
        import pg8000.dbapi  # pure Python, already used for database connections

        u = urlparse(self.url)
        return pg8000.dbapi.connect(
            user=self.user or (unquote(u.username) if u.username else "postgres"),
            password=self.password or None,
            host=u.hostname or "localhost",
            port=u.port or 5432,
            database=u.path.lstrip("/") or "postgres",
            timeout=10,
        )

    @contextmanager
    def _cursor(self):
        try:
            conn = self._connect()
        except Exception as e:  # noqa: BLE001 - any driver or network error
            raise StoreError(f"the object model's database isn't reachable: {e}") from None
        try:
            cur = conn.cursor()
            yield cur
            conn.commit()
        except StoreError:
            conn.rollback()
            raise
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            raise StoreError(f"the object model's database answered: {e}") from None
        finally:
            conn.close()

    def _sql(self, sql: str) -> str:
        """Queries are written with ? placeholders; PostgreSQL (pg8000) wants %s."""
        return sql if self.kind == "sqlite" else sql.replace("?", "%s")

    def _ensure(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            serial = "INTEGER PRIMARY KEY AUTOINCREMENT" if self.kind == "sqlite" else "BIGSERIAL PRIMARY KEY"
            with self._cursor() as cur:
                for stmt in (
                    "CREATE TABLE IF NOT EXISTS prooflix_schema (version INTEGER NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS prooflix_type_version (workspace TEXT NOT NULL, "
                    "api_name TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, "
                    "published_by TEXT, published_at TEXT NOT NULL, PRIMARY KEY (workspace, api_name, version))",
                    f"CREATE TABLE IF NOT EXISTS prooflix_edit (id {serial}, workspace TEXT NOT NULL, "
                    "object_type TEXT NOT NULL, pk TEXT NOT NULL, property TEXT NOT NULL, value TEXT, "
                    "action TEXT NOT NULL, run TEXT NOT NULL, reason TEXT, username TEXT, at TEXT NOT NULL)",
                    "CREATE INDEX IF NOT EXISTS prooflix_edit_object ON prooflix_edit (workspace, object_type, pk)",
                    f"CREATE TABLE IF NOT EXISTS prooflix_audit (id {serial}, at TEXT NOT NULL, username TEXT, "
                    "workspace TEXT NOT NULL, event TEXT NOT NULL, object_type TEXT, pk TEXT, detail TEXT)",
                    "CREATE INDEX IF NOT EXISTS prooflix_audit_workspace ON prooflix_audit (workspace, id)",
                    f"CREATE TABLE IF NOT EXISTS prooflix_object_set (id {serial}, workspace TEXT NOT NULL, "
                    "name TEXT NOT NULL, description TEXT, owner TEXT, shared INTEGER NOT NULL, definition TEXT NOT NULL, "
                    "created TEXT NOT NULL, updated TEXT NOT NULL)",
                ):
                    cur.execute(stmt)
                cur.execute("SELECT version FROM prooflix_schema")
                if not cur.fetchall():
                    cur.execute(self._sql("INSERT INTO prooflix_schema (version) VALUES (?)"), (SCHEMA_VERSION,))
            self._ready = True

    def status(self) -> dict:
        try:
            self._ensure()
            with self._cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchall()
            return {"configured": True, "ok": True, "kind": self.kind, "error": None}
        except StoreError as e:
            return {"configured": True, "ok": False, "kind": self.kind, "error": str(e)}

    # ------------------------------------------------------------ versions
    def record_version(self, workspace: str, api_name: str, definition: dict, user: str | None) -> int:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(
                self._sql("SELECT COALESCE(MAX(version), 0) FROM prooflix_type_version WHERE workspace = ? "
                          "AND api_name = ?"),
                (workspace, api_name),
            )
            version = int(cur.fetchall()[0][0]) + 1
            cur.execute(
                self._sql("INSERT INTO prooflix_type_version (workspace, api_name, version, definition, "
                          "published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)"),
                (workspace, api_name, version, json.dumps(definition), user, _now()),
            )
        return version

    def versions(self, workspace: str, api_name: str) -> list[dict]:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(
                self._sql("SELECT version, published_by, published_at FROM prooflix_type_version "
                          "WHERE workspace = ? AND api_name = ? ORDER BY version DESC"),
                (workspace, api_name),
            )
            return [{"version": v, "by": by, "at": at} for v, by, at in cur.fetchall()]

    def latest_versions(self, workspace: str) -> dict[str, int]:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(
                self._sql("SELECT api_name, MAX(version) FROM prooflix_type_version WHERE workspace = ? "
                          "GROUP BY api_name"),
                (workspace,),
            )
            return {name: int(v) for name, v in cur.fetchall()}

    # ------------------------------------------------------------ edits
    def apply_edit(self, workspace: str, object_type: str, pk: str, action: str, values: dict,
                   reason: str, user: str | None) -> str:
        """One row per property the action sets, sharing one run id and time. Returns the time."""
        self._ensure()
        at = _now()
        run = uuid.uuid4().hex
        with self._cursor() as cur:
            for prop, value in values.items():
                cur.execute(
                    self._sql("INSERT INTO prooflix_edit (workspace, object_type, pk, property, value, action, "
                              "run, reason, username, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
                    (workspace, object_type, pk, prop, json.dumps(value), action, run, reason, user, at),
                )
        return at

    def latest_edits(self, workspace: str, object_type: str, pks: list[str]) -> dict[str, dict[str, dict]]:
        """{pk: {property: {value, by, at, action}}}: the newest edit of each property of these objects."""
        if not pks:
            return {}
        self._ensure()
        out: dict[str, dict[str, dict]] = {}
        with self._cursor() as cur:
            for i in range(0, len(pks), 500):
                chunk = pks[i : i + 500]
                marks = ", ".join("?" for _ in chunk)
                cur.execute(
                    self._sql(f"SELECT pk, property, value, username, at, action, id FROM prooflix_edit "
                              f"WHERE workspace = ? AND object_type = ? AND pk IN ({marks}) ORDER BY id"),
                    (workspace, object_type, *chunk),
                )
                for pk, prop, value, by, at, action, _ in cur.fetchall():
                    out.setdefault(pk, {})[prop] = {"value": json.loads(value), "by": by, "at": at, "action": action}
        return out

    def history(self, workspace: str, object_type: str, pk: str) -> list[dict]:
        """Every action run on one object, newest first, with the values it set."""
        self._ensure()
        with self._cursor() as cur:
            cur.execute(
                self._sql("SELECT property, value, action, reason, username, at, run FROM prooflix_edit "
                          "WHERE workspace = ? AND object_type = ? AND pk = ? ORDER BY id DESC"),
                (workspace, object_type, pk),
            )
            rows = cur.fetchall()
        runs: list[dict] = []
        for prop, value, action, reason, by, at, run in rows:
            if runs and runs[-1]["run"] == run:
                runs[-1]["values"][prop] = json.loads(value)
            else:
                runs.append({"run": run, "action": action, "reason": reason, "by": by, "at": at,
                             "values": {prop: json.loads(value)}})
        return runs

    # ------------------------------------------------------------ audit
    def audit(self, workspace: str, user: str | None, event: str, object_type: str | None = None,
              pk: str | None = None, detail: dict | None = None) -> None:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(
                self._sql("INSERT INTO prooflix_audit (at, username, workspace, event, object_type, pk, detail) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?)"),
                (_now(), user, workspace, event, object_type, pk, json.dumps(detail or {})),
            )

    # ------------------------------------------------------------ object sets
    def _set_row(self, row) -> dict:
        i, name, description, owner, shared, definition, created, updated = row
        return {"id": int(i), "name": name, "description": description or "", "owner": owner, "shared": bool(shared),
                "set": json.loads(definition), "created": created, "updated": updated}

    _SET_COLS = "id, name, description, owner, shared, definition, created, updated"

    def list_sets(self, workspace: str, user: str | None) -> list[dict]:
        """The user's own sets and every shared one (all of them while users are off)."""
        self._ensure()
        with self._cursor() as cur:
            if user is None:
                cur.execute(self._sql(f"SELECT {self._SET_COLS} FROM prooflix_object_set WHERE workspace = ? "
                                      "ORDER BY name"), (workspace,))
            else:
                cur.execute(self._sql(f"SELECT {self._SET_COLS} FROM prooflix_object_set WHERE workspace = ? "
                                      "AND (owner = ? OR shared = 1) ORDER BY name"), (workspace, user))
            return [self._set_row(r) for r in cur.fetchall()]

    def get_set(self, workspace: str, set_id: int) -> dict | None:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(self._sql(f"SELECT {self._SET_COLS} FROM prooflix_object_set WHERE workspace = ? AND id = ?"),
                        (workspace, set_id))
            rows = cur.fetchall()
        return self._set_row(rows[0]) if rows else None

    def save_set(self, workspace: str, set_id: int | None, name: str, description: str, owner: str | None,
                 shared: bool, definition: dict) -> int:
        self._ensure()
        now = _now()
        with self._cursor() as cur:
            if set_id is None:
                cur.execute(self._sql("INSERT INTO prooflix_object_set (workspace, name, description, owner, shared, "
                                      "definition, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
                            (workspace, name, description, owner, int(shared), json.dumps(definition), now, now))
                cur.execute(self._sql("SELECT MAX(id) FROM prooflix_object_set WHERE workspace = ? AND name = ?"),
                            (workspace, name))
                return int(cur.fetchall()[0][0])
            cur.execute(self._sql("UPDATE prooflix_object_set SET name = ?, description = ?, shared = ?, "
                                  "definition = ?, updated = ? WHERE workspace = ? AND id = ?"),
                        (name, description, int(shared), json.dumps(definition), now, workspace, set_id))
            return set_id

    def delete_set(self, workspace: str, set_id: int) -> None:
        self._ensure()
        with self._cursor() as cur:
            cur.execute(self._sql("DELETE FROM prooflix_object_set WHERE workspace = ? AND id = ?"), (workspace, set_id))

    def audit_log(self, workspace: str, limit: int = 200, event: str | None = None,
                  object_type: str | None = None, user: str | None = None) -> list[dict]:
        self._ensure()
        where, args = ["workspace = ?"], [workspace]
        for col, value in (("event", event), ("object_type", object_type), ("username", user)):
            if value:
                where.append(f"{col} = ?")
                args.append(value)
        with self._cursor() as cur:
            cur.execute(
                self._sql(f"SELECT id, at, username, event, object_type, pk, detail FROM prooflix_audit "
                          f"WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT {int(limit)}"),
                tuple(args),
            )
            return [{"id": i, "at": at, "user": u, "event": e, "type": t, "pk": pk, "detail": json.loads(d or "{}")}
                    for i, at, u, e, t, pk, d in cur.fetchall()]


_stores: dict[tuple[str, str, str], OntologyStore] = {}
_stores_lock = threading.Lock()


def store_for(settings) -> OntologyStore | None:
    """The store of these settings (one per database, so its tables are created once), or None."""
    if not settings.database_url:
        return None
    key = (settings.database_url, settings.database_user, settings.database_password)
    with _stores_lock:
        if key not in _stores:
            _stores[key] = OntologyStore(*key)
        return _stores[key]

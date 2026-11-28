"""Fast search for the object model: an OpenSearch index per object type that asks for it.

A type with ``index: true`` ("Fast search" in the wizard) gets an index of its objects: every
object as the object view makes it (row rules, casts), with its searchable properties analysed for
search-as-you-type, its other properties stored for display, and its sensitive ones left out. The
index is a copy that can always be rebuilt, never the source of truth, and OpenSearch is never
reachable from the browser: the Object API searches it and applies access, masking and actions'
edits as for any read.

- **Full build**: a new index ``<alias>-<time>`` is filled from the object view, then the alias is
  moved to it in one step and the old index deleted (principle 18: swaps are atomic), so search
  never sees half an index.
- **Updates**: a background watcher (when ``PROOFLIX_SCHEDULER`` is on) compares each indexed
  table's Delta version with the one indexed. New versions are followed file by file
  (``delta_log.changes_since``): the keys in the added and removed files are re-read through the
  object view and upserted, or deleted when the row rules no longer give them. A schema change,
  vacuumed files or a changed definition rebuild the index. Parquet tables rebuild when their files
  change.
- **State** (indexed version, the definition's hash, counts) is kept in OpenSearch itself, in
  ``prooflix-index-state``, so the index and its state live and die together.

Indexing reads the lake through the SQL Editor's locked-down DuckDB and writes only to OpenSearch,
like the ClickHouse copies (principle 3). One job runs at a time.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import delta_log
from .ontology import ObjectType, object_view, q

log = logging.getLogger(__name__)

STATE_INDEX = "prooflix-index-state"
BATCH = 5000  # rows per bulk request
MAX_CHANGED_KEYS = 1_000_000  # more changed keys than this: rebuild instead
WATCH_SECONDS = 60
RETRY_SECONDS = 600  # a failed job is tried again by the watcher after this long
PK, TITLE = "prooflix_pk", "prooflix_title"  # fields of every document (underscore names are reserved)


class SearchError(Exception):
    """OpenSearch can't be reached or answered with an error."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------ OpenSearch over HTTP
class OpenSearch:
    """The few OpenSearch calls the index needs, over its REST API (no extra Python package)."""

    def __init__(self, url: str, user: str = "", password: str = "", timeout: float = 60):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode() if user else None

    def _req(self, method: str, path: str, body=None, ndjson: bool = False, ok404: bool = False):
        data = None
        headers = {"Content-Type": "application/x-ndjson" if ndjson else "application/json"}
        if body is not None:
            data = (body if isinstance(body, str) else json.dumps(body)).encode()
        if self.auth:
            headers["Authorization"] = self.auth
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - our configured URL
                text = res.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            if ok404 and e.code == 404:
                return None
            detail = e.read().decode(errors="replace")[:500]
            raise SearchError(f"OpenSearch answered {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise SearchError(f"OpenSearch isn't reachable at {self.url}: {getattr(e, 'reason', e)}") from None

    def status(self) -> dict:
        try:
            info = self._req("GET", "/")
            return {"configured": True, "ok": True, "version": info.get("version", {}).get("number"), "error": None}
        except SearchError as e:
            return {"configured": True, "ok": False, "version": None, "error": str(e)}

    # state documents
    def _ensure_state(self) -> None:
        if self._req("HEAD", f"/{STATE_INDEX}", ok404=True) is None:
            try:
                self._req("PUT", f"/{STATE_INDEX}", {"settings": {"number_of_shards": 1, "number_of_replicas": 0},
                                                      "mappings": {"dynamic": False}})
            except SearchError as e:
                if "resource_already_exists" not in str(e):
                    raise

    def get_state(self, key: str) -> dict | None:
        self._ensure_state()
        doc = self._req("GET", f"/{STATE_INDEX}/_doc/{_quote(key)}", ok404=True)
        return doc["_source"] if doc and doc.get("found") else None

    def put_state(self, key: str, state: dict) -> None:
        self._ensure_state()
        self._req("PUT", f"/{STATE_INDEX}/_doc/{_quote(key)}?refresh=true", state)

    def delete_state(self, key: str) -> None:
        self._req("DELETE", f"/{STATE_INDEX}/_doc/{_quote(key)}?refresh=true", ok404=True)

    def states(self) -> dict[str, dict]:
        self._ensure_state()
        res = self._req("POST", f"/{STATE_INDEX}/_search", {"size": 1000, "query": {"match_all": {}}})
        return {h["_id"]: h["_source"] for h in res["hits"]["hits"]}

    # indexes
    def create_index(self, name: str, mapping: dict) -> None:
        self._req("PUT", f"/{name}", mapping)

    def finish_index(self, name: str) -> None:
        self._req("PUT", f"/{name}/_settings", {"index": {"refresh_interval": "1s"}})
        self._req("POST", f"/{name}/_refresh")

    def bulk(self, index: str, ops: list[tuple[str, str, dict | None]]) -> None:
        lines = []
        for op, doc_id, doc in ops:
            lines.append(json.dumps({op: {"_index": index, "_id": doc_id}}))
            if op == "index":
                lines.append(json.dumps(doc, default=str))
        if not lines:
            return
        res = self._req("POST", "/_bulk", "\n".join(lines) + "\n", ndjson=True)
        if res.get("errors"):
            bad = [i for i in res["items"] if next(iter(i.values())).get("error")
                   and next(iter(i.values())).get("status") != 404]
            if bad:
                raise SearchError(f"{len(bad)} documents weren't indexed: {next(iter(bad[0].values()))['error']}")

    def alias_targets(self, alias: str) -> list[str]:
        res = self._req("GET", f"/_alias/{alias}", ok404=True)
        return sorted(res) if res else []

    def swap_alias(self, alias: str, new: str) -> list[str]:
        old = self.alias_targets(alias)
        actions = [{"remove": {"index": o, "alias": alias}} for o in old] + [{"add": {"index": new, "alias": alias}}]
        self._req("POST", "/_aliases", {"actions": actions})
        return [o for o in old if o != new]

    def delete_index(self, name: str) -> None:
        self._req("DELETE", f"/{name}", ok404=True)

    def refresh(self, name: str) -> None:
        self._req("POST", f"/{name}/_refresh")

    def count(self, alias: str) -> int:
        res = self._req("GET", f"/{alias}/_count", ok404=True)
        return int(res["count"]) if res else 0

    def search(self, alias: str, text: str, fields: list[str], limit: int, offset: int) -> list[tuple[str, dict]]:
        text = text.strip()
        if not text:
            query: dict = {"match_all": {}}
        else:
            expanded = [f for name in fields for f in (name, f"{name}._2gram", f"{name}._3gram")]
            query = {"bool": {"minimum_should_match": 1, "should": [
                {"multi_match": {"query": text, "type": "bool_prefix", "fields": expanded}},
                {"multi_match": {"query": text, "fields": fields, "fuzziness": "AUTO", "boost": 0.5}},
                {"term": {PK: {"value": text, "boost": 10}}},
            ]}}
        res = self._req("POST", f"/{alias}/_search", {"from": offset, "size": limit, "query": query,
                                                      "track_total_hits": False})
        return [(h["_id"], h["_source"]) for h in res["hits"]["hits"]]


def _quote(key: str) -> str:
    return urllib.request.quote(key, safe="")


def backend_for(settings) -> OpenSearch | None:
    if not settings.search_url:
        return None
    return OpenSearch(settings.search_url, settings.search_user, settings.search_password)


# ------------------------------------------------------------ names, mapping, documents
def workspace_key(root: Path) -> str:
    return hashlib.sha1(str(Path(root).resolve()).encode()).hexdigest()[:10]


def alias_name(root: Path, api_name: str) -> str:
    return f"prooflix-{workspace_key(root)}-{api_name.lower()}"


def state_key(root: Path, api_name: str) -> str:
    return f"{workspace_key(root)}:{api_name}"


def definition_hash(t: ObjectType) -> str:
    """What the index depends on: the source, row rules and properties (not access or actions)."""
    part = t.model_dump(include={"source", "primary_key", "title", "properties"})
    return hashlib.sha1(json.dumps(part, sort_keys=True).encode()).hexdigest()[:16]


def search_fields(t: ObjectType) -> list[str]:
    return [TITLE] + [p.api_name for p in t.properties if p.searchable and not p.sensitive]


def mapping(t: ObjectType) -> dict:
    props = {PK: {"type": "keyword"}, TITLE: {"type": "search_as_you_type"}}
    for p in t.properties:
        if p.searchable and not p.sensitive:
            props[p.api_name] = {"type": "search_as_you_type"}
    return {
        "settings": {"number_of_shards": 1, "number_of_replicas": 0, "refresh_interval": "-1"},
        "mappings": {"dynamic": False, "properties": props},  # other properties: stored, not searched
    }


def document(t: ObjectType, row: dict) -> tuple[str, dict] | None:
    from .api.sql import _cell  # the SQL Editor's JSON conversion of values

    pk = row.get(t.primary_key)
    if pk is None:
        return None
    doc = {p.api_name: _cell(row.get(p.api_name)) for p in t.properties if not p.sensitive}
    title = row.get(t.title)
    doc[PK] = str(pk)
    doc[TITLE] = "" if title is None else str(_cell(title))
    return str(pk), doc


# ------------------------------------------------------------ jobs
@dataclass
class Job:
    type: str
    kind: str  # "full" or "update"
    state: str = "queued"  # queued, running, done, failed, cancelled
    done: int = 0
    total: int | None = None
    started: str | None = None
    finished: str | None = None
    error: str | None = None
    note: str = ""
    cancel: bool = field(default=False, repr=False)

    def public(self) -> dict:
        d = asdict(self)
        d.pop("cancel")
        return d


class Cancelled(Exception):
    pass


def _table_info(paths, table: str):
    from .api.sql import open_database

    conn, tables = open_database(paths)
    found = next((x for x in tables if x.qualified == table), None)
    return conn, found


def _fingerprint(table_path: Path | None, files: list[Path]) -> str:
    if table_path is not None and delta_log.is_delta_table(table_path):
        return f"delta:{delta_log.current_version(table_path)}"
    parts = sorted(f"{p}:{p.stat().st_size}:{int(p.stat().st_mtime)}" for p in files if p.exists())
    return "files:" + hashlib.sha1("\n".join(parts).encode()).hexdigest()[:16]


def _stream(conn, sql: str, job: Job):
    from .api.sql import _only_select

    sql = _only_select(conn, sql)
    reader = conn.sql(sql).to_arrow_reader(BATCH)  # streamed: rows are never all in memory
    while True:
        if job.cancel:
            raise Cancelled()
        try:
            batch = reader.read_next_batch()
        except StopIteration:
            return
        yield batch.to_pylist()


def build_full(backend: OpenSearch, paths, root: Path, t: ObjectType, job: Job) -> dict:
    """Fill a new index from the object view, then move the alias to it."""
    conn, table = _table_info(paths, t.source.table)
    try:
        if table is None:
            raise SearchError(f"{t.source.table} isn't a table of the catalog")
        fingerprint = _fingerprint(table.path, table.files)
        job.total = table.row_count or None
        alias = alias_name(root, t.api_name)
        name = f"{alias}-{int(time.time() * 1000)}"
        backend.create_index(name, mapping(t))
        try:
            for rows in _stream(conn, f"SELECT * FROM ({object_view(t)}) AS v", job):
                ops = [("index", *d) for d in (document(t, r) for r in rows) if d]
                backend.bulk(name, ops)
                job.done += len(rows)
            backend.finish_index(name)
            for old in backend.swap_alias(alias, name):
                backend.delete_index(old)
        except BaseException:
            backend.delete_index(name)  # never leave half an index behind
            raise
        state = {"type": t.api_name, "alias": alias, "index": name, "fingerprint": fingerprint,
                 "definition": definition_hash(t), "built": _now(), "updated": _now(), "docs": backend.count(alias)}
        backend.put_state(state_key(root, t.api_name), state)
        return state
    finally:
        conn.close()


def update(backend: OpenSearch, paths, root: Path, t: ObjectType, state: dict, job: Job) -> dict:
    """Follow the table's new Delta versions file by file; rebuild when that isn't possible."""
    conn, table = _table_info(paths, t.source.table)
    try:
        if table is None:
            raise SearchError(f"{t.source.table} isn't a table of the catalog")
        fingerprint = _fingerprint(table.path, table.files)
        if fingerprint == state.get("fingerprint"):
            return state
        since = state.get("fingerprint", "")
        if not (since.startswith("delta:") and fingerprint.startswith("delta:")):
            job.note = "the table's files changed"
            raise _Rebuild()
        changes = delta_log.changes_since(table.path, int(since.split(":", 1)[1]))
        if changes.rebuild:
            job.note = changes.reason
            raise _Rebuild()
        files = changes.added + changes.removed
        key_col = q(t.prop(t.primary_key).column)
        keys: list[str] = []
        if files:
            listed = ", ".join("'" + str(p.resolve()).replace("'", "''") + "'" for p in files)
            rows = conn.execute(f"SELECT DISTINCT CAST({key_col} AS VARCHAR) FROM read_parquet([{listed}], "
                                "union_by_name = true)").fetchall()
            keys = [r[0] for r in rows if r[0] is not None]
        if len(keys) > MAX_CHANGED_KEYS:
            job.note = f"{len(keys):,} changed keys"
            raise _Rebuild()
        job.total = len(keys)
        alias = state["alias"]
        pk = q(t.primary_key)
        for i in range(0, len(keys), BATCH):
            if job.cancel:
                raise Cancelled()
            chunk = keys[i : i + BATCH]
            listed = ", ".join("'" + k.replace("'", "''") + "'" for k in chunk)
            found = {}
            for rows in _stream(conn, f"SELECT * FROM ({object_view(t)}) AS v WHERE CAST({pk} AS VARCHAR) IN ({listed})",
                                job):
                for r in rows:
                    d = document(t, r)
                    if d:
                        found[d[0]] = d[1]
            ops = [("index", k, doc) for k, doc in found.items()] + [("delete", k, None) for k in chunk if k not in found]
            backend.bulk(alias, ops)
            job.done += len(chunk)
        backend.refresh(alias)
        state = {**state, "fingerprint": fingerprint, "updated": _now(), "docs": backend.count(alias),
                 "last_changed": len(keys)}
        backend.put_state(state_key(root, t.api_name), state)
        return state
    finally:
        conn.close()


class _Rebuild(Exception):
    pass


def drop(backend: OpenSearch, root: Path, api_name: str) -> None:
    alias = alias_name(root, api_name)
    for name in backend.alias_targets(alias):
        backend.delete_index(name)
    backend.delete_state(state_key(root, api_name))


class Indexer:
    """Runs index jobs one at a time on a worker thread, and watches the indexed tables."""

    def __init__(self, backend_factory=backend_for):
        self.backend_factory = backend_factory
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prooflix-index")
        self._stop = threading.Event()
        self._watcher: threading.Thread | None = None
        self.last_error: str | None = None

    # the app's current settings, workspace and catalog are read on every call (principle 5)
    @staticmethod
    def _context(app):
        from .api.deps import CatalogPaths

        settings = app.state.settings
        root = Path(app.state.workspace.root)
        return settings, root, CatalogPaths(settings.workspace, settings.catalog_dir)

    def request(self, app, t: ObjectType, kind: str = "update") -> Job | None:
        """Queue a job for a type; one already queued or running is kept (a full build wins)."""
        settings, root, paths = self._context(app)
        backend = self.backend_factory(settings)
        if backend is None:
            return None
        key = state_key(root, t.api_name)
        with self.lock:
            current = self.jobs.get(key)
            if current and current.state in ("queued", "running"):
                if kind == "full" and current.kind != "full" and current.state == "queued":
                    current.kind = "full"
                return current
            job = Job(type=t.api_name, kind=kind)
            self.jobs[key] = job
        self.pool.submit(self._run, backend, paths, root, t, job)
        return job

    def cancel(self, app, api_name: str) -> bool:
        _, root, _ = self._context(app)
        job = self.jobs.get(state_key(root, api_name))
        if job and job.state in ("queued", "running"):
            job.cancel = True
            return True
        return False

    def _run(self, backend, paths, root, t, job: Job) -> None:
        job.state, job.started = "running", _now()
        try:
            state = backend.get_state(state_key(root, t.api_name))
            if job.kind == "update" and state and state.get("definition") == definition_hash(t):
                try:
                    update(backend, paths, root, t, state, job)
                except _Rebuild:
                    job.kind, job.done, job.total = "full", 0, None
                    build_full(backend, paths, root, t, job)
            else:
                job.kind = "full"
                build_full(backend, paths, root, t, job)
            job.state = "done"
        except Cancelled:
            job.state = "cancelled"
        except Exception as e:  # noqa: BLE001 - recorded on the job and shown in the tab
            job.state, job.error = "failed", str(e)[:1000]
            log.warning("indexing %s failed: %s", t.api_name, e)
        finally:
            job.finished = _now()

    def status(self, app, types: dict[str, ObjectType]) -> dict:
        """Each type's index: enabled, its state in OpenSearch, and the current job."""
        settings, root, _ = self._context(app)
        backend = self.backend_factory(settings)
        if backend is None:
            return {"configured": False, "ok": False, "error": None, "types": {}}
        try:
            states = backend.states()
        except SearchError as e:
            return {"configured": True, "ok": False, "error": str(e), "types": {}}
        out = {}
        for name, t in types.items():
            key = state_key(root, name)
            state = states.get(key)
            job = self.jobs.get(key)
            stale = bool(state) and state.get("definition") != definition_hash(t)
            out[name] = {"enabled": t.index, "ready": bool(state) and t.index and not stale, "stale": stale,
                         "state": state, "job": job.public() if job else None}
        return {"configured": True, "ok": True, "error": None, "types": out}

    def ready(self, app, t: ObjectType) -> OpenSearch | None:
        """The backend, when this type's index is built for its current definition."""
        if not t.index:
            return None
        settings, root, _ = self._context(app)
        backend = self.backend_factory(settings)
        if backend is None:
            return None
        try:
            state = backend.get_state(state_key(root, t.api_name))
        except SearchError:
            return None
        return backend if state and state.get("definition") == definition_hash(t) else None

    def drop(self, app, api_name: str) -> None:
        settings, root, _ = self._context(app)
        backend = self.backend_factory(settings)
        if backend is None:
            return
        self.cancel(app, api_name)
        try:
            drop(backend, root, api_name)
        except SearchError as e:
            log.warning("index of %s not removed: %s", api_name, e)

    # ---------------------------------------------------------- the watcher
    def tick(self, app) -> None:
        """Queue an update for each indexed type, and remove indexes of types no longer indexed."""
        from . import ontology

        settings, root, _ = self._context(app)
        backend = self.backend_factory(settings)
        if backend is None:
            return
        published = {t.api_name: t for t in ontology.load_all(root)[0]}
        try:
            states = backend.states()
        except SearchError as e:
            self.last_error = str(e)
            return
        self.last_error = None
        prefix = workspace_key(root) + ":"
        for key, state in states.items():
            name = key[len(prefix):] if key.startswith(prefix) else None
            if name and (name not in published or not published[name].index):
                self.drop(app, name)
        for t in published.values():
            if not t.index:
                continue
            last = self.jobs.get(state_key(root, t.api_name))
            if last and last.state == "cancelled":
                continue  # cancelled by someone: wait for Rebuild or a new publish
            if last and last.state == "failed" and last.finished and \
                    time.time() - datetime.fromisoformat(last.finished).timestamp() < RETRY_SECONDS:
                continue  # don't retry a failing build every minute
            self.request(app, t, "update" if state_key(root, t.api_name) in states else "full")

    def start(self, app) -> None:
        if self._watcher is not None:
            return

        def loop():
            self._stop.wait(10)
            while not self._stop.is_set():
                try:
                    self.tick(app)
                except Exception as e:  # noqa: BLE001 - the watcher keeps going
                    log.warning("index watcher: %s", e)
                self._stop.wait(WATCH_SECONDS)

        self._watcher = threading.Thread(target=loop, name="prooflix-index-watcher", daemon=True)
        self._watcher.start()

    def stop(self) -> None:
        self._stop.set()
        for job in self.jobs.values():
            job.cancel = True
        self.pool.shutdown(wait=False, cancel_futures=True)

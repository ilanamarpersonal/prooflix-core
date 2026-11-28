"""``/api/ontology`` routes: InsightIQ's Object Model tab (drafts, checks, preview, publish) and
Objects tab (search, object pages, links) over the catalog's tables, read-only (see ``ontology.py``).

Access (``TAB_PATHS``): building and publishing belong to the ``ontology`` tab; reading objects
(``/api/ontology/objects``) to ``objects`` or ``ontology``. On top of that, each type's ``access``
says who sees it and its sensitive properties, and each action who may run it (admins always may).
Versions, actions' edits and the audit log need the object model's database (``ontology_store.py``).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Literal

import duckdb
import pyarrow as pa
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError

from .. import delta_log, link_pipelines, object_assist, object_sets, ontology
from ..ai_assist import AiAssistError
from ..object_assist import ToolError
from ..exports import Exports
from ..auth import User
from ..pipelines import PipelineValidationError
from ..ontology import CheckFailed, ObjectType
from ..ontology_store import OntologyStore, StoreError, store_for
from ..search_index import SearchError, alias_name, backend_for, search_fields
from .deps import CatalogPaths, get_catalog_paths
from .sql import QUERY_TIMEOUT_S, _cell, _only_select, hidden_schemas, open_database

router = APIRouter(prefix="/api/ontology", tags=["ontology"])
log = logging.getLogger(__name__)
MAX_OBJECTS = 200


# ------------------------------------------------------------ helpers
class _Engine:
    """One locked-down DuckDB for a request (the SQL editor's), with a time limit per query."""

    def __init__(self, paths: CatalogPaths):
        self.conn, tables = open_database(paths)
        self.tables = {
            t.qualified: {
                "columns": [n for n, _ in t.columns],
                "types": dict(t.columns),
                "delta": bool(t.path and t.path.is_dir() and delta_log.is_delta_table(t.path)),
                "rows": t.row_count,
                "schema": t.schema,
            }
            for t in tables
        }

    def query(self, sql: str) -> tuple[list[str], list[list]]:
        try:
            sql = _only_select(self.conn, sql)
        except HTTPException as e:
            raise CheckFailed(str(e.detail)) from None
        timer = threading.Timer(QUERY_TIMEOUT_S, self.conn.interrupt)
        timer.start()
        try:
            result = self.conn.sql(sql).to_arrow_table()
        except duckdb.InterruptException:
            raise CheckFailed(f"took longer than {QUERY_TIMEOUT_S:g} seconds and was stopped") from None
        except duckdb.Error as e:
            raise CheckFailed(str(e).split("\n\n")[0]) from None
        finally:
            timer.cancel()
        values = [result.column(i).to_pylist() for i in range(result.num_columns)]
        rows = [[_cell(v) for v in row] for row in zip(*values)] if values else []
        return result.column_names, rows

    def run(self, sql: str) -> list[list]:
        return self.query(sql)[1]

    def close(self) -> None:
        self.conn.close()



def _engine(paths: CatalogPaths = Depends(get_catalog_paths)):
    engine = _Engine(paths)
    try:
        yield engine
    finally:
        engine.close()


def _root(request: Request) -> Path:
    return request.app.state.workspace.root


def _workspace(request: Request) -> str:
    return str(Path(_root(request)).resolve())


def _user(request: Request) -> User | None:
    """The signed-in user, or None while users are off (then everyone may do everything)."""
    if not request.app.state.settings.auth:
        return None
    return getattr(request.state, "user", None)


def _username(request: Request) -> str | None:
    user = _user(request)
    return user.username if user else None


def _store(request: Request) -> OntologyStore | None:
    return store_for(request.app.state.settings)


def _need_store(request: Request) -> OntologyStore:
    store = _store(request)
    if store is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This needs the object model's database: set PROOFLIX_DATABASE_URL (and its user and password) "
            "in Settings & Management → System, then restart the server",
        )
    return store


def _audit(request: Request, event: str, object_type: str | None = None, pk: str | None = None,
           detail: dict | None = None) -> str | None:
    """Record an event; a database that is down never stops a read (the problem is returned)."""
    store = _store(request)
    if store is None:
        return None
    try:
        store.audit(_workspace(request), _username(request), event, object_type, pk, detail)
    except StoreError as e:
        log.warning("audit not recorded: %s", e)
        return str(e)
    return None


def _parse(data: dict) -> ObjectType:
    try:
        return ontology.parse(data)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


def _published(root: Path) -> dict[str, ObjectType]:
    return {t.api_name: t for t in ontology.load_all(root)[0]}


def _visible(request: Request) -> dict[str, ObjectType]:
    """The published types the signed-in user may see."""
    user = _user(request)
    return {n: t for n, t in _published(_root(request)).items() if ontology.can_view(user, t)}


def _published_type(root: Path, name: str) -> ObjectType:
    try:
        found = ontology.load(root, name)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {name}")
    return found[0]


def _visible_type(request: Request, name: str) -> ObjectType:
    t = _published_type(_root(request), name)
    if not ontology.can_view(_user(request), t):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {name}")  # don't reveal it
    return t


def _edits(request: Request, t: ObjectType, pks: list[str]) -> tuple[dict[str, dict], str | None]:
    """Actions' edits of these objects, and the problem when the database can't be read."""
    store = _store(request)
    if store is None or not pks:
        return {}, None
    try:
        return store.latest_edits(_workspace(request), t.api_name, pks), None
    except StoreError as e:
        return {}, str(e)


def _objects(request: Request, t: ObjectType, cols: list[str], rows: list[list]) -> tuple[list[dict], str | None]:
    """Rows as objects: edits laid over, sensitive properties masked for the user."""
    pk_at = cols.index(t.primary_key)
    pks = [str(r[pk_at]) for r in rows if r[pk_at] is not None]
    edits, problem = _edits(request, t, pks)
    see = ontology.can_see_sensitive(_user(request), t)
    return [ontology.to_object(t, cols, r, see, edits.get(str(r[pk_at]))) for r in rows], problem


def _shows_sensitive(request: Request, t: ObjectType, objects: list[dict]) -> bool:
    sensitive = [p.api_name for p in t.properties if p.sensitive]
    return bool(sensitive) and ontology.can_see_sensitive(_user(request), t) and any(
        o["properties"].get(p) is not None for o in objects for p in sensitive
    )


def _fail(e: CheckFailed, what: str) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, f"{what}: {e}")


# ------------------------------------------------------------ Object Model tab
@router.get("/sources")
def sources(paths: CatalogPaths = Depends(get_catalog_paths), engine: _Engine = Depends(_engine)) -> list[dict]:
    """The catalog's tables to build a type from, in any layer, with their columns."""
    hidden = set(hidden_schemas(paths))
    return [
        {"table": name, "layer": ontology.layer_of(name), "delta": t["delta"], "rows": t["rows"],
         "columns": [{"name": c, "type": t["types"][c]} for c in t["columns"]]}
        for name, t in sorted(engine.tables.items())
        if t["schema"] not in hidden
    ]


@router.get("/types")
def types(request: Request) -> dict:
    """Published types and drafts, files that can't be read, and each type's latest version number."""
    root = _root(request)
    published, broken = ontology.load_all(root)
    drafts, broken_drafts = ontology.load_all(root, draft=True)
    versions: dict[str, int] = {}
    store = _store(request)
    if store is not None:
        try:
            versions = store.latest_versions(_workspace(request))
        except StoreError:
            pass
    return {"types": [t.model_dump() for t in published], "drafts": [t.model_dump() for t in drafts],
            "broken": broken + broken_drafts, "versions": versions}


@router.get("/types/{name}")
def get_type(name: str, request: Request) -> dict:
    t = _published_type(_root(request), name)
    modified = (_root(request) / ontology.FOLDER / ontology.file_name(name)).stat().st_mtime
    return {"type": t.model_dump(), "modified": modified, "path": f"ontology/{ontology.file_name(name)}"}


@router.get("/types/{name}/versions")
def type_versions(name: str, request: Request) -> list[dict]:
    """The published versions of a type: number, who and when."""
    store = _need_store(request)
    try:
        return store.versions(_workspace(request), name)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


@router.delete("/types/{name}", status_code=status.HTTP_204_NO_CONTENT)
def unpublish(name: str, request: Request) -> None:
    """Remove a published type (its file). Links of other types to it then fail their checks."""
    try:
        if not ontology.delete(_root(request), name, draft=False):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {name}")
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    request.app.state.indexer.drop(request.app, name)
    link_pipelines.remove(request.app.state.workspace, name)
    _audit(request, "unpublish", name)


class DraftIn(BaseModel):
    type: dict
    modified: float | None = None  # the draft's time when it was opened; None for a new draft


@router.get("/drafts/{name}")
def get_draft(name: str, request: Request) -> dict:
    try:
        found = ontology.load(_root(request), name, draft=True)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No draft of {name}")
    return {"type": found[0].model_dump(), "modified": found[1]}


@router.put("/drafts/{name}")
def save_draft(name: str, body: DraftIn, request: Request) -> dict:
    """Save a draft (after every wizard step). ``409`` when it changed since it was opened."""
    t = _parse(body.type)
    if t.api_name != name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"The draft is named {t.api_name}, not {name}")
    try:
        modified = ontology.save(_root(request), t, body.modified, draft=True)
    except FileExistsError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    return {"type": t.model_dump(), "modified": modified}


@router.delete("/drafts/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_draft(name: str, request: Request) -> None:
    try:
        if not ontology.delete(_root(request), name, draft=True):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No draft of {name}")
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None


class CheckIn(BaseModel):
    type: dict
    steps: list[str] = ["source", "identity", "properties", "links", "actions", "access"]


@router.post("/check")
def check(body: CheckIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """The wizard's checks for a (draft) type against the data, and the numbers behind them."""
    t = _parse(body.type)
    try:
        return ontology.check(t, engine.run, engine.tables, _published(_root(request)), tuple(body.steps))
    except CheckFailed as e:
        raise _fail(e, "The checks couldn't run") from None


@router.get("/principals")
def principals(request: Request) -> list[dict]:
    """The users and roles access rules can name (for the Access step)."""
    users = request.app.state.users.list() if request.app.state.settings.auth else []
    return [{"principal": "role:admin", "label": "Admins"},
            {"principal": "role:user", "label": "Every signed-in user"}] + [
        {"principal": f"user:{u.username}", "label": u.username, "role": u.role}
        for u in users if not u.disabled
    ]


class PreviewIn(BaseModel):
    type: dict
    limit: int = Field(5, ge=1, le=50)
    as_user: str | None = None  # "View as user": as this user would see it (never more than you)


@router.post("/preview")
def preview(body: PreviewIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """Sample objects through the draft's object view, as the signed-in user (or ``as_user``) sees them."""
    t = _parse(body.type)
    me = _user(request)
    see = ontology.can_see_sensitive(me, t)
    visible = True
    if body.as_user:
        other = request.app.state.users.get(body.as_user) if request.app.state.settings.auth else None
        if request.app.state.settings.auth and other is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No user {body.as_user}")
        see = see and ontology.can_see_sensitive(other, t)
        visible = ontology.can_view(other, t)
        _audit(request, "view_as", t.api_name, detail={"as": body.as_user})
    view = ontology.object_view(t)
    try:
        cols, rows = engine.query(f"SELECT * FROM ({view}) AS v LIMIT {body.limit}")
    except CheckFailed as e:
        raise _fail(e, "The objects can't be read") from None
    return {"sql": view, "visible": visible,
            "objects": [ontology.to_object(t, cols, r, see) for r in rows] if visible else []}


class PublishIn(BaseModel):
    type: dict
    modified: float | None = None  # the published file's time when the draft was started; None for a new type


@router.post("/publish")
def publish(body: PublishIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """Run every check on the whole table; when none blocks, write ontology/<type>.yaml, record the
    version, and drop the draft. ``422`` with the blocking checks, ``409`` when the published type
    changed meanwhile."""
    t = _parse(body.type)
    root = _root(request)
    # a computed link's SQL runs on Spark, which can call Java: writing it is an admin power (principle 14)
    me = _user(request)
    if me is not None and me.role != "admin":
        old = _published(root).get(t.api_name)
        before = {k.api_name: (k.sql, k.table) for k in (old.links if old else []) if k.storage == "computed"}
        changed = [k.api_name for k in t.links if k.storage == "computed" and before.get(k.api_name) != (k.sql, k.table)]
        if changed:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                f"Only an admin can publish new or changed computed links ({', '.join(changed)}): "
                                "their SQL runs on Spark")
        if t.ai and not (old and old.ai):  # its objects' values then go to Claude
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Only an admin can open {t.api_name} to AI Assist")
    try:
        result = ontology.check(t, engine.run, engine.tables, _published(root))
    except CheckFailed as e:
        raise _fail(e, "The checks couldn't run") from None
    if not result["ok"]:
        failed = [f"{c['name']} ({c['detail']})" if c["detail"] else c["name"] for c in result["checks"]
                  if c["status"] == "fail" and c["severity"] == "block"]
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not published: " + "; ".join(failed))
    try:
        modified = ontology.save(root, t, body.modified, draft=False)
    except FileExistsError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    ontology.delete(root, t.api_name, draft=True)
    version, problem = None, None
    store = _store(request)
    if store is not None:
        try:
            version = store.record_version(_workspace(request), t.api_name, t.model_dump(), _username(request))
        except StoreError as e:
            problem = str(e)
    problem = _audit(request, "publish", t.api_name, detail={"version": version}) or problem
    # computed links: their pipelines (written, or removed with the links)
    pipelines = {"written": [], "removed": [], "error": None}
    try:
        pipelines = link_pipelines.sync(request.app.state.workspace, t)
    except PipelineValidationError as e:
        pipelines["error"] = "; ".join(e.errors)
    # fast search: (re)index it, or remove an index it no longer wants
    if t.index:
        request.app.state.indexer.request(request.app, t, "update")
    else:
        request.app.state.indexer.drop(request.app, t.api_name)
    return {"type": t.model_dump(), "modified": modified, "path": f"ontology/{ontology.file_name(t.api_name)}",
            "checks": result["checks"], "version": version, "database_error": problem, "pipelines": pipelines}


@router.get("/audit")
def audit_log(
    request: Request,
    limit: int = Query(200, ge=1, le=1000),
    event: str | None = None,
    type: str | None = None,
    user: str | None = None,
) -> list[dict]:
    """The object model's audit log (admins only while users are on)."""
    me = _user(request)
    if me is not None and me.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can read the audit log")
    store = _need_store(request)
    try:
        return store.audit_log(_workspace(request), limit, event, type, user)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


@router.get("/index")
def index_status(request: Request) -> dict:
    """Each published type's fast-search index: enabled, built, stale, documents, and the current job."""
    return request.app.state.indexer.status(request.app, _published(_root(request)))


@router.post("/index/rebuild")
def rebuild_all_indexes(request: Request) -> dict:
    """Rebuild the index of every published type with Fast search on (queued; they run one at a time)."""
    types = [t for t in _published(_root(request)).values() if t.index]
    jobs = [request.app.state.indexer.request(request.app, t, "full") for t in types]
    if types and jobs[0] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Fast search needs OpenSearch: set PROOFLIX_SEARCH_URL in "
                                                       "Settings & Management → System, then restart the server")
    return {"queued": [t.api_name for t in types]}


@router.post("/index/{name}/rebuild")
def rebuild_index(name: str, request: Request) -> dict:
    """Rebuild a type's index from the whole table (a new index, swapped in when complete)."""
    t = _published_type(_root(request), name)
    if not t.index:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Fast search is off for {name}: turn it on in the wizard")
    job = request.app.state.indexer.request(request.app, t, "full")
    if job is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Fast search needs OpenSearch: set PROOFLIX_SEARCH_URL in "
                                                       "Settings & Management → System, then restart the server")
    return job.public()


@router.post("/index/{name}/cancel")
def cancel_index(name: str, request: Request) -> dict:
    return {"cancelled": request.app.state.indexer.cancel(request.app, name)}


# ------------------------------------------------------------ Objects tab
@router.get("/objects/status")
def objects_status(request: Request) -> dict:
    """Whether the object model's database (actions, history, audit) is set and reachable."""
    store = _store(request)
    database = store.status() if store else {"configured": False, "ok": False, "kind": None, "error": None}
    backend = backend_for(request.app.state.settings)
    search = backend.status() if backend else {"configured": False, "ok": False, "version": None, "error": None}
    me = _user(request)
    return {"database": database, "search": search, "admin": me is None or me.role == "admin"}


@router.get("/objects/types")
def object_types(request: Request) -> list[dict]:
    """The published types the user may see, each with its links (both ways, to types they see too),
    the actions they may run, and whether they see sensitive properties."""
    visible = _visible(request)
    me = _user(request)
    return [
        {
            **t.model_dump(exclude={"access"}),
            "all_links": ontology.links_of(t.api_name, visible),
            "my_actions": [a.api_name for a in t.actions if ontology.can_run(me, a)],
            "sees_sensitive": ontology.can_see_sensitive(me, t),
            "indexed": request.app.state.indexer.ready(request.app, t) is not None,
        }
        for t in visible.values()
    ]


@router.get("/objects/search")
def search(
    request: Request,
    q: str = Query("", max_length=200),
    type: str | None = None,
    limit: int = Query(10, ge=1, le=MAX_OBJECTS),
    offset: int = Query(0, ge=0),
    engine: _Engine = Depends(_engine),
) -> dict:
    """Objects whose key or searchable properties contain ``q``, grouped by type (one type with ``type``).
    Matching uses the table's values; actions' edits are shown, not searched."""
    visible = _visible(request)
    chosen = [visible[type]] if type in visible else ([] if type else list(visible.values()))
    if type and not chosen:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {type}")
    groups = []
    for t in chosen:
        engine_used, note = "lake", None
        rows: list[list] | None = None
        cols = [p.api_name for p in t.properties]
        backend = request.app.state.indexer.ready(request.app, t)
        if backend is not None:  # fast search: the type's index (sensitive properties aren't in it)
            try:
                hits = backend.search(alias_name(_root(request), t.api_name), q, search_fields(t), limit + 1, offset)
                rows = [[(doc_id if c == t.primary_key and src.get(c) is None else src.get(c)) for c in cols]
                        for doc_id, src in hits]
                engine_used = "index"
            except SearchError as e:
                note = f"the index can't be searched, so the lake was: {e}"
        if rows is None:
            try:
                cols, rows = engine.query(ontology.search_sql(t, q, limit + 1, offset))
            except CheckFailed as e:
                groups.append({"type": t.api_name, "objects": [], "more": False, "error": str(e), "engine": "lake"})
                continue
        objects, _ = _objects(request, t, cols, rows[:limit])
        if _shows_sensitive(request, t, objects):
            _audit(request, "read_sensitive", t.api_name, detail={"search": q, "objects": len(objects)})
        groups.append({"type": t.api_name, "objects": objects, "more": len(rows) > limit, "error": None,
                       "engine": engine_used, "note": note})
    return {"groups": groups}


@router.get("/objects/suggest")
def suggest(request: Request, q: str = Query("", max_length=100), limit: int = Query(8, ge=1, le=20)) -> list[dict]:
    """Autocomplete for the search box: titles that start with what was typed, from the indexed types."""
    if not q.strip():
        return []
    out: list[dict] = []
    for t in _visible(request).values():
        backend = request.app.state.indexer.ready(request.app, t)
        if backend is None:
            continue
        try:
            hits = backend.search(alias_name(_root(request), t.api_name), q, search_fields(t), 5, 0)
        except SearchError:
            continue
        out += [{"type": t.api_name, "pk": doc_id, "title": src.get("prooflix_title")} for doc_id, src in hits]
    return out[:limit]


@router.get("/objects/{type}/{pk}")
def get_object(type: str, pk: str, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """One object, and its links (both ways) with how many objects each leads to."""
    visible = _visible(request)
    t = _visible_type(request, type)
    try:
        cols, rows = engine.query(ontology.by_value_sql(t, t.primary_key, pk, 2))
    except CheckFailed as e:
        raise _fail(e, "The object can't be read") from None
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No {type} {pk}")
    objects, problem = _objects(request, t, cols, rows[:1])
    obj = objects[0]
    if _shows_sensitive(request, t, objects):
        _audit(request, "read_sensitive", t.api_name, pk)
    raw = dict(zip(cols, rows[0]))
    links = []
    for k in ontology.links_of(type, visible):
        target = visible.get(k["target"])
        value = raw.get(k["here"])
        count, error = 0, None
        if target and value is not None:
            if k["via"] and k["via"]["table"] not in engine.tables:
                error = f"{k['via']['table']} isn't built yet"
            else:
                try:
                    count = engine.run(ontology.linked_sql(target, k, str(value), count=True))[0][0]
                except CheckFailed as e:
                    error = str(e)
        links.append({**k, "count": count, "error": error})
    return {"object": obj, "layer": t.source.layer, "table": t.source.table, "links": links,
            "database_error": problem}


@router.get("/objects/{type}/{pk}/links/{link}")
def linked(
    type: str,
    pk: str,
    link: str,
    request: Request,
    limit: int = Query(50, ge=1, le=MAX_OBJECTS),
    engine: _Engine = Depends(_engine),
) -> dict:
    """The objects a link leads to from one object."""
    visible = _visible(request)
    t = _visible_type(request, type)
    k = next((x for x in ontology.links_of(type, visible) if x["name"] == link), None)
    if k is None or k["target"] not in visible:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{type} has no link {link}")
    target = visible[k["target"]]
    try:
        cols, rows = engine.query(ontology.by_value_sql(t, t.primary_key, pk, 2))
        if not rows:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No {type} {pk}")
        value = dict(zip(cols, rows[0])).get(k["here"])
        objects: list[dict] = []
        more = False
        if value is not None:
            if k["via"] and k["via"]["table"] not in engine.tables:
                raise HTTPException(status.HTTP_409_CONFLICT, f"{k['via']['table']} isn't built yet: run its pipeline")
            tcols, trows = engine.query(ontology.linked_sql(target, k, str(value), limit + 1))
            objects, _ = _objects(request, target, tcols, trows[:limit])
            more = len(trows) > limit
            if _shows_sensitive(request, target, objects):
                _audit(request, "read_sensitive", target.api_name, detail={"via": f"{type}:{pk}.{link}"})
    except CheckFailed as e:
        raise _fail(e, "The linked objects can't be read") from None
    return {"link": k, "layer": target.source.layer, "objects": objects, "more": more}


class ActionIn(BaseModel):
    values: dict = {}  # property -> value, for the action's parameters
    reason: str = Field("", max_length=1000)


class _ActionRefused(Exception):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def _checked_action(t: ObjectType, action: str, given: dict, reason: str, user) -> tuple:
    """The action and its values, checked as a run checks them (the user may run it, a reason when it
    asks for one, required values, choices, types). _ActionRefused otherwise."""
    a = next((x for x in t.actions if x.api_name == action), None)
    if a is None:
        raise _ActionRefused(f"{t.api_name} has no action {action}", status.HTTP_404_NOT_FOUND)
    if not ontology.can_run(user, a):
        raise _ActionRefused(f"You may not run {a.label or a.api_name}", status.HTTP_403_FORBIDDEN)
    if a.require_reason and not reason.strip():
        raise _ActionRefused("Give a reason: it goes into the audit log", status.HTTP_422_UNPROCESSABLE_CONTENT)
    params = {x.property: x for x in a.parameters}
    unknown = sorted(set(given) - set(params))
    if unknown:
        raise _ActionRefused(f"{a.api_name} doesn't set {', '.join(unknown)}", status.HTTP_422_UNPROCESSABLE_CONTENT)
    values = {}
    for prop, x in params.items():
        raw = given.get(prop)
        if raw is None or str(raw).strip() == "":
            if x.required:
                raise _ActionRefused(f"{x.label or prop} is required", status.HTTP_422_UNPROCESSABLE_CONTENT)
            if prop not in given:
                continue
        if x.choices and raw not in (None, "") and str(raw) not in x.choices:
            raise _ActionRefused(f"{x.label or prop}: choose one of {', '.join(x.choices)}",
                                 status.HTTP_422_UNPROCESSABLE_CONTENT)
        try:
            values[prop] = ontology.coerce(t.prop(prop), raw)
        except ValueError as e:
            raise _ActionRefused(str(e), status.HTTP_422_UNPROCESSABLE_CONTENT) from None
    return a, values


@router.post("/objects/{type}/{pk}/actions/{action}")
def run_action(type: str, pk: str, action: str, body: ActionIn, request: Request,
               engine: _Engine = Depends(_engine)) -> dict:
    """Apply an action to one object: validated, recorded as edits in the database (never in the
    lake), and audited. ``403`` when the user may not run it."""
    store = _need_store(request)
    t = _visible_type(request, type)
    try:
        a, values = _checked_action(t, action, body.values, body.reason, _user(request))
    except _ActionRefused as e:
        raise HTTPException(e.status, str(e)) from None
    try:
        cols, rows = engine.query(ontology.by_value_sql(t, t.primary_key, pk, 2))
    except CheckFailed as e:
        raise _fail(e, "The object can't be read") from None
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No {type} {pk}")
    try:
        store.apply_edit(_workspace(request), t.api_name, pk, a.api_name, values, body.reason.strip(),
                         _username(request))
        store.audit(_workspace(request), _username(request), "action", t.api_name, pk,
                    {"action": a.api_name, "values": {k: (ontology.MASK if t.prop(k).sensitive else v)
                                                      for k, v in values.items()}, "reason": body.reason.strip()})
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    objects, _ = _objects(request, t, cols, rows[:1])
    return {"object": objects[0]}


@router.get("/objects/{type}/{pk}/history")
def history(type: str, pk: str, request: Request) -> dict:
    """The actions applied to one object, newest first (sensitive values masked for the user)."""
    t = _visible_type(request, type)
    store = _store(request)
    if store is None:
        return {"available": False, "error": None, "runs": []}
    try:
        runs = store.history(_workspace(request), t.api_name, pk)
    except StoreError as e:
        return {"available": False, "error": str(e), "runs": []}
    if not ontology.can_see_sensitive(_user(request), t):
        sensitive = {p.api_name for p in t.properties if p.sensitive}
        for r in runs:
            r["values"] = {k: (ontology.MASK if k in sensitive else v) for k, v in r["values"].items()}
    return {"available": True, "error": None, "runs": runs}


# ------------------------------------------------------------ Object sets tab
def _parse_set(data: dict) -> object_sets.ObjectSet:
    try:
        return object_sets.ObjectSet.model_validate(data)
    except ValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, ontology.errors(e)) from None


def _compile(request: Request, s: object_sets.ObjectSet, tables: dict) -> tuple[list[dict], dict[str, ObjectType]]:
    visible = _visible(request)
    try:
        stages = object_sets.compile(s, visible, _user(request))
    except object_sets.SetError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    missing = [t for t in object_sets.link_tables(s, visible) if t not in tables]
    if missing:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{', '.join(missing)} isn't built yet: run its pipeline")
    return stages, visible


class SetRunIn(BaseModel):
    set: dict
    limit: int = Field(50, ge=1, le=MAX_OBJECTS)
    offset: int = Field(0, ge=0)


@router.post("/sets/run")
def run_set(body: SetRunIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """Run a set: how many objects each step gives, and a page of the last step's objects."""
    s = _parse_set(body.set)
    stages, visible = _compile(request, s, engine.tables)
    steps = []
    try:
        for st in stages:
            steps.append({"type": st["type"], "link": st["link"], "count": int(engine.run(object_sets.count_sql(st))[0][0])})
        last = stages[-1]
        t = visible[last["type"]]
        cols, rows = engine.query(object_sets.page_sql(last, t, body.limit + 1, body.offset))
    except CheckFailed as e:
        raise _fail(e, "The set can't run") from None
    objects, _ = _objects(request, t, cols, rows[: body.limit])
    if _shows_sensitive(request, t, objects):
        _audit(request, "read_sensitive", t.api_name, detail={"set": s.model_dump(), "objects": len(objects)})
    return {"steps": steps, "objects": objects, "more": len(rows) > body.limit, "sql": last["sql"]}


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=1000)
    shared: bool = False
    set: dict


def _set_owner_check(request: Request, saved: dict) -> None:
    me = _user(request)
    if me is not None and me.role != "admin" and saved["owner"] != me.username:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Only {saved['owner']} or an admin can change this set")


@router.get("/sets")
def list_sets(request: Request) -> dict:
    """The user's own sets and the shared ones."""
    store = _store(request)
    if store is None:
        return {"available": False, "sets": []}
    try:
        return {"available": True, "sets": store.list_sets(_workspace(request), _username(request))}
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


@router.post("/sets", status_code=status.HTTP_201_CREATED)
def create_set(body: SetIn, request: Request) -> dict:
    s = _parse_set(body.set)
    store = _need_store(request)
    try:
        set_id = store.save_set(_workspace(request), None, body.name.strip(), body.description, _username(request),
                                body.shared, s.model_dump())
        return store.get_set(_workspace(request), set_id)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


def _saved_set(request: Request, store: OntologyStore, set_id: int) -> dict:
    try:
        saved = store.get_set(_workspace(request), set_id)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    me = _user(request)
    if saved is None or (me is not None and me.role != "admin" and not saved["shared"] and saved["owner"] != me.username):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No object set {set_id}")
    return saved


@router.put("/sets/{set_id}")
def update_set(set_id: int, body: SetIn, request: Request) -> dict:
    s = _parse_set(body.set)
    store = _need_store(request)
    saved = _saved_set(request, store, set_id)
    _set_owner_check(request, saved)
    try:
        store.save_set(_workspace(request), set_id, body.name.strip(), body.description, saved["owner"], body.shared,
                       s.model_dump())
        return store.get_set(_workspace(request), set_id)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


@router.delete("/sets/{set_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_set(set_id: int, request: Request) -> None:
    store = _need_store(request)
    saved = _saved_set(request, store, set_id)
    _set_owner_check(request, saved)
    try:
        store.delete_set(_workspace(request), set_id)
    except StoreError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


# ------------------------------------------------------------ exports
class ExportIn(BaseModel):
    set: dict
    format: Literal["csv", "parquet"] = "csv"
    name: str = Field("objects", min_length=1, max_length=80)


def _export_folder(request: Request) -> Path:
    folder = Exports.folder(request.app.state.settings.home)
    if folder is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Exports need PROOFLIX_HOME (a folder for server state)")
    return folder


@router.post("/exports", status_code=status.HTTP_202_ACCEPTED)
def start_export(body: ExportIn, request: Request, paths: CatalogPaths = Depends(get_catalog_paths)) -> dict:
    """Export a set's last step to CSV or Parquet in the background (as the user sees it; kept 24 hours)."""
    s = _parse_set(body.set)
    folder = _export_folder(request)
    probe = _Engine(paths)
    try:
        stages, visible = _compile(request, s, probe.tables)
    finally:
        probe.close()
    last = stages[-1]
    t = visible[last["type"]]
    me = _user(request)
    see = ontology.can_see_sensitive(me, t)
    store = _store(request)
    workspace = _workspace(request)
    editable = {x.property for a in t.actions for x in a.parameters}  # may hold edited values: always text
    masked = {p.api_name for p in t.properties if p.sensitive and not see}

    def run(export, write):
        engine = _Engine(paths)
        try:
            export.total = int(engine.run(object_sets.count_sql(last))[0][0])
            reader = engine.conn.sql(last["sql"]).to_arrow_reader(20_000)
            for batch in reader:
                table = pa.Table.from_batches([batch])
                if store is not None and editable:
                    pks = [str(v) for v in table.column(t.primary_key).to_pylist() if v is not None]
                    edits = store.latest_edits(workspace, t.api_name, pks)
                    for name in editable & set(table.column_names):
                        values = [None if v is None else str(v) for v in table.column(name).to_pylist()]
                        for i, pk in enumerate(table.column(t.primary_key).to_pylist()):
                            e = edits.get(str(pk), {}).get(name)
                            if e is not None:
                                values[i] = None if e["value"] is None else str(e["value"])
                        table = table.set_column(table.column_names.index(name), name, pa.array(values, pa.string()))
                for name in masked & set(table.column_names):
                    col = table.column(name)
                    values = [None if v is None else ontology.MASK for v in col.to_pylist()]
                    table = table.set_column(table.column_names.index(name), name, pa.array(values, pa.string()))
                if not write(table):
                    break
        finally:
            engine.close()

    e = request.app.state.exports.start(folder, _username(request), body.name.strip(), t.api_name, body.format, run)
    _audit(request, "export", t.api_name, detail={"set": s.model_dump(), "format": body.format,
                                                  "sensitive": bool(see and any(p.sensitive for p in t.properties))})
    return asdict(e)


@router.get("/exports")
def list_exports(request: Request) -> list[dict]:
    me = _user(request)
    folder = Exports.folder(request.app.state.settings.home)
    return request.app.state.exports.list(folder, _username(request), me is None or me.role == "admin")


def _own_export(request: Request, export_id: str):
    folder = _export_folder(request)
    e = request.app.state.exports.get(folder, export_id)
    me = _user(request)
    if e is None or (me is not None and me.role != "admin" and e.owner != me.username):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such export")
    return folder, e


@router.get("/exports/{export_id}/file")
def export_file(export_id: str, request: Request) -> FileResponse:
    folder, e = _own_export(request, export_id)
    path = request.app.state.exports.file(folder, e)
    if e.state != "done" or not path.is_file():
        raise HTTPException(status.HTTP_409_CONFLICT, "The export isn't ready")
    safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in e.name).strip() or "objects"
    media = "text/csv" if e.format == "csv" else "application/vnd.apache.parquet"
    return FileResponse(path, media_type=media, filename=f"{safe}.{e.format}")


@router.delete("/exports/{export_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_export(export_id: str, request: Request) -> None:
    folder, e = _own_export(request, export_id)
    request.app.state.exports.delete(folder, e)


# ------------------------------------------------------------ AI Assist on objects
class AssistTurn(BaseModel):
    question: str = ""
    answer: str = ""


class AssistIn(BaseModel):
    question: str = Field(..., min_length=1)
    turns: list[AssistTurn] = Field(default_factory=list, max_length=100)


@router.post("/objects/assist")
def assist(body: AssistIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """AI Assist answers a question about objects by calling tools (``object_assist.py``) that run as
    the user, on the types an admin opened to AI Assist, with sensitive properties always masked. Actions
    are only proposed. Every tool call is audited."""
    me = _user(request)
    types = {n: t for n, t in _visible(request).items() if t.ai}
    if not types:
        raise HTTPException(status.HTTP_409_CONFLICT, "No object type is open to AI Assist yet: an admin turns it on "
                                                       "in the type's Access step")

    def typ(name: str) -> ObjectType:
        if name not in types:
            raise ToolError(f"there is no type {name} you can use (call list_object_types)")
        return types[name]

    def rows_to_objects(t: ObjectType, cols: list[str], rows: list[list]) -> list[dict]:
        pk_at = cols.index(t.primary_key)
        pks = [str(r[pk_at]) for r in rows if r[pk_at] is not None]
        edits, _ = _edits(request, t, pks)
        out = []
        for r in rows:
            o = ontology.to_object(t, cols, r, False, edits.get(str(r[pk_at])))  # sensitive: never to Claude
            out.append({"type": t.api_name, "key": o["pk"], "title": o["title"], "properties": o["properties"]})
        return out

    def query(sql: str) -> tuple[list[str], list[list]]:
        try:
            return engine.query(sql)
        except CheckFailed as e:
            raise ToolError(str(e)) from None

    def limit(n) -> int:
        return max(1, min(int(n or 10), object_assist.MAX_ROWS))

    def list_object_types(_: dict) -> dict:
        return {"types": [{
            "type": t.api_name, "plural": t.plural, "description": t.description, "key": t.primary_key,
            "title": t.title, "layer": t.source.layer,
            "properties": [{"name": p.api_name, "type": p.type, "unit": p.unit, "description": p.description,
                            "searchable": p.searchable, "sensitive": p.sensitive} for p in t.properties],
            "links": [{"name": k["name"], "to": k["target"], "many": k["many"]} for k in ontology.links_of(n, types)],
            "actions": [{"name": a.api_name, "label": a.label, "description": a.description,
                         "sets": [{"property": x.property, "choices": x.choices, "required": x.required}
                                  for x in a.parameters], "needs_reason": a.require_reason}
                        for a in t.actions if ontology.can_run(me, a)],
        } for n, t in types.items()]}

    def search_objects(i: dict) -> dict:
        t = typ(i["type"])
        cols, rows = query(ontology.search_sql(t, i.get("text", ""), limit(i.get("limit")), 0))
        return {"objects": rows_to_objects(t, cols, rows)}

    def find(t: ObjectType, key: str) -> tuple[list[str], list]:
        cols, rows = query(ontology.by_value_sql(t, t.primary_key, str(key), 2))
        if not rows:
            raise ToolError(f"no {t.api_name} {key}")
        return cols, rows[0]

    def get_object(i: dict) -> dict:
        t = typ(i["type"])
        cols, row = find(t, i["key"])
        raw = dict(zip(cols, row))
        links = []
        for k in ontology.links_of(t.api_name, types):
            target, value = types.get(k["target"]), raw.get(k["here"])
            if target is None or value is None or (k["via"] and k["via"]["table"] not in engine.tables):
                continue
            count = query(ontology.linked_sql(target, k, str(value), count=True))[1][0][0]
            links.append({"name": k["name"], "to": k["target"], "count": count})
        return {"object": rows_to_objects(t, cols, [row])[0], "links": links}

    def list_links(i: dict) -> dict:
        t = typ(i["type"])
        k = next((x for x in ontology.links_of(t.api_name, types) if x["name"] == i["link"]), None)
        if k is None or k["target"] not in types:
            raise ToolError(f"{t.api_name} has no link {i['link']}")
        if k["via"] and k["via"]["table"] not in engine.tables:
            raise ToolError(f"the link {i['link']} isn't built yet")
        cols, row = find(t, i["key"])
        value = dict(zip(cols, row)).get(k["here"])
        if value is None:
            return {"objects": []}
        target = types[k["target"]]
        tcols, trows = query(ontology.linked_sql(target, k, str(value), limit(i.get("limit"))))
        return {"objects": rows_to_objects(target, tcols, trows)}

    def run_object_set(i: dict) -> dict:
        try:
            s = object_sets.ObjectSet.model_validate({"type": i["type"], "filters": i.get("filters", []),
                                                      "steps": i.get("steps", [])})
            stages = object_sets.compile(s, types, me, sensitive_ok=False)
        except (ValidationError, object_sets.SetError) as e:
            raise ToolError(ontology.errors(e) if isinstance(e, ValidationError) else str(e)) from None
        missing = [x for x in object_sets.link_tables(s, types) if x not in engine.tables]
        if missing:
            raise ToolError(f"{', '.join(missing)} isn't built yet")
        steps = [{"type": st["type"], "link": st["link"], "count": int(query(object_sets.count_sql(st))[1][0][0])}
                 for st in stages]
        t = types[stages[-1]["type"]]
        cols, rows = query(object_sets.page_sql(stages[-1], t, limit(i.get("limit")), 0))
        return {"steps": steps, "objects": rows_to_objects(t, cols, rows)}

    def propose_action(i: dict) -> dict:
        t = typ(i["type"])
        given = {v["property"]: v["value"] for v in i.get("values", [])}
        try:
            a, values = _checked_action(t, i["action"], given, i.get("reason", ""), me)
        except _ActionRefused as e:
            raise ToolError(str(e)) from None
        cols, row = find(t, i["key"])
        title = dict(zip(cols, row)).get(t.title)
        return {"type": t.api_name, "key": str(i["key"]), "title": None if title is None else str(title),
                "action": a.api_name, "label": a.label or a.api_name, "values": values,
                "reason": i.get("reason", "").strip()}

    def on_tool(name: str, given: dict, error: str | None) -> None:
        _audit(request, "ai_tool", given.get("type"), given.get("key"), {"tool": name, "input": given, "error": error})

    tools = {"list_object_types": list_object_types, "search_objects": search_objects, "get_object": get_object,
             "list_links": list_links, "run_object_set": run_object_set, "propose_action": propose_action}
    _audit(request, "ai_question", detail={"question": body.question[:2000]})
    try:
        return object_assist.ask(request.app.state.ai_assist.get(), body.question,
                                 [t.model_dump() for t in body.turns], tools, on_tool)
    except AiAssistError as e:
        raise HTTPException(e.status, str(e)) from None

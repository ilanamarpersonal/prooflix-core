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
from pathlib import Path

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from .. import delta_log, ontology
from ..auth import User
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
    # fast search: (re)index it, or remove an index it no longer wants
    if t.index:
        request.app.state.indexer.request(request.app, t, "update")
    else:
        request.app.state.indexer.drop(request.app, t.api_name)
    return {"type": t.model_dump(), "modified": modified, "path": f"ontology/{ontology.file_name(t.api_name)}",
            "checks": result["checks"], "version": version, "database_error": problem}


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
            try:
                count = engine.run(f"SELECT count(*) FROM ({ontology.object_view(target)}) AS v "
                                   f"WHERE CAST({ontology.q(k['there'])} AS VARCHAR) = {ontology.lit(str(value))}")[0][0]
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
            tcols, trows = engine.query(ontology.by_value_sql(target, k["there"], str(value), limit + 1))
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


@router.post("/objects/{type}/{pk}/actions/{action}")
def run_action(type: str, pk: str, action: str, body: ActionIn, request: Request,
               engine: _Engine = Depends(_engine)) -> dict:
    """Apply an action to one object: validated, recorded as edits in the database (never in the
    lake), and audited. ``403`` when the user may not run it."""
    store = _need_store(request)
    t = _visible_type(request, type)
    a = next((x for x in t.actions if x.api_name == action), None)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{type} has no action {action}")
    if not ontology.can_run(_user(request), a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"You may not run {a.label or a.api_name}")
    if a.require_reason and not body.reason.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Give a reason: it goes into the audit log")
    params = {x.property: x for x in a.parameters}
    unknown = sorted(set(body.values) - set(params))
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{a.api_name} doesn't set {', '.join(unknown)}")
    values = {}
    for prop, x in params.items():
        raw = body.values.get(prop)
        if raw is None or str(raw).strip() == "":
            if x.required:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{x.label or prop} is required")
            if prop not in body.values:
                continue
        if x.choices and raw not in (None, "") and str(raw) not in x.choices:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                f"{x.label or prop}: choose one of {', '.join(x.choices)}")
        try:
            values[prop] = ontology.coerce(t.prop(prop), raw)
        except ValueError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
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

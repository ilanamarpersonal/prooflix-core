"""``/api/ontology`` routes: InsightIQ's Object Model tab (drafts, checks, preview, publish) and
Objects tab (search, object pages, links) over the catalog's tables, read-only (see ``ontology.py``).

Access (``TAB_PATHS``): building and publishing belong to the ``ontology`` tab; reading objects
(``/api/ontology/objects``) to ``objects`` or ``ontology``. Sensitive properties are masked for
everyone but admins while users are on.
"""

from __future__ import annotations

import threading
from pathlib import Path

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from .. import delta_log, ontology
from ..ontology import CheckFailed, ObjectType
from .deps import CatalogPaths, get_catalog_paths
from .sql import QUERY_TIMEOUT_S, _cell, _only_select, hidden_schemas, open_database

router = APIRouter(prefix="/api/ontology", tags=["ontology"])
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


def _parse(data: dict) -> ObjectType:
    try:
        return ontology.parse(data)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


def _published(root: Path) -> dict[str, ObjectType]:
    return {t.api_name: t for t in ontology.load_all(root)[0]}


def _published_type(root: Path, name: str) -> ObjectType:
    try:
        found = ontology.load(root, name)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {name}")
    return found[0]


def _can_see_sensitive(request: Request) -> bool:
    if not request.app.state.settings.auth:
        return True
    user = getattr(request.state, "user", None)
    return user is not None and user.role == "admin"


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
    """Published types and drafts, and definition files that can't be read."""
    root = _root(request)
    published, broken = ontology.load_all(root)
    drafts, broken_drafts = ontology.load_all(root, draft=True)
    return {"types": [t.model_dump() for t in published], "drafts": [t.model_dump() for t in drafts],
            "broken": broken + broken_drafts}


@router.get("/types/{name}")
def get_type(name: str, request: Request) -> dict:
    t = _published_type(_root(request), name)
    modified = (_root(request) / ontology.FOLDER / ontology.file_name(name)).stat().st_mtime
    return {"type": t.model_dump(), "modified": modified, "path": f"ontology/{ontology.file_name(name)}"}


@router.delete("/types/{name}", status_code=status.HTTP_204_NO_CONTENT)
def unpublish(name: str, request: Request) -> None:
    """Remove a published type (its file). Links of other types to it then fail their checks."""
    try:
        if not ontology.delete(_root(request), name, draft=False):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {name}")
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None


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
    steps: list[str] = ["source", "identity", "properties", "links"]


@router.post("/check")
def check(body: CheckIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """The wizard's checks for a (draft) type against the data, and the numbers behind them."""
    t = _parse(body.type)
    try:
        return ontology.check(t, engine.run, engine.tables, _published(_root(request)), tuple(body.steps))
    except CheckFailed as e:
        raise _fail(e, "The checks couldn't run") from None


class PreviewIn(BaseModel):
    type: dict
    limit: int = Field(5, ge=1, le=50)


@router.post("/preview")
def preview(body: PreviewIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """Sample objects through the draft's object view, as the signed-in user sees them."""
    t = _parse(body.type)
    view = ontology.object_view(t)
    try:
        cols, rows = engine.query(f"SELECT * FROM ({view}) AS v LIMIT {body.limit}")
    except CheckFailed as e:
        raise _fail(e, "The objects can't be read") from None
    see = _can_see_sensitive(request)
    return {"sql": view, "objects": [ontology.to_object(t, cols, r, see) for r in rows]}


class PublishIn(BaseModel):
    type: dict
    modified: float | None = None  # the published file's time when the draft was started; None for a new type


@router.post("/publish")
def publish(body: PublishIn, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """Run every check on the whole table; when none blocks, write ontology/<type>.yaml and drop the
    draft. ``422`` with the blocking checks, ``409`` when the published type changed meanwhile."""
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
    return {"type": t.model_dump(), "modified": modified, "path": f"ontology/{ontology.file_name(t.api_name)}",
            "checks": result["checks"]}


# ------------------------------------------------------------ Objects tab
@router.get("/objects/types")
def object_types(request: Request) -> list[dict]:
    """The published types, for the Objects tab (with the links each has, both ways)."""
    published = _published(_root(request))
    return [{**t.model_dump(), "all_links": ontology.links_of(t.api_name, published)} for t in published.values()]


@router.get("/objects/search")
def search(
    request: Request,
    q: str = Query("", max_length=200),
    type: str | None = None,
    limit: int = Query(10, ge=1, le=MAX_OBJECTS),
    offset: int = Query(0, ge=0),
    engine: _Engine = Depends(_engine),
) -> dict:
    """Objects whose key or searchable properties contain ``q``, grouped by type (one type with ``type``)."""
    published = _published(_root(request))
    chosen = [published[type]] if type in published else ([] if type else list(published.values()))
    if type and not chosen:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No published object type {type}")
    see = _can_see_sensitive(request)
    groups = []
    for t in chosen:
        try:
            cols, rows = engine.query(ontology.search_sql(t, q, limit + 1, offset))
        except CheckFailed as e:
            groups.append({"type": t.api_name, "objects": [], "more": False, "error": str(e)})
            continue
        groups.append({"type": t.api_name, "objects": [ontology.to_object(t, cols, r, see) for r in rows[:limit]],
                       "more": len(rows) > limit, "error": None})
    return {"groups": groups}


@router.get("/objects/{type}/{pk}")
def get_object(type: str, pk: str, request: Request, engine: _Engine = Depends(_engine)) -> dict:
    """One object, and its links (both ways) with how many objects each leads to."""
    root = _root(request)
    published = _published(root)
    t = _published_type(root, type)
    try:
        cols, rows = engine.query(ontology.by_value_sql(t, t.primary_key, pk, 2))
    except CheckFailed as e:
        raise _fail(e, "The object can't be read") from None
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No {type} {pk}")
    obj = ontology.to_object(t, cols, rows[0], _can_see_sensitive(request))
    raw = dict(zip(cols, rows[0]))
    links = []
    for k in ontology.links_of(type, published):
        target = published.get(k["target"])
        value = raw.get(k["here"])
        count, error = 0, None
        if target and value is not None:
            try:
                count = engine.run(f"SELECT count(*) FROM ({ontology.object_view(target)}) AS v "
                                   f"WHERE CAST({ontology.q(k['there'])} AS VARCHAR) = {ontology.lit(str(value))}")[0][0]
            except CheckFailed as e:
                error = str(e)
        links.append({**k, "count": count, "error": error})
    return {"object": obj, "layer": t.source.layer, "table": t.source.table, "links": links}


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
    root = _root(request)
    published = _published(root)
    t = _published_type(root, type)
    k = next((x for x in ontology.links_of(type, published) if x["name"] == link), None)
    if k is None or k["target"] not in published:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{type} has no link {link}")
    target = published[k["target"]]
    see = _can_see_sensitive(request)
    try:
        cols, rows = engine.query(ontology.by_value_sql(t, t.primary_key, pk, 2))
        if not rows:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No {type} {pk}")
        value = dict(zip(cols, rows[0])).get(k["here"])
        objects: list[dict] = []
        more = False
        if value is not None:
            tcols, trows = engine.query(ontology.by_value_sql(target, k["there"], str(value), limit + 1))
            objects = [ontology.to_object(target, tcols, r, see) for r in trows[:limit]]
            more = len(trows) > limit
    except CheckFailed as e:
        raise _fail(e, "The linked objects can't be read") from None
    return {"link": k, "layer": target.source.layer, "objects": objects, "more": more}

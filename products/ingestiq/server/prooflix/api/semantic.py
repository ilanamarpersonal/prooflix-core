"""``/api/semantic`` routes: read, check, save and query the semantic model (the Semantic tab)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ValidationError

from .. import semantic
from ..semantic import SemanticModel
from .deps import CatalogPaths, get_catalog_paths
from .sql import SqlQueryIn, _described_tables, run_query

router = APIRouter(prefix="/api/semantic", tags=["semantic"])


def _root(request: Request):
    return request.app.state.workspace.root


class ModelOut(BaseModel):
    path: str  # relative to the workspace
    exists: bool
    modified: float | None  # send it back when saving
    model: SemanticModel


class SaveIn(BaseModel):
    model: dict
    modified: float | None = None


class QueryIn(BaseModel):
    measures: list[str] = []  # "entity.measure" or a metric name
    dimensions: list[str] = []  # "entity.dimension"
    limit: int = 1000
    model: dict | None = None  # an unsaved draft; None: the saved model


def _parse(data: dict) -> SemanticModel:
    try:
        return SemanticModel.model_validate(data)
    except ValidationError as e:
        msgs = []
        for err in e.errors():
            where = ".".join(str(p) for p in err["loc"])
            msgs.append(f"{where}: {err['msg']}" if where else err["msg"])
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(msgs)) from None


@router.get("", response_model=ModelOut)
def get_model(request: Request) -> ModelOut:
    root = _root(request)
    try:
        model, modified = semantic.load(root)
    except (ValueError, ValidationError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"{semantic.MODEL_FILE} can't be read: {e}") from None
    return ModelOut(path=semantic.MODEL_FILE.as_posix(), exists=modified is not None, modified=modified, model=model)


@router.put("", response_model=ModelOut)
def save_model(body: SaveIn, request: Request) -> ModelOut:
    """Save the model to semantic/model.yaml. ``409`` when it changed since it was opened."""
    model = _parse(body.model)
    try:
        modified = semantic.save(_root(request), model, body.modified)
    except FileExistsError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    return ModelOut(path=semantic.MODEL_FILE.as_posix(), exists=True, modified=modified, model=model)


class TextIn(BaseModel):
    text: str
    modified: float | None = None


@router.get("/yaml")
def get_yaml(request: Request) -> dict:
    """The model file's text, as written, for editing by hand."""
    text, modified = semantic.read_text(_root(request))
    return {"path": semantic.MODEL_FILE.as_posix(), "text": text, "modified": modified}


@router.post("/yaml/validate")
def validate_yaml(body: TextIn) -> dict:
    """Is this text a valid model? (nothing is saved)"""
    try:
        model = semantic.parse_text(body.text)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "error": None, "entities": len(model.entities), "metrics": len(model.metrics)}


@router.put("/yaml", response_model=ModelOut)
def save_yaml(body: TextIn, request: Request) -> ModelOut:
    """Save the text as written once it is a valid model. ``422`` with the reason when not,
    ``409`` when the file changed since it was opened."""
    if len(body.text) > 1_000_000:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The model file is limited to 1 MB")
    try:
        model, modified = semantic.save_text(_root(request), body.text, body.modified)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    except FileExistsError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    return ModelOut(path=semantic.MODEL_FILE.as_posix(), exists=True, modified=modified, model=model)


@router.get("/tables")
def tables(paths: CatalogPaths = Depends(get_catalog_paths)) -> list[dict]:
    """The catalog's tables and their columns, to choose from when editing."""
    return [{"table": t.qualified, "columns": [{"name": n, "type": k} for n, k in t.columns]}
            for t in _described_tables(paths)]


@router.post("/check")
def check(body: SaveIn, paths: CatalogPaths = Depends(get_catalog_paths)) -> dict:
    """Problems with a (draft) model against the catalog: [] when every table, column and
    expression works."""
    model = _parse(body.model)
    problems = []
    for what, sql in semantic.check_sql(model):
        if sql.startswith("--"):
            problems.append({"where": what, "problem": sql[3:]})
            continue
        try:
            run_query(SqlQueryIn(sql=sql, limit=1), paths)
        except HTTPException as e:
            problems.append({"where": what, "problem": str(e.detail)})
    return {"ok": not problems, "problems": problems}


@router.post("/query")
def query(body: QueryIn, request: Request, paths: CatalogPaths = Depends(get_catalog_paths)) -> dict:
    """Run measures by dimensions: the SQL the model writes, and its rows."""
    model = _parse(body.model) if body.model is not None else semantic.load(_root(request))[0]
    limit = max(1, min(body.limit, 10_000))
    try:
        sql = semantic.compile_query(model, body.measures, body.dimensions, limit)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    result = run_query(SqlQueryIn(sql=sql, limit=limit), paths)
    return {"sql": sql, "result": result.model_dump()}

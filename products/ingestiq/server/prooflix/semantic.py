"""The semantic model: business meaning on top of the catalog's tables (the Semantic tab).

The model is a YAML file in the active workspace, ``semantic/model.yaml``, edited in
the Semantic tab and kept on disk (and in git, with the workspace)::

    name: Banking
    entities:
      - name: transactions
        table: tenant1.silver.transactions      # a table of the catalog, as written in SQL
        primary_key: transaction_id
        dimensions:
          - {name: day, sql: "CAST(transactions.transaction_ts AS DATE)", type: time}
          - {name: type, column: transaction_type}
        measures:
          - {name: total_amount, agg: sum, column: amount}
          - {name: count, agg: count}
        joins:
          - {entity: accounts, column: account_id, to_column: account_id}
    metrics:
      - name: average_amount
        sql: "{transactions.total_amount} / NULLIF({transactions.count}, 0)"

- A **dimension** is something to group or filter by; a **measure** an aggregation
  (sum, count, count_distinct, avg, min, max). Either names a ``column`` of the
  entity's table or gives a SQL expression (``sql``) that uses entity names as
  table aliases.
- A **join** links an entity to another by a column of each; a query follows joins
  to reach the dimensions it needs.
- A **metric** is a formula over measures, written ``{entity.measure}``.

``compile_query`` turns a choice of measures and dimensions into one read-only
SELECT that the SQL engine runs, so the model never needs data of its own.
"""

from __future__ import annotations

import os
import re
from collections import deque
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

MODEL_FILE = Path("semantic") / "model.yaml"
NAME = r"^[a-z_][a-z0-9_]*$"
TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$")
REF = re.compile(r"\{([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\}")
AGGS = ("sum", "count", "count_distinct", "avg", "min", "max")
HEADER = (
    "# Semantic model: business meaning on top of the catalog's tables.\n"
    "# Edit it in Prooflix's Semantic tab: the YAML tab saves your text as written; the\n"
    "# Model tab rewrites the file (comments other than these are not kept).\n"
)


class Dimension(BaseModel):
    name: str = Field(pattern=NAME)
    column: str | None = None
    sql: str | None = None  # an expression; entity names are the table aliases
    type: Literal["category", "time", "number"] = "category"
    description: str = ""

    @model_validator(mode="after")
    def _one_source(self):
        if not (self.column or self.sql):
            raise ValueError(f"dimension {self.name}: give a column or a SQL expression")
        return self


class Measure(BaseModel):
    name: str = Field(pattern=NAME)
    agg: Literal["sum", "count", "count_distinct", "avg", "min", "max"] = "sum"
    column: str | None = None  # count may leave it out: COUNT(*)
    sql: str | None = None
    description: str = ""

    @model_validator(mode="after")
    def _source(self):
        if not (self.column or self.sql) and self.agg != "count":
            raise ValueError(f"measure {self.name}: give a column or a SQL expression")
        return self


class Join(BaseModel):
    entity: str = Field(pattern=NAME)
    column: str  # in this entity's table
    to_column: str  # in the other entity's table
    kind: Literal["left", "inner"] = "left"


class Entity(BaseModel):
    name: str = Field(pattern=NAME)
    table: str
    description: str = ""
    primary_key: str | None = None
    dimensions: list[Dimension] = []
    measures: list[Measure] = []
    joins: list[Join] = []

    @field_validator("table")
    @classmethod
    def _table(cls, v: str) -> str:
        if not TABLE.match(v):
            raise ValueError(f"table '{v}': a catalog table as written in SQL, like tenant1.silver.transactions")
        return v


class Metric(BaseModel):
    name: str = Field(pattern=NAME)
    sql: str  # a formula over {entity.measure}
    description: str = ""


class SemanticModel(BaseModel):
    name: str = "Semantic model"
    description: str = ""
    entities: list[Entity] = []
    metrics: list[Metric] = []

    @model_validator(mode="after")
    def _consistent(self):
        names = [e.name for e in self.entities]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"two entities are named {', '.join(sorted(dupes))}")
        by = {e.name: e for e in self.entities}
        for e in self.entities:
            fields = [d.name for d in e.dimensions] + [m.name for m in e.measures]
            twice = {f for f in fields if fields.count(f) > 1}
            if twice:
                raise ValueError(f"entity {e.name}: {', '.join(sorted(twice))} is defined twice")
            for j in e.joins:
                if j.entity not in by:
                    raise ValueError(f"entity {e.name} joins {j.entity}, which isn't an entity")
        metric_names = [m.name for m in self.metrics]
        if len(set(metric_names)) != len(metric_names):
            raise ValueError("two metrics have the same name")
        for m in self.metrics:
            refs = REF.findall(m.sql)
            if not refs:
                raise ValueError(f"metric {m.name}: use measures as {{entity.measure}}")
            for ent, meas in refs:
                if ent not in by or meas not in {x.name for x in by[ent].measures}:
                    raise ValueError(f"metric {m.name}: {{{ent}.{meas}}} isn't a measure")
        return self

    def entity(self, name: str) -> Entity:
        for e in self.entities:
            if e.name == name:
                return e
        raise KeyError(name)


# ------------------------------------------------------------ the file
def model_path(workspace_root: Path) -> Path:
    return Path(workspace_root) / MODEL_FILE


def load(workspace_root: Path) -> tuple[SemanticModel, float | None]:
    """The saved model and its file's modification time (an empty model, None when there is no file)."""
    path = model_path(workspace_root)
    if not path.is_file():
        return SemanticModel(), None
    data = yaml.safe_load(path.read_text()) or {}
    return SemanticModel.model_validate(data), path.stat().st_mtime


def save(workspace_root: Path, model: SemanticModel, modified: float | None) -> float:
    """Write the model; ValueError when the file changed since ``modified`` (someone else saved)."""
    path = model_path(workspace_root)
    if path.is_file() and modified is not None and abs(path.stat().st_mtime - modified) > 1e-6:
        raise FileExistsError("The model changed since you opened it; reload it, then make your change again")
    if path.is_file() and modified is None:
        raise FileExistsError("A model was saved meanwhile; reload it, then make your change again")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = model.model_dump(exclude_defaults=True)
    data.setdefault("name", model.name)
    text = HEADER + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=110)
    tmp = path.with_name(f".{path.name}.saving")
    tmp.write_text(text)
    os.replace(tmp, path)
    return path.stat().st_mtime


def parse_text(text: str) -> SemanticModel:
    """The model a YAML text describes. ValueError with a readable reason when it's not valid."""
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        raise ValueError(f"YAML syntax error{where}: {getattr(e, 'problem', None) or e}") from None
    if not isinstance(data, dict):
        raise ValueError("The file must be a YAML mapping (name:, entities:, metrics:)")
    try:
        return SemanticModel.model_validate(data)
    except ValidationError as e:
        msgs = []
        for err in e.errors():
            where = ".".join(str(p) for p in err["loc"])
            msgs.append(f"{where}: {err['msg']}" if where else err["msg"])
        raise ValueError("; ".join(msgs)) from None


def read_text(workspace_root: Path) -> tuple[str, float | None]:
    """The file's text as written (a starting text when there is no file yet), and its time."""
    path = model_path(workspace_root)
    if not path.is_file():
        return HEADER + "name: Semantic model\nentities: []\nmetrics: []\n", None
    return path.read_text(), path.stat().st_mtime


def save_text(workspace_root: Path, text: str, modified: float | None) -> tuple[SemanticModel, float]:
    """Save a hand-edited file as written (comments and layout kept) once it parses as a
    valid model. ValueError when invalid, FileExistsError when it changed since ``modified``."""
    model = parse_text(text)
    path = model_path(workspace_root)
    if path.is_file() and (modified is None or abs(path.stat().st_mtime - modified) > 1e-6):
        raise FileExistsError("The model changed since you opened it; reload it, then make your change again")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.saving")
    tmp.write_text(text if text.endswith("\n") else text + "\n")
    os.replace(tmp, path)
    return model, path.stat().st_mtime


# ------------------------------------------------------------ SQL
def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _table_sql(table: str) -> str:
    return ".".join(_q(p) for p in table.split("."))


def dimension_sql(e: Entity, d: Dimension) -> str:
    return d.sql if d.sql else f"{_q(e.name)}.{_q(d.column)}"


def measure_sql(e: Entity, m: Measure) -> str:
    inner = m.sql if m.sql else (f"{_q(e.name)}.{_q(m.column)}" if m.column else None)
    if m.agg == "count":
        return f"COUNT({inner or '*'})"
    if m.agg == "count_distinct":
        return f"COUNT(DISTINCT {inner})"
    return f"{m.agg.upper()}({inner})"


def _path(model: SemanticModel, start: str, goal: str) -> list[tuple[str, str, Join, bool]] | None:
    """Joins from start to goal: [(from, to, join, forward)], following joins either way."""
    edges: dict[str, list[tuple[str, Join, bool]]] = {e.name: [] for e in model.entities}
    for e in model.entities:
        for j in e.joins:
            edges[e.name].append((j.entity, j, True))
            edges.setdefault(j.entity, []).append((e.name, j, False))
    seen, queue = {start: []}, deque([start])
    while queue:
        cur = queue.popleft()
        if cur == goal:
            return seen[cur]
        for nxt, j, fwd in edges.get(cur, []):
            if nxt not in seen:
                seen[nxt] = [*seen[cur], (cur, nxt, j, fwd)]
                queue.append(nxt)
    return None


def compile_query(model: SemanticModel, measures: list[str], dimensions: list[str], limit: int = 1000) -> str:
    """One SELECT for these measures ("entity.measure" or a metric name) grouped by these
    dimensions ("entity.dimension"). ValueError when something can't be reached."""
    if not measures and not dimensions:
        raise ValueError("Choose at least one measure or dimension")
    metrics = {m.name: m for m in model.metrics}
    selects: list[str] = []
    needed: list[str] = []  # entities the query uses, in order
    measure_entities: list[str] = []
    dims: list[str] = []

    def entity_of(ref: str) -> tuple[Entity, str]:
        ent, _, field = ref.partition(".")
        try:
            return model.entity(ent), field
        except KeyError:
            raise ValueError(f"No entity {ent}") from None

    def measure_expr(ref: str) -> str:
        e, field = entity_of(ref)
        m = next((x for x in e.measures if x.name == field), None)
        if m is None:
            raise ValueError(f"No measure {ref}")
        needed.append(e.name)
        measure_entities.append(e.name)
        return measure_sql(e, m)

    for d_ref in dimensions:
        e, field = entity_of(d_ref)
        d = next((x for x in e.dimensions if x.name == field), None)
        if d is None:
            raise ValueError(f"No dimension {d_ref}")
        needed.append(e.name)
        dims.append(f"{dimension_sql(e, d)} AS {_q(d_ref)}")
    for m_ref in measures:
        if m_ref in metrics:
            formula = REF.sub(lambda mt: f"({measure_expr(mt.group(1) + '.' + mt.group(2))})", metrics[m_ref].sql)
            selects.append(f"{formula} AS {_q(m_ref)}")
        else:
            selects.append(f"{measure_expr(m_ref)} AS {_q(m_ref)}")

    base = measure_entities[0] if measure_entities else needed[0]  # the first measure's entity
    joins: list[str] = []
    joined = {base}
    for target in dict.fromkeys(needed):
        if target in joined:
            continue
        path = _path(model, base, target)
        if path is None:
            raise ValueError(f"{target} can't be reached from {base}: add a join between them")
        for frm, to, j, fwd in path:
            if to in joined:
                continue
            here, there = (j.column, j.to_column) if fwd else (j.to_column, j.column)
            kind = "JOIN" if j.kind == "inner" else "LEFT JOIN"
            joins.append(
                f"{kind} {_table_sql(model.entity(to).table)} AS {_q(to)} "
                f"ON {_q(frm)}.{_q(here)} = {_q(to)}.{_q(there)}"
            )
            joined.add(to)

    lines = ["SELECT " + ",\n       ".join(dims + selects), f"FROM {_table_sql(model.entity(base).table)} AS {_q(base)}"]
    lines += joins
    if dims and selects:
        lines.append("GROUP BY " + ", ".join(str(i + 1) for i in range(len(dims))))
    if dims:
        lines.append("ORDER BY " + ", ".join(str(i + 1) for i in range(len(dims))))
    lines.append(f"LIMIT {int(limit)}")
    return "\n".join(lines)


def check_sql(model: SemanticModel) -> list[tuple[str, str]]:
    """(what, SELECT) pairs, one per table, field, key and metric, run with no rows (WHERE false)
    so the SQL engine names exactly what is wrong (an unknown table, column or function).
    Expressions that use another entity are checked when a query joins it, in Explore."""
    out = []
    for e in model.entities:
        src = f"FROM {_table_sql(e.table)} AS {_q(e.name)} WHERE false"
        out.append((f"{e.name} (table {e.table})", f"SELECT * {src}"))
        for d in e.dimensions:
            if not d.sql or _only_own_alias(d.sql, e.name):
                out.append((f"{e.name}.{d.name}", f"SELECT {dimension_sql(e, d)} {src}"))
        for m in e.measures:
            if not m.sql or _only_own_alias(m.sql, e.name):
                out.append((f"{e.name}.{m.name}", f"SELECT {measure_sql(e, m)} {src}"))
        for c, what in [(e.primary_key, "primary key")] + [(j.column, f"join to {j.entity}") for j in e.joins]:
            if c:
                out.append((f"{e.name} {what} ({c})", f"SELECT {_q(e.name)}.{_q(c)} {src}"))
        for j in e.joins:
            other = model.entity(j.entity)
            out.append((f"{e.name} join to {j.entity} ({j.to_column})",
                        f"SELECT {_q(j.entity)}.{_q(j.to_column)} FROM {_table_sql(other.table)} AS {_q(j.entity)} "
                        "WHERE false"))
    for m in model.metrics:
        try:
            out.append((f"metric {m.name}", compile_query(model, [m.name], [], limit=0)))
        except ValueError as err:
            out.append((f"metric {m.name}", f"-- {err}"))
    return out


def _only_own_alias(sql: str, entity: str) -> bool:  # noqa: N802
    """True when an expression only uses its own entity's alias (so it can be checked alone)."""
    aliases = set(re.findall(r'"?([a-z_][a-z0-9_]*)"?\.', sql))
    return aliases <= {entity}

"""Object sets: questions built step by step, saved and shared (InsightIQ's Object sets tab).

A set starts from a type with filters, then follows links ("search around"), each step with filters
of its own::

    {"type": "Customer", "filters": [{"property": "city", "op": "eq", "value": "Haifa"}],
     "steps": [{"link": "accounts"},
               {"link": "transactions", "filters": [{"property": "amount", "op": "gt", "value": 10000}]}]}

``compile`` turns it into one SELECT per step over the object views (so row rules, casts and link
tables all apply) and the API counts each step and pages through the last. A set runs with the
viewer's own access: a type they don't see can't be a step, and they can't filter on sensitive
properties they don't see. Filters compare the table's values (actions' edits are shown, not
filtered on).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from . import ontology
from .ontology import FIELD_NAME, TYPE_NAME, ObjectType, lit, object_view, q

MAX_STEPS = 4
OPS = ("eq", "ne", "contains", "gt", "gte", "lt", "lte", "in", "is_null", "not_null")


class Filter(BaseModel):
    property: str = Field(pattern=FIELD_NAME)
    op: Literal["eq", "ne", "contains", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"] = "eq"
    value: Any = None

    @field_validator("value")
    @classmethod
    def _value(cls, v):
        if isinstance(v, list):
            if len(v) > 1000:
                raise ValueError("at most 1000 values")
            return [str(x) for x in v]
        if v is None or isinstance(v, (int, float, bool)):
            return v
        text = str(v)
        if len(text) > 1000:
            raise ValueError("a value is limited to 1000 characters")
        return text


class Step(BaseModel):
    link: str = Field(pattern=FIELD_NAME)
    filters: list[Filter] = Field(default=[], max_length=10)


class ObjectSet(BaseModel):
    type: str = Field(pattern=TYPE_NAME)
    filters: list[Filter] = Field(default=[], max_length=10)
    steps: list[Step] = Field(default=[], max_length=MAX_STEPS)


class SetError(ValueError):
    """The set names something the viewer can't use (a type, link or property)."""


def _value_sql(v) -> str:
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    return lit(str(v))  # DuckDB casts a text value to the column's type (numbers, dates)


def _where(t: ObjectType, filters: list[Filter], alias: str, user, sensitive_ok: bool | None = None) -> list[str]:
    out = []
    names = {p.api_name: p for p in t.properties}
    for f in filters:
        p = names.get(f.property)
        if p is None:
            raise SetError(f"{t.api_name} has no property {f.property}")
        if p.sensitive and not (ontology.can_see_sensitive(user, t) if sensitive_ok is None else sensitive_ok):
            raise SetError(f"{t.api_name}.{f.property} is sensitive: you can't filter on it")
        col = f"{alias}.{q(f.property)}"
        if f.op == "is_null":
            out.append(f"{col} IS NULL")
        elif f.op == "not_null":
            out.append(f"{col} IS NOT NULL")
        elif f.value is None or f.value == "":
            raise SetError(f"{t.api_name}.{f.property}: give a value")
        elif f.op == "contains":
            pattern = "%" + str(f.value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            out.append(f"CAST({col} AS VARCHAR) ILIKE {lit(pattern)} ESCAPE '\\'")
        elif f.op == "in":
            values = f.value if isinstance(f.value, list) else [x.strip() for x in str(f.value).split(",") if x.strip()]
            out.append(f"CAST({col} AS VARCHAR) IN ({', '.join(lit(str(x)) for x in values) or 'NULL'})")
        else:
            sign = {"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.op]
            out.append(f"{col} {sign} {_value_sql(f.value)}")
    return out


def compile(s: ObjectSet, visible: dict[str, ObjectType], user, sensitive_ok: bool | None = None) -> list[dict]:
    """[{type, link, sql}] for each step: the base type, then each link followed. SetError when the set
    names a type, link or property the viewer can't use. ``sensitive_ok=False``: no filters on sensitive
    properties whatever the user may see (AI Assist)."""
    t = visible.get(s.type)
    if t is None:
        raise SetError(f"No object type {s.type}")
    where = _where(t, s.filters, "s0", user, sensitive_ok)
    sql = f"SELECT * FROM ({object_view(t)}) AS s0" + (f" WHERE {' AND '.join(where)}" if where else "")
    out = [{"type": t.api_name, "link": None, "sql": sql}]
    for i, step in enumerate(s.steps, start=1):
        k = next((x for x in ontology.links_of(t.api_name, visible) if x["name"] == step.link), None)
        if k is None or k["target"] not in visible:
            raise SetError(f"{t.api_name} has no link {step.link}")
        target = visible[k["target"]]
        alias = f"s{i}"
        here = f"SELECT CAST(p.{q(k['here'])} AS VARCHAR) FROM ({sql}) AS p"
        if k["via"]:
            via = k["via"]
            here = (f"SELECT CAST({q(via['there'])} AS VARCHAR) FROM {ontology.table_sql(via['table'])} "
                    f"WHERE CAST({q(via['here'])} AS VARCHAR) IN ({here})")
        conds = [f"CAST({alias}.{q(k['there'])} AS VARCHAR) IN ({here})"] + _where(target, step.filters, alias, user,
                                                                                    sensitive_ok)
        sql = f"SELECT * FROM ({object_view(target)}) AS {alias} WHERE {' AND '.join(conds)}"
        out.append({"type": target.api_name, "link": step.link, "sql": sql})
        t = target
    return out


def page_sql(stage: dict, t: ObjectType, limit: int, offset: int) -> str:
    return (f"SELECT * FROM ({stage['sql']}) AS r ORDER BY {q(t.title)} NULLS LAST, {q(t.primary_key)} "
            f"LIMIT {int(limit)} OFFSET {int(offset)}")


def count_sql(stage: dict) -> str:
    return f"SELECT count(*) FROM ({stage['sql']}) AS r"


def link_tables(s: ObjectSet, visible: dict[str, ObjectType]) -> list[str]:
    """The link tables a set reads (they must exist before it can run)."""
    out, t = [], visible.get(s.type)
    for step in s.steps:
        if t is None:
            break
        k = next((x for x in ontology.links_of(t.api_name, visible) if x["name"] == step.link), None)
        if k is None:
            break
        if k["via"]:
            out.append(k["via"]["table"])
        t = visible.get(k["target"])
    return out

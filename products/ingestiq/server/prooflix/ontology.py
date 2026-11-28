"""The ontology (InsightIQ's Object Model and Objects tabs): business objects on top of the catalog's tables.

An **object type** (``Customer``) is backed by one table of the catalog, in any medallion layer
(bronze, silver or gold). Its definition is a YAML file in the active workspace,
``ontology/<name>.yaml``, written by the Object Model tab's wizard (drafts in ``ontology/.drafts/``)::

    api_name: Customer
    plural: Customers
    source:
      table: tenant1.bronze.customers
      layer: bronze               # read from the table's schema when saved
      rows:                       # row rules: how the table's rows become one object per key
        filter: "_op <> 'D'"
        latest_by: _ingested_at   # keep the newest row per key
    primary_key: customer_id      # a property
    title: full_name              # a property
    properties:
      - {api_name: customer_id, column: customer_id}
      - {api_name: balance, column: bal_amt, type: decimal, unit: ILS}   # type: a cast (TRY_CAST)
      - {api_name: national_id, column: id_number, sensitive: true}
    links:
      - {api_name: accounts, target: Account, cardinality: one-to-many, reverse: owner,
         from_property: customer_id, to_property: customer_id}

Every read of a type goes through its **object view** (``object_view``): one read-only SELECT
that applies the row rules and the casts, run by the SQL engine (DuckDB over the catalog's
files, ``api/sql.py``). ``check`` runs the wizard's checks against the data. Nothing here writes
lake data (principle 3).
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Callable, Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

FOLDER = Path("ontology")
DRAFTS = FOLDER / ".drafts"
TYPE_NAME = r"^[A-Z][A-Za-z0-9]{0,63}$"
FIELD_NAME = r"^[a-z][A-Za-z0-9_]{0,63}$"
TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$")
COLUMN = re.compile(r"^[^\"\x00]{1,128}$")
LAYERS = ("bronze", "silver", "gold")
Layer = Literal["bronze", "silver", "gold", "unclassified"]
# the casts a property may ask for, and their DuckDB types
TYPES = {
    "string": "VARCHAR",
    "integer": "BIGINT",
    "number": "DOUBLE",
    "decimal": "DECIMAL(18,4)",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "timestamp": "TIMESTAMP",
}
# a row filter is one boolean expression on the table's own columns: no subqueries or table functions
_FILTER_FORBIDDEN = re.compile(
    r";|--|/\*|\b(select|from|join|union|with|attach|copy|pragma|install|load|export|import|call|query|glob)\b"
    r"|\bread_\w+|\bdelta_scan\b|\bparquet_scan\b",
    re.IGNORECASE,
)
PERSONAL = re.compile(r"(national|id_?num|passport|ssn|phone|mobile|e_?mail|birth|address|iban|card_?n)", re.I)
MATCH_RATE = 0.95  # links below this are a warning
HEADER = "# Object type, written by InsightIQ's Object Model tab (comments are not kept).\n"


class RowRules(BaseModel):
    filter: str | None = None  # one boolean expression on the table's columns
    latest_by: str | None = None  # keep the newest row per key, by this column
    latest_desc: bool = True  # newest = largest value

    @field_validator("filter")
    @classmethod
    def _filter(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        if len(v) > 1000:
            raise ValueError("the filter is limited to 1000 characters")
        if _FILTER_FORBIDDEN.search(v):
            raise ValueError("the filter is one expression on the table's columns (no ;, comments, subqueries or SELECT)")
        return v.strip()

    @field_validator("latest_by")
    @classmethod
    def _latest(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        if not COLUMN.match(v):
            raise ValueError(f"'{v}' isn't a column name")
        return v


class Source(BaseModel):
    table: str
    layer: Layer = "unclassified"
    rows: RowRules = RowRules()

    @field_validator("table")
    @classmethod
    def _table(cls, v: str) -> str:
        if not TABLE.match(v):
            raise ValueError(f"table '{v}': a catalog table as written in SQL, like tenant1.bronze.customers")
        return v

    @model_validator(mode="after")
    def _layer(self):
        self.layer = layer_of(self.table)
        return self


class Property(BaseModel):
    api_name: str = Field(pattern=FIELD_NAME)
    column: str
    label: str = ""
    description: str = ""
    type: Literal["auto", "string", "integer", "number", "decimal", "boolean", "date", "timestamp"] = "auto"
    unit: str = ""
    searchable: bool = False
    sensitive: bool = False

    @field_validator("column")
    @classmethod
    def _column(cls, v: str) -> str:
        if not COLUMN.match(v):
            raise ValueError(f"'{v}' isn't a column name")
        return v


class Link(BaseModel):
    """A named relationship. Stored as a property on each side (``property``), or as a table of key
    pairs (``table``: one your pipelines build; ``computed``: built from ``sql`` by a pipeline the
    Object Model generates, on ``schedule``)."""

    api_name: str = Field(pattern=FIELD_NAME)
    target: str = Field(pattern=TYPE_NAME)
    cardinality: Literal["one-to-one", "one-to-many", "many-to-one", "many-to-many"] = "one-to-many"
    reverse: str | None = Field(default=None, pattern=FIELD_NAME)  # its name seen from the target
    from_property: str  # a property of this type (its values are in from_column of a link table)
    to_property: str  # a property of the target type (its values are in to_column)
    description: str = ""
    storage: Literal["property", "table", "computed"] = "property"
    table: str | None = None  # the link table (for computed links: set from the type and link names)
    from_column: str = "from_key"
    to_column: str = "to_key"
    sql: str | None = None  # computed: a Spark SQL SELECT giving from_key, to_key
    schedule: str | None = None  # computed: a cron expression; None: built when its pipeline is run

    @field_validator("table")
    @classmethod
    def _table(cls, v: str | None) -> str | None:
        if v and not TABLE.match(v):
            raise ValueError(f"table '{v}': a catalog table as written in SQL")
        return v or None

    @field_validator("sql")
    @classmethod
    def _sql(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        text = v.strip().rstrip(";").strip()
        if ";" in text or not re.match(r"(?is)^\s*(select|with)\b", text):
            raise ValueError("a computed link is one SELECT (or WITH … SELECT) statement")
        if len(text) > 20_000:
            raise ValueError("the SQL is limited to 20,000 characters")
        return text

    @field_validator("from_column", "to_column")
    @classmethod
    def _column(cls, v: str) -> str:
        if not COLUMN.match(v):
            raise ValueError(f"'{v}' isn't a column name")
        return v

    @model_validator(mode="after")
    def _storage(self):
        if self.storage == "property" and self.cardinality == "many-to-many":
            raise ValueError(f"link {self.api_name}: many-to-many needs a link table (storage: table or computed)")
        if self.storage == "table" and not self.table:
            raise ValueError(f"link {self.api_name}: give the link table")
        if self.storage == "computed" and not self.sql:
            raise ValueError(f"link {self.api_name}: give the SQL that computes it")
        return self


PRINCIPAL = r"^(role:(admin|user)|user:[a-z0-9][a-z0-9._-]{2,31})$"


class Access(BaseModel):
    """Who sees the type and its sensitive properties: roles (role:admin, role:user = every signed-in
    user) and users (user:dana). Admins always see everything."""

    view: list[str] = []  # empty: everyone with the Objects tab
    sensitive: list[str] = []  # who sees sensitive properties unmasked, besides admins

    @field_validator("view", "sensitive")
    @classmethod
    def _principals(cls, v: list[str]) -> list[str]:
        bad = [x for x in v if not re.match(PRINCIPAL, x)]
        if bad:
            raise ValueError(f"{', '.join(bad)}: write role:admin, role:user or user:<name>")
        return list(dict.fromkeys(v))


class ActionParam(BaseModel):
    property: str  # the property this parameter sets
    label: str = ""
    required: bool = True
    choices: list[str] = []  # empty: any value of the property's type


class Action(BaseModel):
    """A controlled change: it sets some properties of one object, with a reason, by allowed people."""

    api_name: str = Field(pattern=FIELD_NAME)
    label: str = ""
    description: str = ""
    parameters: list[ActionParam] = Field(min_length=1)
    allowed: list[str] = []  # principals who may run it; empty: admins only
    require_reason: bool = True

    @field_validator("allowed")
    @classmethod
    def _principals(cls, v: list[str]) -> list[str]:
        return Access._principals(v)


class ObjectType(BaseModel):
    api_name: str = Field(pattern=TYPE_NAME)
    plural: str = ""
    description: str = ""
    icon: str = "box"
    source: Source
    primary_key: str
    title: str
    properties: list[Property] = Field(min_length=1)
    links: list[Link] = []
    access: Access = Access()
    actions: list[Action] = []
    index: bool = False  # "Fast search": an OpenSearch index of its objects (search_index.py)

    @model_validator(mode="after")
    def _consistent(self):
        names = [p.api_name for p in self.properties]
        twice = sorted({n for n in names if names.count(n) > 1})
        if twice:
            raise ValueError(f"property {', '.join(twice)} is defined twice")
        for what, name in (("primary key", self.primary_key), ("title", self.title)):
            if name not in names:
                raise ValueError(f"the {what} '{name}' isn't one of the properties")
        links = [k.api_name for k in self.links]
        if len(set(links)) != len(links):
            raise ValueError("two links have the same name")
        clash = sorted(set(links) & set(names))
        if clash:
            raise ValueError(f"{', '.join(clash)} is both a property and a link")
        for k in self.links:
            if k.from_property not in names:
                raise ValueError(f"link {k.api_name}: '{k.from_property}' isn't one of the properties")
            if k.storage == "computed":
                k.table = computed_table(self, k)
                k.from_column, k.to_column = "from_key", "to_key"
        actions = [a.api_name for a in self.actions]
        if len(set(actions)) != len(actions):
            raise ValueError("two actions have the same name")
        for a in self.actions:
            props = [x.property for x in a.parameters]
            if len(set(props)) != len(props):
                raise ValueError(f"action {a.api_name}: a property is set twice")
            for x in props:
                if x not in names:
                    raise ValueError(f"action {a.api_name}: '{x}' isn't one of the properties")
                if x == self.primary_key:
                    raise ValueError(f"action {a.api_name}: the primary key can't be changed")
        return self

    def prop(self, name: str) -> Property:
        return next(p for p in self.properties if p.api_name == name)


def computed_table(t: "ObjectType", k: Link) -> str:
    """Where a computed link is built: <catalog>.gold.link_<type>_<link>, next to the type's table."""
    parts = t.source.table.split(".")
    name = "link_" + file_name(t.api_name).removesuffix(".yaml") + "_" + k.api_name
    return f"{parts[0]}.gold.{name}" if len(parts) == 3 else f"gold.{name}"


def layer_of(table: str) -> Layer:
    """The medallion layer from the table's schema: tenant1.bronze.customers -> bronze."""
    parts = table.split(".")
    schema = parts[-2].lower() if len(parts) >= 2 else ""
    return schema if schema in LAYERS else "unclassified"  # type: ignore[return-value]


def errors(e: ValidationError) -> str:
    msgs = []
    for err in e.errors():
        where = ".".join(str(p) for p in err["loc"])
        msg = err["msg"].removeprefix("Value error, ")
        msgs.append(f"{where}: {msg}" if where else msg)
    return "; ".join(msgs)


def parse(data: dict) -> ObjectType:
    """ValueError with readable reasons when the definition isn't valid."""
    try:
        return ObjectType.model_validate(data)
    except ValidationError as e:
        raise ValueError(errors(e)) from None


# ------------------------------------------------------------ files
def file_name(api_name: str) -> str:
    """Customer -> customer.yaml, BankAccount -> bank_account.yaml."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", api_name).lower() + ".yaml"


def _path(root: Path, api_name: str, draft: bool) -> Path:
    if not re.match(TYPE_NAME, api_name):
        raise ValueError(f"'{api_name}' isn't a type name (a capital letter, then letters and digits)")
    return Path(root) / (DRAFTS if draft else FOLDER) / file_name(api_name)


def load(root: Path, api_name: str, draft: bool = False) -> tuple[ObjectType, float] | None:
    path = _path(root, api_name, draft)
    if not path.is_file():
        return None
    return parse(yaml.safe_load(path.read_text()) or {}), path.stat().st_mtime


def load_all(root: Path, draft: bool = False) -> tuple[list[ObjectType], list[str]]:
    """Every published (or draft) type, and the files that can't be read (with the reason)."""
    folder = Path(root) / (DRAFTS if draft else FOLDER)
    types, broken = [], []
    for path in sorted(folder.glob("*.yaml")) if folder.is_dir() else []:
        try:
            types.append(parse(yaml.safe_load(path.read_text()) or {}))
        except (ValueError, yaml.YAMLError) as e:
            broken.append(f"{path.name}: {e}")
    return types, broken


def save(root: Path, t: ObjectType, modified: float | None, draft: bool) -> float:
    """Write the definition; FileExistsError when the file changed since ``modified``."""
    path = _path(root, t.api_name, draft)
    if path.is_file() and (modified is None or abs(path.stat().st_mtime - modified) > 1e-6):
        raise FileExistsError(f"{t.api_name} changed since you opened it; reload it, then make your change again")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = t.model_dump(exclude_defaults=True)
    data["api_name"] = t.api_name
    source = {"table": t.source.table, "layer": t.source.layer}
    rows = t.source.rows.model_dump(exclude_defaults=True)
    data["source"] = source | ({"rows": rows} if rows else {})
    text = HEADER + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=110)
    tmp = path.with_name(f".{path.name}.saving")
    tmp.write_text(text)
    os.replace(tmp, path)
    return path.stat().st_mtime


def delete(root: Path, api_name: str, draft: bool) -> bool:
    path = _path(root, api_name, draft)
    if not path.is_file():
        return False
    path.unlink()
    return True


# ------------------------------------------------------------ SQL
def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def lit(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def table_sql(table: str) -> str:
    return ".".join(q(p) for p in table.split("."))


def prop_sql(p: Property) -> str:
    return q(p.column) if p.type == "auto" else f"TRY_CAST({q(p.column)} AS {TYPES[p.type]})"


def filtered_rows(t: ObjectType) -> str:
    """The table's rows after the filter (before latest per key)."""
    where = f" WHERE ({t.source.rows.filter})" if t.source.rows.filter else ""
    return f"SELECT * FROM {table_sql(t.source.table)}{where}"


def rule_rows(t: ObjectType) -> str:
    """The table's rows after every row rule: the filter, then the newest row per key."""
    rows = t.source.rows
    inner = filtered_rows(t)
    if rows.latest_by:
        order = "DESC" if rows.latest_desc else "ASC"
        key = q(t.prop(t.primary_key).column)
        inner += f" QUALIFY row_number() OVER (PARTITION BY {key} ORDER BY {q(rows.latest_by)} {order} NULLS LAST) = 1"
    return inner


def object_view(t: ObjectType) -> str:
    """One object per key: the row rules, then the properties (with casts)."""
    cols = ", ".join(f"{prop_sql(p)} AS {q(p.api_name)}" for p in t.properties)
    return f"SELECT {cols} FROM ({rule_rows(t)}) AS src"


# ------------------------------------------------------------ checks
Run = Callable[[str], list[list]]  # runs one SELECT, returns its rows; raises CheckFailed with the engine's message


class CheckFailed(Exception):
    pass


def _check(step: str, name: str, ok: bool | None, severity: str, detail: str = "") -> dict:
    """ok None: information. severity "block" stops publishing, "warn" can be accepted."""
    status = "info" if ok is None else ("ok" if ok else "fail")
    return {"step": step, "name": name, "status": status, "severity": severity, "detail": detail}


def _pct(a: int, b: int) -> str:
    return f"{100 * a / b:.1f}%" if b else "–"


def check(
    t: ObjectType,
    run: Run,
    tables: dict[str, dict],
    published: dict[str, ObjectType],
    steps: tuple[str, ...] = ("source", "identity", "properties", "links", "actions", "access"),
) -> dict:
    """The wizard's checks against the data. ``tables``: the catalog's tables by name
    ({"columns": [...], "delta": bool, "rows": int}); ``published``: the published types by name.
    Returns {"checks": [...], "stats": {...}, "ok": no blocking check failed}."""
    out: list[dict] = []
    stats: dict = {}
    table = tables.get(t.source.table)

    # ① source
    out.append(_check("source", "The table is in the catalog", table is not None, "block",
                      "" if table else f"{t.source.table} isn't a table of the catalog"))
    if table is None:
        return {"checks": out, "stats": stats, "ok": False}
    if "source" in steps:
        out.append(_check("source", "Delta table", table["delta"], "warn",
                          "versions are kept" if table["delta"] else "a Parquet table: objects work, without history"))
        layer = t.source.layer
        notes = {
            "bronze": "raw data: rows may repeat per key (use row rules) and columns may be text (use casts)",
            "silver": "cleaned data: check the key; history tables need latest per key",
            "gold": "curated data: usually one row per key",
            "unclassified": "no layer in the schema name: checked like bronze",
        }
        out.append(_check("source", f"Layer: {layer}", None, "info", notes[layer]))
        others = [n for n, o in published.items() if o.source.table == t.source.table and n != t.api_name]
        out.append(_check("source", "No other type uses this table", not others, "warn",
                          f"used by {', '.join(others)}" if others else ""))

    columns = set(table["columns"])
    missing = [p.column for p in t.properties if p.column not in columns]
    if t.source.rows.latest_by and t.source.rows.latest_by not in columns:
        missing.append(t.source.rows.latest_by)
    if missing:
        out.append(_check("identity", "Columns exist", False, "block", f"not in the table: {', '.join(missing)}"))
        return {"checks": out, "stats": stats, "ok": False}

    # ② identity and row rules
    view = object_view(t)
    if "identity" in steps or "links" in steps:
        try:
            run(f"SELECT * FROM ({view}) AS v LIMIT 0")
        except CheckFailed as e:
            out.append(_check("identity", "Row rules are valid", False, "block", str(e)))
            return {"checks": out, "stats": stats, "ok": False}
    if "identity" in steps:
        out.append(_check("identity", "Row rules are valid", True, "block"))
        key_col = q(t.prop(t.primary_key).column)
        key = q(t.primary_key)
        before = run(f"SELECT count(*), count(DISTINCT {key_col}), count(*) FILTER (WHERE {key_col} IS NULL) "
                     f"FROM {table_sql(t.source.table)}")[0]
        after = run(f"SELECT count(*), count(DISTINCT {key}), count(*) FILTER (WHERE {key} IS NULL) "
                    f"FROM ({view}) AS v")[0]

        def counts(r):
            rows, distinct, empty = (int(x) for x in r)
            return {"rows": rows, "distinct_keys": distinct, "duplicate_keys": rows - empty - distinct,
                    "empty_keys": empty}

        stats["before"], stats["after"] = counts(before), counts(after)
        a = stats["after"]
        out.append(_check("identity", "Key never empty after the rules", a["empty_keys"] == 0, "block",
                          f"{a['empty_keys']:,} rows have no {t.primary_key}" if a["empty_keys"] else ""))
        hint = "" if t.source.rows.latest_by else ": turn on latest row per key"
        out.append(_check("identity", "Key unique after the rules", a["duplicate_keys"] == 0, "block",
                          f"{a['duplicate_keys']:,} repeated keys{hint}" if a["duplicate_keys"] else
                          f"{a['rows']:,} objects"))
        if t.source.rows.latest_by:
            order = "DESC" if t.source.rows.latest_desc else "ASC"
            lb = q(t.source.rows.latest_by)
            ties = run(
                f"SELECT count(*) FROM (SELECT {key_col}, {lb}, count(*) AS c FROM ({filtered_rows(t)}) AS f "
                f"GROUP BY 1, 2 QUALIFY rank() OVER (PARTITION BY {key_col} ORDER BY {lb} {order} NULLS LAST) = 1) "
                "AS g WHERE c > 1"
            )[0][0]
            out.append(_check("identity", f"No ties on {t.source.rows.latest_by}", ties == 0, "warn",
                              f"{ties:,} keys have two newest rows: which one is shown can change" if ties else ""))
        out.append(_check("identity", "The title isn't sensitive", not t.prop(t.title).sensitive, "warn"))
        if t.api_name in published:
            out.append(_check("identity", f"{t.api_name} is published", None, "info",
                              "publishing replaces the published version"))

    # ③ properties
    if "properties" in steps:
        casts = [p for p in t.properties if p.type != "auto"]
        if casts:
            parts = ", ".join(
                f"count(*) FILTER (WHERE {q(p.column)} IS NOT NULL AND {prop_sql(p)} IS NULL), "
                f"count(*) FILTER (WHERE {q(p.column)} IS NOT NULL)"
                for p in casts
            )
            try:
                row = run(f"SELECT {parts} FROM ({rule_rows(t)}) AS src")[0]
                for i, p in enumerate(casts):
                    failed, total = int(row[2 * i]), int(row[2 * i + 1])
                    ok = not total or failed / total <= 0.01
                    out.append(_check("properties", f"Cast {p.api_name} to {p.type}", ok, "warn",
                                      f"{failed:,} of {total:,} values fail ({_pct(failed, total)})" if failed else
                                      "every value converts"))
            except CheckFailed as e:
                out.append(_check("properties", "Casts work", False, "block", str(e)))
        personal = [p.api_name for p in t.properties if not p.sensitive and (PERSONAL.search(p.column) or
                                                                            PERSONAL.search(p.api_name))]
        out.append(_check("properties", "Personal-looking properties are sensitive", not personal, "warn",
                          f"not marked sensitive: {', '.join(personal)}" if personal else ""))
        bare = [p.api_name for p in t.properties if not p.description.strip()]
        out.append(_check("properties", "Every property has a description", not bare, "warn",
                          f"{len(bare)} without one: AI Assist relies on them" if bare else ""))
        out.append(_check("properties", "Something to search by", any(p.searchable for p in t.properties), "warn",
                          "" if any(p.searchable for p in t.properties) else "search finds objects by key only"))

    # ④ links
    if "links" in steps:
        for k in t.links:
            name = f"Link {k.api_name} → {k.target}"
            target = t if k.target == t.api_name else published.get(k.target)
            if target is None:
                out.append(_check("links", name, False, "block", f"{k.target} isn't a published type"))
                continue
            if k.to_property not in {p.api_name for p in target.properties}:
                out.append(_check("links", name, False, "block", f"{k.target} has no property {k.to_property}"))
                continue
            if k.storage != "property":
                out += _check_link_table(t, k, target, view, run, tables, name)
                continue
            f, to = q(k.from_property), q(k.to_property)
            sql = (
                f"WITH a AS ({view}), b AS ({object_view(target)}) SELECT "
                f"(SELECT count(*) FROM a WHERE {f} IS NOT NULL), "
                f"(SELECT count(*) FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.{to} = a.{f})), "
                f"(SELECT count(*) FROM b WHERE {to} IS NOT NULL), "
                f"(SELECT count(*) FROM b WHERE EXISTS (SELECT 1 FROM a WHERE a.{f} = b.{to})), "
                f"(SELECT coalesce(max(c), 0) FROM (SELECT count(*) AS c FROM a JOIN b ON a.{f} = b.{to} "
                f"GROUP BY a.{q(t.primary_key)})), "
                f"(SELECT coalesce(max(c), 0) FROM (SELECT count(*) AS c FROM a JOIN b ON a.{f} = b.{to} "
                f"GROUP BY b.{q(target.primary_key)}))"
            )
            try:
                a_all, a_hit, b_all, b_hit, per_a, per_b = (int(x) for x in run(sql)[0])
            except CheckFailed as e:
                out.append(_check("links", name, False, "block", f"the join doesn't run: {e}"))
                continue
            found = ("one" if per_b <= 1 else "many") + "-to-" + ("one" if per_a <= 1 else "many")
            # the side that must find its partner: the "many" side
            hit, total = (b_hit, b_all) if k.cardinality == "one-to-many" else (a_hit, a_all)
            rate = hit / total if total else 0.0
            stats.setdefault("links", {})[k.api_name] = {
                "match_rate": round(rate, 4), "matched": hit, "total": total, "found": found,
                "max_per_source": per_a, "max_per_target": per_b,
            }
            out.append(_check("links", f"{name}: match rate", rate >= MATCH_RATE, "warn",
                              f"{_pct(hit, total)} ({hit:,} of {total:,}) find their partner"))
            wanted = {"one-to-one": (1, 1), "one-to-many": (None, 1), "many-to-one": (1, None)}[k.cardinality]
            ok = (wanted[0] is None or per_a <= wanted[0]) and (wanted[1] is None or per_b <= wanted[1])
            out.append(_check("links", f"{name}: cardinality", ok, "block",
                              f"declared {k.cardinality}, found {found} (up to {per_a} per {t.api_name}, "
                              f"{per_b} per {k.target})"))
            if target is not t and target.source.layer != t.source.layer:
                out.append(_check("links", f"{name}: mixed layers", None, "info",
                                  f"{t.source.layer} → {target.source.layer}: the sides may refresh at different times"))
    # ⑤ actions
    if "actions" in steps:
        if not t.actions:
            out.append(_check("actions", "No actions", None, "info", "objects of this type can't be changed"))
        for a in t.actions:
            who = ", ".join(a.allowed) if a.allowed else "admins only"
            out.append(_check("actions", f"Action {a.label or a.api_name}", None, "info",
                              f"sets {', '.join(x.property for x in a.parameters)}; run by {who}"))
            if not a.require_reason:
                out.append(_check("actions", f"{a.label or a.api_name} asks for a reason", False, "warn",
                                  "the audit log is clearer with one"))
            sensitive = [x.property for x in a.parameters if t.prop(x.property).sensitive]
            if sensitive and "role:user" in a.allowed:
                out.append(_check("actions", f"{a.label or a.api_name}: sensitive properties", False, "warn",
                                  f"every signed-in user may change {', '.join(sensitive)}"))

    # ⑥ access
    if "access" in steps:
        raw = t.source.layer in ("bronze", "unclassified")
        everyone = not t.access.view or "role:user" in t.access.view
        out.append(_check("access", "Who sees this type", None, "info",
                          "everyone with the Objects tab" if everyone else ", ".join(t.access.view) + " (and admins)"))
        if raw:
            out.append(_check("access", "Raw data isn't open to everyone", not everyone, "warn",
                              f"a {t.source.layer} table: choose who sees it" if everyone else ""))
        sensitive = [p.api_name for p in t.properties if p.sensitive]
        if sensitive:
            out.append(_check("access", "Sensitive properties are masked", "role:user" not in t.access.sensitive,
                              "warn", f"{', '.join(sensitive)}: shown to " + (
                                  ", ".join(t.access.sensitive) + " and admins" if t.access.sensitive else "admins only")))
    return {"checks": out, "stats": stats, "ok": not any(c["status"] == "fail" and c["severity"] == "block"
                                                          for c in out)}


# ------------------------------------------------------------ objects
MASK = "••••"


def links_of(api_name: str, types: dict[str, ObjectType]) -> list[dict]:
    """The links of a type, both ways: its own, and those of other types that name a reverse. ``via``:
    the link table and its two columns as seen from this side (None for a link on properties)."""
    out = []
    t = types.get(api_name)
    for k in t.links if t else []:
        via = {"table": k.table, "here": k.from_column, "there": k.to_column} if k.storage != "property" else None
        out.append({"name": k.api_name, "target": k.target, "here": k.from_property, "there": k.to_property,
                    "many": k.cardinality in ("one-to-many", "many-to-many"), "description": k.description,
                    "storage": k.storage, "via": via})
    for other in types.values():
        for k in other.links:
            if k.target == api_name and k.reverse:
                via = {"table": k.table, "here": k.to_column, "there": k.from_column} if k.storage != "property" else None
                out.append({"name": k.reverse, "target": other.api_name, "here": k.to_property,
                            "there": k.from_property, "many": k.cardinality in ("many-to-one", "many-to-many"),
                            "description": "", "storage": k.storage, "via": via})
    return out


def linked_sql(target: ObjectType, link: dict, value: str, limit: int | None = None, count: bool = False) -> str:
    """The target objects a link leads to from one object's value (through its link table if it has one)."""
    there = f"CAST(v.{q(link['there'])} AS VARCHAR)"
    if link.get("via"):
        via = link["via"]
        cond = (f"{there} IN (SELECT CAST({q(via['there'])} AS VARCHAR) FROM {table_sql(via['table'])} "
                f"WHERE CAST({q(via['here'])} AS VARCHAR) = {lit(value)})")
    else:
        cond = f"{there} = {lit(value)}"
    if count:
        return f"SELECT count(*) FROM ({object_view(target)}) AS v WHERE {cond}"
    return (f"SELECT * FROM ({object_view(target)}) AS v WHERE {cond} "
            f"ORDER BY {q(target.title)} NULLS LAST LIMIT {int(limit or 50)}")


def _check_link_table(t: ObjectType, k: Link, target: ObjectType, view: str, run: Run, tables: dict,
                      name: str) -> list[dict]:
    """A link stored as a table: it exists (or, computed, will once its pipeline runs), has its two
    columns, and its keys find objects on both sides."""
    out = []
    if k.storage == "computed":
        try:  # a first look with DuckDB: Spark SQL may differ, so this only warns
            run(f"SELECT from_key, to_key FROM ({k.sql}) AS s LIMIT 0")
            out.append(_check("links", f"{name}: the SQL", True, "warn", "runs on DuckDB too, with from_key and to_key"))
        except CheckFailed as e:
            out.append(_check("links", f"{name}: the SQL", False, "warn",
                              f"DuckDB couldn't run it (Spark may still): {e}"))
    info = tables.get(k.table)
    if info is None:
        if k.storage == "computed":
            out.append(_check("links", f"{name}: link table", None, "info",
                              f"{k.table} is built by its pipeline after publishing" +
                              (f", on its schedule ({k.schedule})" if k.schedule else " (run it from Pipelines)")))
        else:
            out.append(_check("links", f"{name}: link table", False, "block", f"{k.table} isn't a table of the catalog"))
        return out
    missing = [c for c in (k.from_column, k.to_column) if c not in info["columns"]]
    if missing:
        out.append(_check("links", f"{name}: link table", False, "block", f"{k.table} has no {', '.join(missing)}"))
        return out
    fc, tc = q(k.from_column), q(k.to_column)
    sql = (f"WITH l AS (SELECT DISTINCT CAST({fc} AS VARCHAR) AS f, CAST({tc} AS VARCHAR) AS t FROM "
           f"{table_sql(k.table)} WHERE {fc} IS NOT NULL AND {tc} IS NOT NULL), "
           f"a AS (SELECT DISTINCT CAST({q(k.from_property)} AS VARCHAR) AS k FROM ({view}) AS v), "
           f"b AS (SELECT DISTINCT CAST({q(k.to_property)} AS VARCHAR) AS k FROM ({object_view(target)}) AS v) "
           "SELECT (SELECT count(*) FROM l), (SELECT count(*) FROM l WHERE f IN (SELECT k FROM a)), "
           "(SELECT count(*) FROM l WHERE t IN (SELECT k FROM b))")
    try:
        total, hit_a, hit_b = (int(x) for x in run(sql)[0])
    except CheckFailed as e:
        out.append(_check("links", f"{name}: link table", False, "block", f"it can't be read: {e}"))
        return out
    worst = min(hit_a, hit_b)
    rate = worst / total if total else 0.0
    out.append(_check("links", f"{name}: match rate", rate >= MATCH_RATE, "warn",
                      f"{total:,} pairs; {_pct(hit_a, total)} find a {t.api_name}, {_pct(hit_b, total)} find a "
                      f"{k.target}"))
    return out


def search_sql(t: ObjectType, text: str, limit: int, offset: int) -> str:
    """Objects whose key or searchable properties contain the text (all objects when it's empty)."""
    where = ""
    if text.strip():
        pattern = lit("%" + text.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        fields = [t.primary_key] + [p.api_name for p in t.properties  # never sensitive ones: search would reveal them
                                    if p.searchable and not p.sensitive and p.api_name != t.primary_key]
        where = " WHERE " + " OR ".join(f"CAST({q(f)} AS VARCHAR) ILIKE {pattern} ESCAPE '\\'" for f in fields)
    return (f"SELECT * FROM ({object_view(t)}) AS v{where} ORDER BY {q(t.title)} NULLS LAST, {q(t.primary_key)} "
            f"LIMIT {int(limit)} OFFSET {int(offset)}")


def by_value_sql(t: ObjectType, prop: str, value: str, limit: int) -> str:
    return (f"SELECT * FROM ({object_view(t)}) AS v WHERE CAST({q(prop)} AS VARCHAR) = {lit(value)} "
            f"ORDER BY {q(t.title)} NULLS LAST LIMIT {int(limit)}")


# ------------------------------------------------------------ access
def allows(user, principals: list[str], empty_means_everyone: bool) -> bool:
    """Is this user one of these principals? ``user`` None: users are off, so everyone may."""
    if user is None or user.role == "admin":
        return True
    if not principals:
        return empty_means_everyone
    return "role:user" in principals or f"user:{user.username}" in principals


def can_view(user, t: ObjectType) -> bool:
    return allows(user, t.access.view, True)


def can_see_sensitive(user, t: ObjectType) -> bool:
    return allows(user, t.access.sensitive, False)


def can_run(user, a: Action) -> bool:
    return allows(user, a.allowed, False)


def coerce(p: Property, value):
    """A value typed into an action, as the property's type. ValueError when it doesn't fit."""
    if value is None or value == "":
        return None
    kind = p.type
    text = str(value).strip()
    try:
        if kind == "integer":
            return int(text)
        if kind in ("number", "decimal"):
            return float(text)
        if kind == "boolean":
            if text.lower() in ("true", "1", "yes"):
                return True
            if text.lower() in ("false", "0", "no"):
                return False
            raise ValueError
        if kind == "date":
            return datetime.fromisoformat(text).date().isoformat()
        if kind == "timestamp":
            return datetime.fromisoformat(text).isoformat(sep=" ")
    except ValueError:
        raise ValueError(f"{p.api_name}: '{text}' isn't a {kind}") from None
    return value if isinstance(value, (int, float, bool)) else text


def to_object(t: ObjectType, columns: list[str], row: list, can_see_sensitive: bool,
              edits: dict[str, dict] | None = None) -> dict:
    """An object as the API answers it: actions' edits laid over the table's values, then masking."""
    values = dict(zip(columns, row))
    edited = {}
    for prop, e in (edits or {}).items():
        if prop in values:
            values[prop] = e["value"]
            edited[prop] = {"by": e["by"], "at": e["at"], "action": e["action"]}
    if not can_see_sensitive:
        for p in t.properties:
            if p.sensitive and values.get(p.api_name) is not None:
                values[p.api_name] = MASK
    return {"type": t.api_name, "pk": None if values.get(t.primary_key) is None else str(values[t.primary_key]),
            "title": values.get(t.title), "properties": values, "edited": edited}

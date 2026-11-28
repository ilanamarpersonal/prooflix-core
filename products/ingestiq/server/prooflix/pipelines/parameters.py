"""Declared pipeline parameters and the values a run is started with.

A pipeline declares each parameter in one of two forms::

    parameters:
      source_dir: source              # short form: just a default, any value is accepted
      tenant_id:                      # long form: a typed declaration
        type: identifier
        default: tenant1
        required: true
        description: Tenant whose catalog the run reads and writes

A value is the long form when it is a mapping with a ``type`` key and only the keys
below; anything else is a default (so an object default with a ``type`` key needs
the long form: ``{type: object, default: {...}}``).

Types::

    any         the value as given (the short form)
    string      text, at most 1000 characters
    identifier  a short lowercase identifier: a letter, then letters, digits or _,
                at most 32 characters (tenant1). Safe in paths and SQL names.
    integer     a whole number          number   a number
    boolean     true or false           date     YYYY-MM-DD
    list        a list                  object   a mapping

``pattern`` (a regular expression the whole text must match, string and identifier
only) and ``choices`` (the allowed values) narrow a type further. Every run,
whether started from the UI, the API, the CLI, a schedule or a parent pipeline,
goes through ``bind``: values are converted to their type (``"12"`` -> ``12`` for an
integer, since forms send text) and checked, so a task only ever sees valid values.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ParameterType = Literal["any", "string", "identifier", "integer", "number", "boolean", "date", "list", "object"]
PARAMETER_NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_\-]*$"
IDENTIFIER_RE = re.compile(r"[a-z][a-z0-9_]{0,31}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
INTEGER_RE = re.compile(r"[+-]?\d{1,18}")
MAX_TEXT = 1000
DECLARATION_KEYS = {"type", "default", "required", "description", "choices", "pattern"}
_TEXT_TYPES = ("string", "identifier")


class ParameterSpec(BaseModel):
    """One declared parameter."""

    model_config = ConfigDict(extra="forbid")

    type: ParameterType = "any"
    default: Any = None
    required: bool = Field(default=False, description="A run must have a value (from the run or the default)")
    description: str | None = None
    choices: list[Any] | None = Field(default=None, min_length=1, description="The allowed values")
    pattern: str | None = Field(default=None, description="Regular expression the whole text must match")

    @model_validator(mode="after")
    def _consistent(self) -> "ParameterSpec":
        if self.pattern is not None:
            if self.type not in _TEXT_TYPES:
                raise ValueError(f"pattern only applies to string and identifier parameters, not {self.type}")
            try:
                re.compile(self.pattern)
            except re.error as exc:
                raise ValueError(f"pattern is not a valid regular expression: {exc}") from None
        if self.choices is not None:
            self.choices = [self._convert(c, "choice") for c in self.choices]
        if not _empty(self.default):
            self.default = self.check(self.default, "default")
        return self

    def check(self, value: Any, what: str = "value") -> Any:
        """``value`` converted to the parameter's type; ValueError says what is wrong."""
        value = self._convert(value, what)
        if self.pattern is not None and not re.fullmatch(self.pattern, value):
            raise ValueError(f"{what} '{value}' does not match the pattern {self.pattern}")
        if self.choices is not None and value not in self.choices:
            allowed = ", ".join(json.dumps(c) for c in self.choices)
            raise ValueError(f"{what} {json.dumps(value)} is not one of {allowed}")
        return value

    def _convert(self, value: Any, what: str) -> Any:
        t = self.type
        if t == "any":
            return value
        if t in _TEXT_TYPES:
            if isinstance(value, (int, float)) and not isinstance(value, bool) and t == "string":
                value = str(value)
            if not isinstance(value, str):
                raise ValueError(f"{what} must be text")
            if len(value) > MAX_TEXT:
                raise ValueError(f"{what} is longer than {MAX_TEXT} characters")
            if t == "identifier" and not IDENTIFIER_RE.fullmatch(value):
                raise ValueError(
                    f"{what} '{_short(value)}' must be a short lowercase identifier: a letter, then lowercase "
                    "letters, digits or _ (at most 32 characters), like tenant1"
                )
            return value
        if t == "integer":
            if isinstance(value, bool):
                raise ValueError(f"{what} must be a whole number")
            if isinstance(value, float) and value.is_integer():
                return int(value)
            if isinstance(value, str) and INTEGER_RE.fullmatch(value.strip()):
                return int(value.strip())
            if isinstance(value, int):
                return value
            raise ValueError(f"{what} '{_short(value)}' must be a whole number")
        if t == "number":
            if isinstance(value, str):
                try:
                    value = float(value.strip()) if not INTEGER_RE.fullmatch(value.strip()) else int(value.strip())
                except ValueError:
                    raise ValueError(f"{what} '{_short(value)}' must be a number") from None
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{what} '{_short(value)}' must be a number")
            return value
        if t == "boolean":
            if isinstance(value, str) and value.strip().lower() in ("true", "false"):
                return value.strip().lower() == "true"
            if not isinstance(value, bool):
                raise ValueError(f"{what} '{_short(value)}' must be true or false")
            return value
        if t == "date":
            if isinstance(value, date):
                return value.isoformat()
            if isinstance(value, str) and DATE_RE.fullmatch(value.strip()):
                try:
                    return date.fromisoformat(value.strip()).isoformat()
                except ValueError:
                    pass
            raise ValueError(f"{what} '{_short(value)}' must be a date as YYYY-MM-DD")
        # list or object: the real thing, or its JSON text (from a form)
        kind = list if t == "list" else dict
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        if not isinstance(value, kind):
            raise ValueError(f"{what} must be a {'list' if t == 'list' else 'mapping'} (JSON)")
        return value


def normalize_declarations(raw: Any) -> Any:
    """The ``parameters:`` mapping with every short form turned into a declaration."""
    if not isinstance(raw, dict):
        return raw
    return {name: value if is_declaration(value) else {"type": "any", "default": value} for name, value in raw.items()}


def is_declaration(value: Any) -> bool:
    return isinstance(value, dict) and "type" in value and set(value) <= DECLARATION_KEYS


def check_names(names: Any) -> None:
    for name in names:
        if not isinstance(name, str) or not re.match(PARAMETER_NAME_PATTERN, name):
            raise ValueError(f"Invalid parameter name '{name}': use letters, digits, _ or -, starting with a letter")


def bind(declared: dict[str, ParameterSpec], given: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The values a run uses: ``given`` over the defaults, converted and checked.

    Returns the values and the problems (empty when all is well). An empty value
    (missing, null or "") of a typed parameter falls back to its default."""
    errors = []
    unknown = sorted(set(given) - set(declared))
    if unknown:
        errors.append(f"Unknown parameters: {', '.join(unknown)}")
    values: dict[str, Any] = {}
    for name, p in declared.items():
        if p.type == "any":
            value = given[name] if name in given else p.default
        else:
            value = given.get(name)
            if _empty(value):
                value = p.default
        if _empty(value) and p.type != "any":
            if p.required:
                errors.append(f"Parameter '{name}': a value is required")
            values[name] = None
            continue
        if p.required and value is None:
            errors.append(f"Parameter '{name}': a value is required")
            continue
        try:
            values[name] = p.check(value, f"Parameter '{name}':")
        except ValueError as exc:
            errors.append(str(exc))
    return values, errors


def _empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _short(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= 60 else text[:57] + "..."

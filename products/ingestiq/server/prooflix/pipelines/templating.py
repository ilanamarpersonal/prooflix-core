"""``${...}`` references inside pipeline values.

Supported roots:

* ``${params.<name>}``             a pipeline parameter
* ``${tasks.<key>.output[.path]}`` the output of an upstream task
* ``${run.id}`` / ``${run.pipeline}``
* ``${system.start_date}``          the system start date (PROOFLIX_START_DATE), ISO 8601
                                    UTC, or empty when not set

A value that is exactly one reference keeps the referenced type (numbers, lists,
objects). References embedded in a longer string are interpolated as text.
Anything else that looks like ``${...}`` (for example a shell ``${HOME}``) is
left untouched.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from .errors import TemplateError

ROOTS = ("params", "tasks", "run", "system")
_REF = r"\$\{\s*((?:params|tasks|run|system)(?:\.[A-Za-z0-9_\-]+)+)\s*\}"
_REF_RE = re.compile(_REF)
_FULL_RE = re.compile(rf"^{_REF}$")


def iter_references(value: Any) -> Iterator[tuple[str, ...]]:
    """Yield every reference in ``value`` as a tuple of path parts."""
    if isinstance(value, str):
        for match in _REF_RE.finditer(value):
            yield tuple(match.group(1).split("."))
    elif isinstance(value, dict):
        for v in value.values():
            yield from iter_references(v)
    elif isinstance(value, list):
        for v in value:
            yield from iter_references(v)


def resolve(value: Any, scope: dict[str, Any]) -> Any:
    """Return a copy of ``value`` with all references replaced from ``scope``."""
    if isinstance(value, str):
        full = _FULL_RE.match(value)
        if full:
            return lookup(full.group(1), scope)
        return _REF_RE.sub(lambda m: _to_text(lookup(m.group(1), scope)), value)
    if isinstance(value, dict):
        return {k: resolve(v, scope) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, scope) for v in value]
    return value


def resolve_shell(command: str, scope: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """A shell command whose references become environment variables, never code.

    ``echo "Hello, ${params.who}!"`` runs as ``echo "Hello, ${PROOFLIX_REF_1}!"`` with
    ``PROOFLIX_REF_1`` set to the value, so a value such as ``"; rm -rf ~; "`` is only
    ever text: the shell expands a variable but never runs its contents. In double
    quotes (or alone) a reference reads as before; inside single quotes it stays
    literal, as shell variables do.
    """
    env: dict[str, str] = {}

    def to_var(m: re.Match) -> str:
        name = f"PROOFLIX_REF_{len(env) + 1}"
        env[name] = _to_text(lookup(m.group(1), scope))
        return "${" + name + "}"

    return _REF_RE.sub(to_var, command), env


def lookup(path: str, scope: dict[str, Any]) -> Any:
    current: Any = scope
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            raise TemplateError(f"Cannot resolve '${{{path}}}': '{part}' not found")
    return current


def _to_text(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if value is None:
        return ""
    return str(value)

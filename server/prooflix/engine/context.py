"""The context object handed to Python task functions."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class TaskContext:
    """Passed to a Python task function that declares a ``ctx`` parameter.

    Example::

        def extract(source_file: str, ctx):
            ctx.log(f"reading {source_file}")
            data = (ctx.workspace / source_file).read_text()
            return {"rows": len(data.splitlines())}

    ``start_date`` is the system's start date (``PROOFLIX_START_DATE``): where
    processing starts when there is no checkpoint yet. ``None`` means all data.

    ``ctx.connection("bankdb")`` returns a database connection defined in the
    Ingestion tab (kind, host, port, database, user, password, driver, jdbc_url),
    so passwords never have to be written in pipeline YAML.
    """

    run_id: str
    root_run_id: str
    pipeline: str
    task_key: str
    attempt: int
    workspace: Path
    parameters: dict[str, Any] = field(default_factory=dict)
    start_date: datetime | None = None
    _log: Callable[[str], None] = field(default=print, repr=False)
    _connections: Callable[[str], dict | None] | None = field(default=None, repr=False)

    def log(self, message: object) -> None:
        """Append a line to the task log shown in the UI."""
        self._log(str(message))

    def connection(self, name: str) -> dict:
        """A database connection defined in the Ingestion tab, by name."""
        found = self._connections(name) if self._connections is not None else None
        if found is None:
            raise KeyError(f"no database connection named '{name}' (define it in the Ingestion tab)")
        return found

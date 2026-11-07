"""The context object handed to Python task functions."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
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
    """

    run_id: str
    root_run_id: str
    pipeline: str
    task_key: str
    attempt: int
    workspace: Path
    parameters: dict[str, Any] = field(default_factory=dict)
    _log: Callable[[str], None] = field(default=print, repr=False)

    def log(self, message: object) -> None:
        """Append a line to the task log shown in the UI."""
        self._log(str(message))

"""Runners for the leaf task types (``python`` and ``shell``).

``pipeline`` tasks are handled by the executor itself because they start a
child run.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .context import TaskContext

_import_lock = threading.Lock()
_loaded_mtimes: dict[str, float | None] = {}
STDOUT_TAIL_CHARS = 10_000


def _mtime(module: Any) -> float | None:
    path = getattr(module, "__file__", None)
    try:
        return os.path.getmtime(path) if path else None
    except OSError:
        return None


def load_callable(src_dir: Path, entrypoint: str) -> Callable[..., Any]:
    """Import ``module:function`` from the workspace ``src`` directory.

    A module is reloaded when its file changed since it was last loaded, so
    edits to task code are picked up without restarting the server, while
    module state (caches, counters) survives between calls otherwise.
    """
    module_name, func_name = entrypoint.split(":", 1)
    with _import_lock:
        src = str(src_dir)
        if src not in sys.path:
            sys.path.insert(0, src)
        importlib.invalidate_caches()
        module = sys.modules.get(module_name)
        if module is None:
            module = importlib.import_module(module_name)
        elif _mtime(module) != _loaded_mtimes.get(module_name):
            module = importlib.reload(module)
        _loaded_mtimes[module_name] = _mtime(module)
    func = getattr(module, func_name, None)
    if not callable(func):
        raise AttributeError(f"'{entrypoint}' is not a callable in the workspace src directory")
    return func


async def run_python(
    func: Callable[..., Any], parameters: dict[str, Any], ctx: TaskContext
) -> Any:
    kwargs = dict(parameters)
    sig = inspect.signature(func)
    accepts_var_kw = any(p.kind is p.VAR_KEYWORD for p in sig.parameters.values())
    if "ctx" in sig.parameters:
        kwargs["ctx"] = ctx
    if not accepts_var_kw:
        unknown = sorted(set(kwargs) - set(sig.parameters))
        if unknown:
            raise TypeError(f"{func.__name__}() does not accept parameters: {', '.join(unknown)}")

    if inspect.iscoroutinefunction(func):
        result = await func(**kwargs)
    else:
        result = await asyncio.to_thread(func, **kwargs)
    try:
        json.dumps(result)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"Task output must be JSON-serializable: {exc}") from exc
    return result


async def run_shell(
    command: str, env: dict[str, str], cwd: Path, log: Callable[[str], None]
) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(cwd),
        env={**os.environ, **env},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    tail: list[str] = []
    size = 0
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            log(line)
            tail.append(line)
            size += len(line) + 1
            while size > STDOUT_TAIL_CHARS and len(tail) > 1:
                size -= len(tail.pop(0)) + 1
        code = await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    if code != 0:
        raise RuntimeError(f"Command exited with code {code}")
    return {"exit_code": code, "stdout": "\n".join(tail)}

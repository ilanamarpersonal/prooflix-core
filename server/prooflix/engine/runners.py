"""Runners for the leaf task types (``python`` and ``shell``).

``pipeline`` tasks are handled by the executor itself because they start a
child run.
"""

from __future__ import annotations

import asyncio
import contextvars
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


def _is_inside(module: Any, src_dir: Path) -> bool:
    path = getattr(module, "__file__", None)
    if not path:
        return True  # namespace package or builtin: nothing to compare
    try:
        return Path(path).resolve().is_relative_to(src_dir.resolve())
    except OSError:
        return False


def _forget(module_name: str) -> None:
    """Drop a module, its package and the package's submodules from the cache."""
    top = module_name.split(".", 1)[0]
    for name in [n for n in sys.modules if n == top or n.startswith(f"{top}.")]:
        sys.modules.pop(name, None)
        _loaded_mtimes.pop(name, None)


def load_callable(src_dir: Path, entrypoint: str) -> Callable[..., Any]:
    """Import ``module:function`` from a project's ``src`` directory.

    A module is reloaded when its file changed since it was last loaded, so
    edits to task code are picked up without restarting the server, while
    module state (caches, counters) survives between calls otherwise. When two
    projects use the same module name, the module is re-imported from the
    project whose task is running.
    """
    module_name, func_name = entrypoint.split(":", 1)
    with _import_lock:
        src = str(src_dir)
        if src in sys.path:
            sys.path.remove(src)
        sys.path.insert(0, src)  # this project's code wins over other projects'
        importlib.invalidate_caches()
        module = sys.modules.get(module_name)
        if module is not None and not _is_inside(module, src_dir):
            _forget(module_name)
            module = None
        if module is None:
            module = importlib.import_module(module_name)
        elif _mtime(module) != _loaded_mtimes.get(module_name):
            module = importlib.reload(module)
        _loaded_mtimes[module_name] = _mtime(module)
    func = getattr(module, func_name, None)
    if not callable(func):
        raise AttributeError(f"'{entrypoint}' is not a callable in the workspace src directory")
    return func


# ------------------------------------------------------------ print capture
class _LineCapture:
    """Collects text written by one task and logs it line by line."""

    def __init__(self, log: Callable[[str], None]):
        self._log = log
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, text: str) -> None:
        with self._lock:
            self._buffer += text
            *lines, self._buffer = self._buffer.split("\n")
        for line in lines:
            self._log(line.rstrip("\r"))

    def flush(self) -> None:
        with self._lock:
            rest, self._buffer = self._buffer, ""
        if rest:
            self._log(rest.rstrip("\r"))


_current_capture: contextvars.ContextVar[_LineCapture | None] = contextvars.ContextVar(
    "prooflix_task_capture", default=None
)


class _TaskAwareStream:
    """Stands in for sys.stdout/sys.stderr.

    Text printed by a running python task also goes to that task's log, so it
    shows as the task's printout in the UI. Everything is still written to the
    real stream, so it also appears in the terminal.
    """

    def __init__(self, stream: Any):
        self._stream = stream

    def write(self, text: str) -> int:
        capture = _current_capture.get()
        if capture is not None:
            capture.write(text)
        return self._stream.write(text)

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def install_print_capture() -> None:
    """Route task output to task logs (idempotent)."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if not isinstance(stream, _TaskAwareStream):
            setattr(sys, name, _TaskAwareStream(stream))


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

    capture = _LineCapture(ctx.log)
    token = _current_capture.set(capture)
    try:
        if inspect.iscoroutinefunction(func):
            result = await func(**kwargs)
        else:
            # to_thread copies the context, so the worker thread sees the capture too
            result = await asyncio.to_thread(func, **kwargs)
    finally:
        _current_capture.reset(token)
        capture.flush()
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

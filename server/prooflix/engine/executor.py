"""Runs pipelines: schedules the task DAG and starts child runs for sub-pipelines.

Execution model
---------------
* A run executes on the server's asyncio event loop.
* Tasks start as soon as all their ``depends_on`` tasks have SUCCEEDED, so
  independent branches run concurrently.
* If a task fails (after its retries), every task downstream of it is SKIPPED
  and the run ends FAILED. Independent branches still finish.
* A ``pipeline`` task creates a child run, executes it in its own asyncio task
  and uses the child's ``outputs`` as its own output.
* Cancelling a run cancels its running tasks and, through them, all child runs.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..pipelines.errors import PipelineNotFound, PipelineValidationError
from ..pipelines.models import PipelineSpec, PipelineTask, PythonTask, ShellTask
from ..pipelines.templating import resolve
from ..pipelines.workspace import Workspace
from ..runs.models import Run, RunStatus, TaskRun, utcnow
from ..runs.store import RunStore
from .context import TaskContext
from .runners import install_print_capture, load_callable, run_python, run_shell

log = logging.getLogger(__name__)

AnyTask = PythonTask | ShellTask | PipelineTask
_NOT_SUCCEEDED = (RunStatus.FAILED, RunStatus.SKIPPED, RunStatus.CANCELLED)


class RunNotActive(Exception):
    """Raised when cancelling a run that is not running in this process."""


class SubPipelineFailed(Exception):
    pass


@dataclass(frozen=True)
class _Parent:
    run_id: str
    task_key: str
    root_run_id: str
    depth: int


class PipelineExecutor:
    def __init__(self, workspace: Workspace, store: RunStore, *, max_depth: int = 10):
        self.workspace = workspace
        self.store = store
        self.max_depth = max_depth
        self._active: dict[str, asyncio.Task[Run]] = {}
        install_print_capture()  # print() inside python tasks goes to the task log

    # ------------------------------------------------------------ public API
    def prepare(
        self,
        pipeline_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        parent: _Parent | None = None,
        trigger: str = "manual",
        scheduled_for: datetime | None = None,
    ) -> tuple[Run, PipelineSpec]:
        """Validate the pipeline and parameters and create a PENDING run record."""
        defs = self.workspace.load_all()
        definition = defs.get(pipeline_id)
        if definition is None:
            raise PipelineNotFound(pipeline_id)
        if not definition.valid:
            raise PipelineValidationError(pipeline_id, definition.errors)
        spec = definition.spec
        assert spec is not None

        parameters = dict(parameters or {})
        unknown = sorted(set(parameters) - set(spec.parameters))
        if unknown:
            raise PipelineValidationError(
                pipeline_id, [f"Unknown parameters: {', '.join(unknown)}"]
            )

        run = Run(
            pipeline=pipeline_id,
            pipeline_name=definition.name,
            parameters={**spec.parameters, **parameters},
            parent_run_id=parent.run_id if parent else None,
            parent_task_key=parent.task_key if parent else None,
            depth=parent.depth if parent else 0,
            trigger="pipeline" if parent else trigger,
            scheduled_for=scheduled_for,
        )
        run.root_run_id = parent.root_run_id if parent else run.id
        for task in spec.tasks:
            run.tasks[task.key] = TaskRun(
                key=task.key,
                type=task.type,
                depends_on=list(task.depends_on),
                pipeline=task.pipeline if isinstance(task, PipelineTask) else None,
                max_attempts=task.retries + 1,
            )
        self.store.save(run)
        return run, spec

    def start(
        self,
        pipeline_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        trigger: str = "manual",
        scheduled_for: datetime | None = None,
    ) -> Run:
        """Create a run and execute it in the background. Must be called on the event loop."""
        run, spec = self.prepare(pipeline_id, parameters, trigger=trigger, scheduled_for=scheduled_for)
        self._launch(run, spec)
        return run

    async def run(self, pipeline_id: str, parameters: dict[str, Any] | None = None) -> Run:
        """Create a run and wait for it to finish."""
        run, spec = self.prepare(pipeline_id, parameters)
        handle = self._launch(run, spec)
        try:
            return await handle
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if handle.cancelled() and not (current and current.cancelling()):
                return run  # the run itself was cancelled through cancel()
            raise

    def cancel(self, run_id: str) -> None:
        handle = self._active.get(run_id)
        if handle is None or handle.done():
            raise RunNotActive(run_id)
        handle.cancel()

    def is_active(self, run_id: str) -> bool:
        handle = self._active.get(run_id)
        return handle is not None and not handle.done()

    def active_count(self) -> int:
        return sum(1 for h in self._active.values() if not h.done())

    async def shutdown(self) -> None:
        handles = [h for h in self._active.values() if not h.done()]
        for h in handles:
            h.cancel()
        await asyncio.gather(*handles, return_exceptions=True)

    # -------------------------------------------------------------- internals
    def _launch(self, run: Run, spec: PipelineSpec) -> asyncio.Task[Run]:
        handle = asyncio.create_task(self._execute(run, spec), name=f"run-{run.id}")
        self._active[run.id] = handle
        handle.add_done_callback(lambda _h, rid=run.id: self._active.pop(rid, None))
        return handle

    async def _execute(self, run: Run, spec: PipelineSpec) -> Run:
        run.status = RunStatus.RUNNING
        run.started_at = utcnow()
        self.store.save(run)

        scope: dict[str, Any] = {
            "params": run.parameters,
            "tasks": {},
            "run": {"id": run.id, "pipeline": run.pipeline},
        }
        tasks = {t.key: t for t in spec.tasks}
        pending = list(tasks)  # keeps YAML order for deterministic scheduling
        running: dict[asyncio.Task[None], str] = {}

        try:
            while pending or running:
                self._skip_blocked(run, pending)
                ready = [
                    k
                    for k in pending
                    if all(run.tasks[d].status == RunStatus.SUCCEEDED for d in tasks[k].depends_on)
                ]
                for key in ready:
                    pending.remove(key)
                    job = asyncio.create_task(self._run_task(run, tasks[key], scope))
                    running[job] = key
                if not running:
                    break
                done, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for job in done:
                    running.pop(job)
                    job.result()  # _run_task records failures itself; this re-raises bugs

            failed = [k for k, t in run.tasks.items() if t.status != RunStatus.SUCCEEDED]
            if failed:
                run.status = RunStatus.FAILED
                first = next(
                    (t for t in run.tasks.values() if t.status == RunStatus.FAILED), None
                )
                run.error = (
                    f"Task '{first.key}' failed: {first.error}" if first else "Some tasks did not run"
                )
            else:
                try:
                    run.outputs = resolve(spec.outputs, scope)
                    run.status = RunStatus.SUCCEEDED
                except Exception as exc:
                    run.status = RunStatus.FAILED
                    run.error = f"Could not resolve outputs: {exc}"
        except asyncio.CancelledError:
            for job in running:
                job.cancel()
            await asyncio.gather(*running, return_exceptions=True)
            for key in pending:
                run.tasks[key].status = RunStatus.CANCELLED
            run.status = RunStatus.CANCELLED
            run.error = run.error or "Cancelled"
            raise
        except Exception as exc:  # engine bug: never leave a run stuck in RUNNING
            log.exception("Run %s crashed", run.id)
            run.status = RunStatus.FAILED
            run.error = f"Internal error: {exc}"
        finally:
            run.ended_at = utcnow()
            self.store.save(run)
        return run

    def _skip_blocked(self, run: Run, pending: list[str]) -> None:
        changed = True
        while changed:
            changed = False
            for key in list(pending):
                task_run = run.tasks[key]
                blocker = next(
                    (d for d in task_run.depends_on if run.tasks[d].status in _NOT_SUCCEEDED), None
                )
                if blocker:
                    pending.remove(key)
                    task_run.status = RunStatus.SKIPPED
                    task_run.error = f"Upstream task '{blocker}' did not succeed"
                    task_run.ended_at = utcnow()
                    changed = True
        self.store.save(run)

    async def _run_task(self, run: Run, task: AnyTask, scope: dict[str, Any]) -> None:
        tr = run.tasks[task.key]
        tr.started_at = utcnow()
        for attempt in range(1, task.retries + 2):
            tr.attempt = attempt
            tr.status = RunStatus.RUNNING
            tr.error = None
            if attempt > 1:
                tr.log(f"Retry attempt {attempt} of {tr.max_attempts}")
            self.store.save(run)
            try:
                coro = self._dispatch(run, task, tr, scope, attempt)
                if task.timeout_seconds:
                    output = await asyncio.wait_for(coro, task.timeout_seconds)
                else:
                    output = await coro
            except asyncio.CancelledError:
                tr.status = RunStatus.CANCELLED
                tr.error = "Cancelled"
                tr.ended_at = utcnow()
                self.store.save(run)
                raise
            except Exception as exc:
                if isinstance(exc, TimeoutError):
                    message = f"Timed out after {task.timeout_seconds:g}s"
                else:
                    message = f"{type(exc).__name__}: {exc}"
                tr.error = message
                tr.log(f"ERROR {message}")
                if attempt <= task.retries:
                    continue
                tr.status = RunStatus.FAILED
                tr.ended_at = utcnow()
                self.store.save(run)
                return
            tr.output = output
            tr.status = RunStatus.SUCCEEDED
            tr.ended_at = utcnow()
            scope["tasks"][task.key] = {"output": output}
            self.store.save(run)
            return

    async def _dispatch(
        self, run: Run, task: AnyTask, tr: TaskRun, scope: dict[str, Any], attempt: int
    ) -> Any:
        logger = _threadsafe_logger(tr)
        if isinstance(task, PythonTask):
            params = resolve(task.parameters, scope)
            project = self.workspace.project_dir_for(run.pipeline)
            func = load_callable(project / "src", task.entrypoint)
            ctx = TaskContext(
                run_id=run.id,
                root_run_id=run.root_run_id or run.id,
                pipeline=run.pipeline,
                task_key=task.key,
                attempt=attempt,
                workspace=project,
                parameters=params,
                _log=logger,
            )
            tr.log(f"Calling {task.entrypoint}")
            return await run_python(func, params, ctx)

        if isinstance(task, ShellTask):
            command = resolve(task.command, scope)
            env = {k: str(v) for k, v in resolve(task.env, scope).items()}
            tr.log(f"$ {command}")
            return await run_shell(command, env, self.workspace.project_dir_for(run.pipeline), logger)

        if isinstance(task, PipelineTask):
            return await self._run_sub_pipeline(run, task, tr, scope)

        raise TypeError(f"Unsupported task type: {task!r}")

    async def _run_sub_pipeline(
        self, run: Run, task: PipelineTask, tr: TaskRun, scope: dict[str, Any]
    ) -> Any:
        depth = run.depth + 1
        if depth > self.max_depth:
            raise SubPipelineFailed(f"Maximum sub-pipeline depth ({self.max_depth}) exceeded")
        params = resolve(task.parameters, scope)
        parent = _Parent(
            run_id=run.id,
            task_key=task.key,
            root_run_id=run.root_run_id or run.id,
            depth=depth,
        )
        child, child_spec = self.prepare(task.pipeline, params, parent=parent)
        tr.child_run_id = child.id
        tr.log(f"Started sub-pipeline '{task.pipeline}' as run {child.id}")
        self.store.save(run)

        handle = self._launch(child, child_spec)
        try:
            result = await handle
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise  # this run is being cancelled; the child was cancelled with it
            raise SubPipelineFailed(f"Sub-pipeline run {child.id} was cancelled") from None

        if result.status != RunStatus.SUCCEEDED:
            raise SubPipelineFailed(
                f"Sub-pipeline '{task.pipeline}' (run {child.id}) {result.status.value.lower()}: "
                f"{result.error}"
            )
        tr.log(f"Sub-pipeline run {child.id} succeeded")
        return result.outputs


def _threadsafe_logger(tr: TaskRun) -> Callable[[str], None]:
    """A log function that is safe to call from task worker threads."""
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()

    def _log(message: str) -> None:
        if threading.get_ident() == loop_thread:
            tr.log(message)
        else:
            loop.call_soon_threadsafe(tr.log, message)

    return _log

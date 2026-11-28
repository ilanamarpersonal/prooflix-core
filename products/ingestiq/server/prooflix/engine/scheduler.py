"""Starts pipeline runs on their cron schedules.

A pipeline with ``schedule:`` in its YAML (and ``enabled: true``, the default) runs
automatically at each time its cron expression matches. The scheduler runs inside
the server: every second it reloads the pipelines, so adding, editing or pausing
a schedule takes effect on the next tick without a restart, and six-field
(seconds) schedules such as ``*/15 * * * * *`` run on time.

- No catch-up: times that passed while the server was down, or before a schedule
  was added or changed, are not run afterwards. Counting starts from then.
- No overlap: if a run of the pipeline is still going when the next one is due, the
  due run is skipped (and recorded as skipped); the one after is tried as usual.
- Scheduled runs are ordinary runs with ``trigger = "schedule"`` and the cron time
  they were due in ``scheduled_for``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from ..pipelines import Workspace
from ..pipelines.cron import Cron
from ..runs import RunStore
from .executor import PipelineExecutor

log = logging.getLogger(__name__)

TICK_SECONDS = 1.0  # schedules can be seconds apart


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ScheduleState:
    """What the scheduler knows about one pipeline's schedule."""

    pipeline: str
    signature: tuple[str, str, bool]  # (cron, timezone, enabled); a change restarts the count
    checked_until: datetime  # due times up to here have been handled
    last_run_id: str | None = None
    last_run_at: datetime | None = None  # the cron time of the last scheduled run
    last_skipped_at: datetime | None = None  # the cron time of the last skipped run
    last_error: str | None = None


class Scheduler:
    def __init__(
        self,
        workspace: Workspace,
        executor: PipelineExecutor,
        store: RunStore,
        *,
        tick_seconds: float = TICK_SECONDS,
        clock: Callable[[], datetime] = utcnow,
    ):
        self.workspace = workspace
        self.executor = executor
        self.store = store
        self.tick_seconds = tick_seconds
        self.clock = clock
        self.states: dict[str, ScheduleState] = {}
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """Start ticking in the background. Must be called on the event loop."""
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="scheduler")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # one bad tick (e.g. a file being written) must not stop scheduling
                log.exception("Scheduler tick failed")
            await asyncio.sleep(self.tick_seconds)

    # ------------------------------------------------------------ one tick
    def _is_running(self, pipeline_id: str) -> bool:
        return any(not r.status.terminal for r in self.store.list(pipeline=pipeline_id, root_only=True, limit=50))

    def tick(self) -> list[str]:
        """Start the runs that are due now. Returns the ids of the runs started."""
        now = self.clock()
        started: list[str] = []
        seen: set[str] = set()
        for pid, definition in self.workspace.load_all().items():
            schedule = definition.spec.schedule if definition.valid and definition.spec else None
            if schedule is None:
                continue
            seen.add(pid)
            signature = (schedule.cron, schedule.timezone, schedule.enabled)
            state = self.states.get(pid)
            if state is None or state.signature != signature:
                # new or changed schedule: count from now, don't catch up
                previous = state
                state = ScheduleState(pid, signature, checked_until=now)
                if previous is not None:  # keep the history across edits
                    state.last_run_id, state.last_run_at = previous.last_run_id, previous.last_run_at
                    state.last_skipped_at = previous.last_skipped_at
                self.states[pid] = state
                continue
            if not schedule.enabled:
                state.checked_until = now
                continue
            due = Cron.parse(schedule.cron).next_after(state.checked_until, schedule.timezone)
            if due > now:
                continue
            state.checked_until = now  # only the latest due time runs; no backlog
            if self._is_running(pid):
                state.last_skipped_at = due
                log.info("Skipped the scheduled run of %s due at %s: the previous run is still going", pid, due)
                continue
            try:
                run = self.executor.start(pid, trigger="schedule", scheduled_for=due)
            except Exception as exc:  # e.g. the pipeline became invalid between load and start
                state.last_error = str(exc)
                log.warning("Could not start the scheduled run of %s: %s", pid, exc)
                continue
            state.last_run_id, state.last_run_at, state.last_error = run.id, due, None
            started.append(run.id)
            log.info("Started scheduled run %s of %s (due %s)", run.id, pid, due)
        for pid in set(self.states) - seen:  # schedule removed or pipeline deleted
            del self.states[pid]
        return started

    # ------------------------------------------------------------ status
    def next_run(self, pipeline_id: str, cron: str, tz: str, enabled: bool) -> datetime | None:
        if not enabled:
            return None
        state = self.states.get(pipeline_id)
        after = state.checked_until if state and state.signature == (cron, tz, enabled) else self.clock()
        return Cron.parse(cron).next_after(max(after, self.clock()), tz)

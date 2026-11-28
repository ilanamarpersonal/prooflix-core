import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import yaml
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.engine import PipelineExecutor, Scheduler
from prooflix.main import create_app
from prooflix.pipelines import Workspace
from prooflix.pipelines.cron import Cron, CronError
from prooflix.pipelines.schedule_yaml import set_schedule
from prooflix.runs import RunStatus, RunStore


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


# ---------------------------------------------------------------- cron
@pytest.mark.parametrize(
    "expr, after, tz, expected",
    [
        ("*/15 * * * *", utc(2026, 11, 10, 19, 37), "UTC", utc(2026, 11, 10, 19, 45)),
        ("0 * * * *", utc(2026, 11, 10, 19, 0), "UTC", utc(2026, 11, 10, 20, 0)),  # strictly after
        ("30 2 * * *", utc(2026, 11, 10, 19, 37), "UTC", utc(2026, 11, 11, 2, 30)),
        ("0 9 * * 1-5", utc(2026, 11, 13, 10, 0), "UTC", utc(2026, 11, 16, 9, 0)),  # Fri -> Mon
        ("0 9 * * mon,fri", utc(2026, 11, 10, 0, 0), "UTC", utc(2026, 11, 13, 9, 0)),
        ("0 6 1 * *", utc(2026, 11, 10, 0, 0), "UTC", utc(2026, 12, 1, 6, 0)),
        ("0 0 29 2 *", utc(2026, 3, 1, 0, 0), "UTC", utc(2028, 2, 29, 0, 0)),
        ("0 0 1 * mon", utc(2026, 11, 10, 0, 0), "UTC", utc(2026, 11, 16, 0, 0)),  # day 1 OR Monday
        ("0 0 * * 7", utc(2026, 11, 10, 0, 0), "UTC", utc(2026, 11, 15, 0, 0)),  # 7 is Sunday
        ("30 2 * * *", utc(2026, 11, 10, 0, 0), "Asia/Jerusalem", utc(2026, 11, 10, 0, 30)),  # 02:30 at UTC+2
        # six fields: seconds first
        ("*/15 * * * * *", utc(2026, 11, 10, 19, 37, 7), "UTC", utc(2026, 11, 10, 19, 37, 15)),
        ("*/15 * * * * *", utc(2026, 11, 10, 19, 37, 45), "UTC", utc(2026, 11, 10, 19, 38, 0)),  # strictly after
        ("*/10 * * * * *", utc(2026, 11, 10, 19, 59, 55), "UTC", utc(2026, 11, 10, 20, 0, 0)),
        ("30 0 9 * * *", utc(2026, 11, 10, 9, 0, 31), "UTC", utc(2026, 11, 11, 9, 0, 30)),
        ("0 */5 * * * *", utc(2026, 11, 10, 19, 37, 7), "UTC", utc(2026, 11, 10, 19, 40, 0)),
    ],
)
def test_cron_next_after(expr, after, tz, expected):
    assert Cron.parse(expr).next_after(after, tz) == expected


def test_six_field_cron_runs_every_15_seconds():
    runs = Cron.parse("*/15 * * * * *").next_runs(utc(2026, 11, 10, 12, 0, 50), count=5)
    assert [(t.minute, t.second) for t in runs] == [(1, 0), (1, 15), (1, 30), (1, 45), (2, 0)]
    assert Cron.parse("*/15 * * * * *").has_seconds and not Cron.parse("* * * * *").has_seconds


def test_cron_skips_a_time_that_daylight_saving_skips():
    # New York jumps from 02:00 to 03:00 on 2027-03-14, so 02:30 doesn't happen that day
    runs = Cron.parse("30 2 * * *").next_runs(utc(2027, 3, 13, 12, 0), "America/New_York", 2)
    assert runs == [utc(2027, 3, 15, 6, 30), utc(2027, 3, 16, 6, 30)]


@pytest.mark.parametrize(
    "expr, message",
    [
        ("* * *", "5 fields"),
        ("* * * * * * *", "or 6 with seconds first"),
        ("60 * * * * *", "second 60 is out of range"),
        ("*/0 * * * * *", "step for the second"),
        ("61 * * * *", "out of range"),
        ("* * * * foo", "not a valid day of week"),
        ("5-1 * * * *", "backwards"),
        ("*/0 * * * *", "step"),
    ],
)
def test_cron_errors(expr, message):
    with pytest.raises(CronError, match=message):
        Cron.parse(expr)


def test_cron_that_never_matches():
    with pytest.raises(CronError, match="never matches"):
        Cron.parse("0 0 31 2 *").next_after(utc(2026, 1, 1))


# ---------------------------------------------------------------- YAML block
SOURCE = """\
# Daily job: keep this comment
name: Daily
description: Something

# The tasks
tasks:
  - key: a
    type: shell
    command: "true"
"""


def test_set_schedule_adds_replaces_and_removes_the_block_only():
    added = set_schedule(SOURCE, ("0 * * * *", "UTC", True))
    assert added.startswith("# Daily job: keep this comment\nname: Daily")
    assert 'schedule:\n  cron: "0 * * * *"\n  timezone: UTC\n  enabled: true\n\n# The tasks\ntasks:' in added
    assert yaml.safe_load(added)["schedule"] == {"cron": "0 * * * *", "timezone": "UTC", "enabled": True}

    replaced = set_schedule(added, ("*/5 * * * *", "Asia/Jerusalem", False))
    assert yaml.safe_load(replaced)["schedule"] == {
        "cron": "*/5 * * * *",
        "timezone": "Asia/Jerusalem",
        "enabled": False,
    }
    assert replaced.count("schedule:") == 1 and "# The tasks" in replaced

    removed = set_schedule(replaced, None)
    assert "schedule" not in removed
    assert removed == SOURCE


def test_set_schedule_replaces_a_hand_written_block_at_the_end():
    source = SOURCE + "schedule:\n  cron: '0 2 * * *'   # nightly\n"
    out = set_schedule(source, ("0 3 * * *", "UTC", True))
    assert yaml.safe_load(out)["schedule"]["cron"] == "0 3 * * *"
    assert out.count("schedule:") == 1


# ---------------------------------------------------------------- scheduler
class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def _workspace(ws_factory, cron="*/15 * * * *", **schedule):
    sched = {"cron": cron, **schedule}
    lines = "\n".join(f"  {k}: {v!r}" if isinstance(v, str) else f"  {k}: {str(v).lower()}" for k, v in sched.items())
    ws_factory.add("job", f"tasks:\n  - key: a\n    type: shell\n    command: 'true'\nschedule:\n{lines}\n")
    return Workspace(ws_factory.root)


def _scheduler(ws, clock):
    store = RunStore(ws.root / ".prooflix" / "runs")
    executor = PipelineExecutor(ws, store)
    return Scheduler(ws, executor, store, clock=clock), executor, store


async def _drain(executor):
    await asyncio.gather(*list(executor._active.values()), return_exceptions=True)


def test_scheduler_runs_due_pipelines_without_catching_up(ws_factory):
    ws = _workspace(ws_factory)
    clock = Clock(utc(2026, 11, 10, 10, 7))

    async def scenario():
        scheduler, executor, store = _scheduler(ws, clock)
        assert scheduler.tick() == []  # first sight: start counting from now, don't run
        clock.now = utc(2026, 11, 10, 10, 14)
        assert scheduler.tick() == []  # not due yet
        assert scheduler.next_run("job", "*/15 * * * *", "UTC", True) == utc(2026, 11, 10, 10, 15)
        clock.now = utc(2026, 11, 10, 10, 15, 3)
        [run_id] = scheduler.tick()
        await _drain(executor)
        run = store.get(run_id)
        assert run.status == RunStatus.SUCCEEDED
        assert run.trigger == "schedule" and run.scheduled_for == utc(2026, 11, 10, 10, 15)
        assert scheduler.tick() == []  # the same due time runs once
        # the server was busy (or down) for an hour: only one run, not four
        clock.now = utc(2026, 11, 10, 11, 16)
        assert len(scheduler.tick()) == 1
        await _drain(executor)
        assert scheduler.next_run("job", "*/15 * * * *", "UTC", True) == utc(2026, 11, 10, 11, 30)

    asyncio.run(scenario())


def test_scheduler_runs_a_seconds_schedule(ws_factory):
    ws = _workspace(ws_factory, cron="*/15 * * * * *")
    clock = Clock(utc(2026, 11, 10, 10, 0, 1))

    async def scenario():
        scheduler, executor, store = _scheduler(ws, clock)
        assert scheduler.tick() == []  # first sight
        assert scheduler.next_run("job", "*/15 * * * * *", "UTC", True) == utc(2026, 11, 10, 10, 0, 15)
        clock.now = utc(2026, 11, 10, 10, 0, 15, 300000)
        [first] = scheduler.tick()
        await _drain(executor)
        clock.now = utc(2026, 11, 10, 10, 0, 30, 100000)
        [second] = scheduler.tick()
        await _drain(executor)
        assert store.get(first).scheduled_for == utc(2026, 11, 10, 10, 0, 15)
        assert store.get(second).scheduled_for == utc(2026, 11, 10, 10, 0, 30)

    asyncio.run(scenario())


def test_scheduler_skips_while_the_previous_run_is_still_going(ws_factory):
    ws_factory.add("job", "tasks:\n  - key: a\n    type: shell\n    command: 'sleep 1'\nschedule:\n  cron: '* * * * *'\n")
    ws = Workspace(ws_factory.root)
    clock = Clock(utc(2026, 11, 10, 10, 0, 30))

    async def scenario():
        scheduler, executor, store = _scheduler(ws, clock)
        scheduler.tick()
        clock.now = utc(2026, 11, 10, 10, 1, 1)
        [first] = scheduler.tick()
        await asyncio.sleep(0.1)  # the run is going
        clock.now = utc(2026, 11, 10, 10, 2, 1)
        assert scheduler.tick() == []
        assert scheduler.states["job"].last_skipped_at == utc(2026, 11, 10, 10, 2)
        await _drain(executor)
        clock.now = utc(2026, 11, 10, 10, 3, 1)
        assert len(scheduler.tick()) == 1
        await _drain(executor)
        assert store.get(first).status == RunStatus.SUCCEEDED

    asyncio.run(scenario())


def test_paused_and_edited_schedules(ws_factory):
    ws = _workspace(ws_factory, cron="* * * * *", enabled=False)
    clock = Clock(utc(2026, 11, 10, 10, 0, 30))

    async def scenario():
        scheduler, executor, _ = _scheduler(ws, clock)
        scheduler.tick()
        clock.now += timedelta(minutes=5)
        assert scheduler.tick() == []  # paused
        assert scheduler.next_run("job", "* * * * *", "UTC", False) is None
        # resumed: counting starts again from now, the paused minutes don't run
        _workspace(ws_factory, cron="* * * * *", enabled=True)
        assert scheduler.tick() == []
        clock.now += timedelta(minutes=1)
        assert len(scheduler.tick()) == 1
        await _drain(executor)
        # schedule removed: forgotten
        ws_factory.add("job", "tasks:\n  - key: a\n    type: shell\n    command: 'true'\n")
        clock.now += timedelta(minutes=1)
        assert scheduler.tick() == [] and "job" not in scheduler.states

    asyncio.run(scenario())


# ---------------------------------------------------------------- API
@pytest.fixture
def client(sample_workspace, tmp_path):
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client", scheduler=False)
    with TestClient(create_app(settings)) as c:
        yield c


def test_set_and_remove_a_schedule_through_the_api(client, sample_workspace):
    assert client.get("/api/pipelines/hello_world").json()["schedule"] is None
    res = client.put("/api/pipelines/hello_world/schedule", json={"cron": "0 2 * * *", "timezone": "Asia/Jerusalem"})
    assert res.status_code == 200, res.text
    sched = res.json()["schedule"]
    assert (sched["cron"], sched["timezone"], sched["enabled"]) == ("0 2 * * *", "Asia/Jerusalem", True)
    assert sched["next_run"] is not None
    text = (sample_workspace / "pipelines" / "hello_world.yaml").read_text()
    assert 'schedule:\n  cron: "0 2 * * *"\n  timezone: Asia/Jerusalem\n  enabled: true' in text
    assert text.startswith("name: Hello world")  # the rest of the file is untouched

    listed = {p["id"]: p for p in client.get("/api/pipelines").json()}
    assert listed["hello_world"]["schedule"]["cron"] == "0 2 * * *"

    paused = client.put("/api/pipelines/hello_world/schedule", json={"cron": "0 2 * * *", "enabled": False}).json()
    assert paused["schedule"]["enabled"] is False and paused["schedule"]["next_run"] is None

    removed = client.delete("/api/pipelines/hello_world/schedule").json()
    assert removed["schedule"] is None and "schedule" not in (sample_workspace / "pipelines" / "hello_world.yaml").read_text()


def test_invalid_schedules_are_refused(client, sample_workspace):
    before = (sample_workspace / "pipelines" / "hello_world.yaml").read_text()
    res = client.put("/api/pipelines/hello_world/schedule", json={"cron": "61 * * * *"})
    assert res.status_code == 422 and "out of range" in res.json()["detail"]["errors"][0]
    res = client.put("/api/pipelines/hello_world/schedule", json={"cron": "0 * * * *", "timezone": "Mars/Base"})
    assert res.status_code == 422 and "Unknown time zone" in res.json()["detail"]["errors"][0]
    assert (sample_workspace / "pipelines" / "hello_world.yaml").read_text() == before
    assert client.put("/api/pipelines/nope/schedule", json={"cron": "0 * * * *"}).status_code == 404


def test_schedule_preview(client):
    ok = client.post("/api/schedules/preview", json={"cron": "0  9 * * mon-fri", "timezone": "UTC"}).json()
    assert ok["valid"] and ok["cron"] == "0 9 * * mon-fri" and len(ok["next_runs"]) == 5
    secs = client.post("/api/schedules/preview", json={"cron": "*/15 * * * * *", "timezone": "UTC"}).json()
    assert secs["valid"] and len(secs["next_runs"]) == 5
    gaps = {
        (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()
        for a, b in zip(secs["next_runs"], secs["next_runs"][1:])
    }
    assert gaps == {15.0}
    bad = client.post("/api/schedules/preview", json={"cron": "every hour"}).json()
    assert not bad["valid"] and "5 fields" in bad["error"]


def test_manual_runs_are_marked_manual(client):
    run = client.post("/api/pipelines/hello_world/runs", json={}).json()
    assert run["trigger"] == "manual" and run["scheduled_for"] is None

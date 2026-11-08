from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import pytest

from prooflix.pipelines import Workspace

SAMPLE_WORKSPACE = Path(__file__).parent / "fixtures" / "sample_workspace"

TASKS_PY = '''
import asyncio
import time

def add(a, b):
    return a + b

def echo(ctx, **kwargs):
    ctx.log(f"echo {kwargs}")
    return kwargs

def boom(message="boom"):
    raise RuntimeError(message)

_calls = {"n": 0}
def flaky(fail_times: int):
    _calls["n"] += 1
    if _calls["n"] <= fail_times:
        raise RuntimeError(f"flaky failure {_calls['n']}")
    return {"calls": _calls["n"]}

def slow(seconds: float):
    time.sleep(seconds)
    return "done"

async def async_sleep(seconds: float):
    await asyncio.sleep(seconds)
    return "slept"
'''


class WorkspaceFactory:
    def __init__(self, root: Path):
        self.root = root
        (root / "pipelines").mkdir(parents=True)
        (root / "src").mkdir()
        (root / "src" / "testtasks.py").write_text(TASKS_PY)

    def add(self, pipeline_id: str, yaml_text: str) -> None:
        (self.root / "pipelines" / f"{pipeline_id}.yaml").write_text(textwrap.dedent(yaml_text))

    @property
    def workspace(self) -> Workspace:
        return Workspace(self.root)


@pytest.fixture
def ws_factory(tmp_path: Path) -> WorkspaceFactory:
    import sys

    sys.modules.pop("testtasks", None)  # fresh module state (flaky counter) per test
    return WorkspaceFactory(tmp_path / "ws")


@pytest.fixture
def sample_workspace(tmp_path: Path) -> Path:
    """A copy of the sample workspace kept with the tests (pipelines, src, data)."""
    dest = tmp_path / "sample"
    shutil.copytree(SAMPLE_WORKSPACE, dest, ignore=shutil.ignore_patterns(".prooflix", "output"))
    return dest

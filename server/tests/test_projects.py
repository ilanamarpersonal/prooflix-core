"""Pipelines in imported project folders (workspace/<project>/pipelines + src)."""

import asyncio
import textwrap

import pytest

from prooflix.engine import PipelineExecutor
from prooflix.pipelines import Workspace
from prooflix.runs import RunStore


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text))


def make_project(root, name, message, module="hello_jobs", call=None):
    """A project like prooflix-assets-bundle: one pipeline printing a message."""
    pid = name.replace("-", "_")
    write(root / name / "src" / module / "__init__.py", "")
    write(
        root / name / "src" / module / "hello.py",
        f"""
        def run():
            print("{message}")
            print("second line")
            return {{"message": "{message}"}}
        """,
    )
    tasks = f"""
    tasks:
      - key: hello
        type: python
        entrypoint: {module}.hello:run
    """
    if call:
        tasks += f"""
      - key: child
        type: pipeline
        pipeline: {call}
        depends_on: [hello]
    """
    write(root / name / "pipelines" / f"{pid}.yaml", tasks)
    return pid


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "ws"
    r.mkdir()
    return r


def run_pipeline(root, pid):
    async def go():
        ex = PipelineExecutor(Workspace(root), RunStore(root / ".prooflix" / "runs"))
        return await ex.run(pid), ex

    return asyncio.run(go())


def test_projects_are_discovered_and_root_is_optional(root):
    make_project(root, "proj-a", "A")
    make_project(root, "proj-b", "B")
    (root / "notes").mkdir()  # no pipelines/ folder: not a project
    ws = Workspace(root)
    assert [p.name for p in ws.projects()] == ["proj-a", "proj-b"]
    assert ws.list_ids() == ["proj_a", "proj_b"]
    assert ws.project_of("proj_a") == "proj-a"
    assert ws.src_dir_for("proj_b") == root / "proj-b" / "src"
    assert all(d.valid for d in ws.load_all().values())


def test_duplicate_pipeline_ids_are_errors(root):
    make_project(root, "one", "1")
    write(root / "two" / "pipelines" / "one.yaml", "tasks:\n  - key: a\n    type: shell\n    command: 'true'\n")
    d = Workspace(root).load_all()["one"]
    assert not d.valid
    assert any("defined more than once" in e for e in d.errors)


def test_print_output_goes_to_the_task_log(root):
    pid = make_project(root, "proj-a", "hello World1")
    run, _ = run_pipeline(root, pid)
    assert run.status.value == "SUCCEEDED"
    logs = [line.split(" ", 1)[1] for line in run.tasks["hello"].logs]  # drop the timestamp
    assert logs[-2:] == ["hello World1", "second line"]


def test_projects_with_the_same_module_name_use_their_own_code(root):
    a = make_project(root, "proj-a", "from A")
    b = make_project(root, "proj-b", "from B")
    run_a, _ = run_pipeline(root, a)
    run_b, _ = run_pipeline(root, b)
    assert "from A" in "\n".join(run_a.tasks["hello"].logs)
    assert "from B" in "\n".join(run_b.tasks["hello"].logs)


def test_sub_pipeline_across_projects_and_child_printout(root):
    child = make_project(root, "proj-b", "Hello World2", module="jobs_b")
    parent = make_project(root, "proj-a", "hello World1", module="jobs_a", call=child)
    run, ex = run_pipeline(root, parent)
    assert run.status.value == "SUCCEEDED"
    child_run = ex.store.get(run.tasks["child"].child_run_id)
    assert "Hello World2" in "\n".join(child_run.tasks["hello"].logs)

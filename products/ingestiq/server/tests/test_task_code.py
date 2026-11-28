"""``GET /api/pipelines/{id}/tasks/{key}/code``: the code a selected task runs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app


@pytest.fixture
def client(sample_workspace, tmp_path):
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client", scheduler=False)
    with TestClient(create_app(settings)) as c:
        yield c


def test_python_task_returns_its_module_and_function_line(client, sample_workspace):
    r = client.get("/api/pipelines/ingest_orders/tasks/validate/code")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["type"] == "python" and body["language"] == "python"
    assert body["path"] == "src/jobs/orders.py"
    assert body["content"] == (sample_workspace / "src/jobs/orders.py").read_text()
    lines = body["content"].splitlines()
    assert lines[body["line"] - 1].startswith("def validate_orders(")


def test_shell_task_returns_its_command(client):
    body = client.get("/api/pipelines/hello_world/tasks/greet/code").json()
    assert body["type"] == "shell" and body["path"] is None
    assert body["content"] == 'echo "Hello, ${params.who}!"'


def test_sub_pipeline_task_returns_the_child_yaml(client, sample_workspace):
    body = client.get("/api/pipelines/daily_orders/tasks/ingest/code").json()
    assert body["type"] == "pipeline" and body["language"] == "yaml"
    assert body["path"] == "pipelines/ingest_orders.yaml"
    assert body["content"] == (sample_workspace / "pipelines/ingest_orders.yaml").read_text()


def test_package_module_and_missing_function(client, sample_workspace):
    (sample_workspace / "src/pkg").mkdir()
    (sample_workspace / "src/pkg/__init__.py").write_text("x = 1\n")
    (sample_workspace / "pipelines/pkg_task.yaml").write_text(
        "tasks:\n  - key: t\n    type: python\n    entrypoint: pkg:nope\n"
    )
    body = client.get("/api/pipelines/pkg_task/tasks/t/code").json()
    assert body["path"] == "src/pkg/__init__.py" and body["line"] is None


def test_missing_module_pipeline_and_task_are_404(client, sample_workspace):
    (sample_workspace / "pipelines/ghost.yaml").write_text(
        "tasks:\n  - key: t\n    type: python\n    entrypoint: nowhere.mod:run\n"
    )
    r = client.get("/api/pipelines/ghost/tasks/t/code")
    assert r.status_code == 404 and "nowhere.mod" in r.json()["detail"]
    assert client.get("/api/pipelines/nope/tasks/t/code").status_code == 404
    assert client.get("/api/pipelines/hello_world/tasks/nope/code").status_code == 404

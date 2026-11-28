"""Editing and saving workspace files (Workspace tab)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app


@pytest.fixture
def ws_client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    (ws / "src").mkdir()
    (ws / "src" / "job.py").write_text("def run():\n    return 1\n")
    (ws / "data.bin").write_bytes(b"\0\1\2")
    (ws / ".secret").write_text("x")
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "c")
    with TestClient(create_app(settings)) as c:
        yield c, ws


def test_save_a_file(ws_client):
    c, ws = ws_client
    f = c.get("/api/workspace/file", params={"path": "src/job.py"}).json()
    assert f["modified"]
    r = c.put("/api/workspace/file", json={"path": "src/job.py", "content": "def run():\n    return 2\n",
                                           "modified": f["modified"]})
    assert r.status_code == 200 and "return 2" in r.json()["content"]
    assert (ws / "src" / "job.py").read_text() == "def run():\n    return 2\n"
    assert not list((ws / "src").glob(".*saving"))


def test_a_changed_file_is_not_overwritten(ws_client):
    c, ws = ws_client
    old = c.get("/api/workspace/file", params={"path": "src/job.py"}).json()["modified"]
    import os

    os.utime(ws / "src" / "job.py", (old + 5, old + 5))  # someone else saved meanwhile
    r = c.put("/api/workspace/file", json={"path": "src/job.py", "content": "x", "modified": old})
    assert r.status_code == 409 and (ws / "src" / "job.py").read_text().startswith("def run")


@pytest.mark.parametrize(
    ("path", "code"),
    [("missing.py", 404), (".secret", 404), ("data.bin", 422), ("../outside.txt", 400)],
)
def test_what_cannot_be_saved(ws_client, path, code):
    c, _ = ws_client
    assert c.put("/api/workspace/file", json={"path": path, "content": "x"}).status_code == code


def test_too_large(ws_client):
    c, _ = ws_client
    r = c.put("/api/workspace/file", json={"path": "src/job.py", "content": "x" * (1024 * 1024 + 1)})
    assert r.status_code == 413

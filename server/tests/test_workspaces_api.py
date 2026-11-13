"""Creating workspaces, switching the active one, and the folder picker API."""

from __future__ import annotations

import json
import textwrap
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app
from prooflix.workspaces import WorkspaceRegistry


def make_client(default: Path, tmp_path: Path, home: Path | None = None) -> TestClient:
    settings = Settings(workspace=default, client_dist=tmp_path / "no-client", home=home, scheduler=False)
    return TestClient(create_app(settings))


@pytest.fixture
def client(sample_workspace, tmp_path):
    with make_client(sample_workspace, tmp_path, home=tmp_path / "home") as c:
        yield c


def test_default_workspace_is_listed_and_active(client, sample_workspace):
    body = client.get("/api/workspaces").json()
    assert body["active"] == str(sample_workspace.resolve())
    [entry] = body["workspaces"]
    assert entry == {
        "name": sample_workspace.name,
        "path": str(sample_workspace.resolve()),
        "active": True,
        "default": True,
        "in_root": False,
        "exists": True,
    }


def test_create_makes_folder_with_pipelines_and_src_but_does_not_activate(client, tmp_path, sample_workspace):
    parent = tmp_path / "projects"
    parent.mkdir()
    r = client.post("/api/workspaces", json={"parent": str(parent), "name": "analytics"})
    assert r.status_code == 201, r.text
    created = parent / "analytics"
    assert (created / "pipelines").is_dir() and (created / "src").is_dir()
    assert r.json() == {
        "name": "analytics",
        "path": str(created.resolve()),
        "active": False,
        "default": False,
        "in_root": False,
        "exists": True,
    }
    body = client.get("/api/workspaces").json()
    assert body["active"] == str(sample_workspace.resolve())
    assert [w["name"] for w in body["workspaces"]] == [sample_workspace.name, "analytics"]


@pytest.mark.parametrize(
    "payload, code",
    [
        ({"name": "../escape"}, 400),
        ({"name": ".hidden"}, 400),
        ({"name": "a/b"}, 400),
        ({"name": "ok", "parent": "relative/path"}, 400),
        ({"name": "ok", "parent": "/no/such/folder/anywhere"}, 400),
    ],
)
def test_create_rejects_bad_input(client, tmp_path, payload, code):
    body = {"parent": str(tmp_path), **payload}
    assert client.post("/api/workspaces", json=body).status_code == code


def test_create_refuses_existing_folder(client, tmp_path):
    (tmp_path / "taken").mkdir()
    r = client.post("/api/workspaces", json={"parent": str(tmp_path), "name": "taken"})
    assert r.status_code == 409


def test_switching_changes_pipelines_and_runs(client, tmp_path, sample_workspace):
    assert "daily_orders" in [p["id"] for p in client.get("/api/pipelines").json()]
    client.post("/api/workspaces", json={"parent": str(tmp_path), "name": "fresh"})
    fresh = tmp_path / "fresh"
    (fresh / "pipelines" / "hello.yaml").write_text(
        textwrap.dedent(
            """
            tasks:
              - key: say
                type: shell
                command: echo hi
            """
        )
    )

    r = client.put("/api/workspaces/active", json={"path": str(fresh)})
    assert r.status_code == 200, r.text
    assert r.json()["active"] == str(fresh.resolve())
    assert [p["id"] for p in client.get("/api/pipelines").json()] == ["hello"]
    assert client.get("/api/health").json()["workspace"] == str(fresh.resolve())
    tree = client.get("/api/workspace/tree").json()
    assert tree["name"] == "fresh"

    # runs are recorded in the new workspace's own history
    run = client.post("/api/pipelines/hello/runs", json={"parameters": {}}).json()
    for _ in range(100):
        if client.get(f"/api/runs/{run['id']}").json()["status"] == "SUCCEEDED":
            break
        time.sleep(0.05)
    assert (fresh / ".prooflix" / "runs" / f"{run['id']}.json").is_file()

    # and switching back shows the default workspace again, without that run
    client.put("/api/workspaces/active", json={"path": str(sample_workspace)})
    assert "daily_orders" in [p["id"] for p in client.get("/api/pipelines").json()]
    assert run["id"] not in [r["id"] for r in client.get("/api/runs").json()]


def test_switch_refuses_while_runs_are_going(client, tmp_path, sample_workspace):
    (sample_workspace / "pipelines" / "sleepy.yaml").write_text(
        "tasks:\n  - key: wait\n    type: shell\n    command: sleep 5\n"
    )
    run = client.post("/api/pipelines/sleepy/runs", json={"parameters": {}}).json()
    other = tmp_path / "other"
    other.mkdir()
    r = client.put("/api/workspaces/active", json={"path": str(other)})
    assert r.status_code == 409
    assert "still going" in r.json()["detail"]
    client.post(f"/api/runs/{run['id']}/cancel")


def test_switch_to_missing_folder_is_rejected(client, tmp_path):
    r = client.put("/api/workspaces/active", json={"path": str(tmp_path / "nope")})
    assert r.status_code == 400


def test_active_workspace_survives_restart(sample_workspace, tmp_path):
    home = tmp_path / "home"
    other = tmp_path / "other"
    (other / "pipelines").mkdir(parents=True)
    with make_client(sample_workspace, tmp_path, home) as c:
        c.put("/api/workspaces/active", json={"path": str(other)})
    saved = json.loads((home / "workspaces.json").read_text())
    assert saved["active"] == str(other.resolve())

    with make_client(sample_workspace, tmp_path, home) as c:
        assert c.get("/api/workspaces").json()["active"] == str(other.resolve())
        assert c.get("/api/health").json()["workspace"] == str(other.resolve())


def test_deleted_active_workspace_falls_back_to_default(sample_workspace, tmp_path):
    home = tmp_path / "home"
    gone = tmp_path / "gone"
    gone.mkdir()
    WorkspaceRegistry(sample_workspace, home / "workspaces.json").set_active(gone)
    gone.rmdir()
    with make_client(sample_workspace, tmp_path, home) as c:
        body = c.get("/api/workspaces").json()
    assert body["active"] == str(sample_workspace.resolve())
    assert {w["name"]: w["exists"] for w in body["workspaces"]} == {sample_workspace.name: True, "gone": False}


def test_forget_removes_from_list_but_keeps_files(client, tmp_path, sample_workspace):
    client.post("/api/workspaces", json={"parent": str(tmp_path), "name": "temp"})
    r = client.delete("/api/workspaces", params={"path": str(tmp_path / "temp")})
    assert r.status_code == 200
    assert [w["name"] for w in r.json()["workspaces"]] == [sample_workspace.name]
    assert (tmp_path / "temp" / "pipelines").is_dir()
    # neither the active nor the default workspace can be forgotten
    assert client.delete("/api/workspaces", params={"path": str(sample_workspace)}).status_code == 400


def test_dirs_lists_visible_subfolders(client, tmp_path, sample_workspace):
    (tmp_path / "b").mkdir()
    (tmp_path / "A").mkdir()
    (tmp_path / ".secret").mkdir()
    (tmp_path / "file.txt").write_text("x")
    body = client.get("/api/fs/dirs", params={"path": str(tmp_path)}).json()
    assert body["path"] == str(tmp_path.resolve())
    assert body["parent"] == str(tmp_path.resolve().parent)
    names = [d["name"] for d in body["dirs"]]
    assert "A" in names and "b" in names and ".secret" not in names and "file.txt" not in names
    assert names.index("A") < names.index("b")


def test_dirs_defaults_to_folder_holding_active_workspace(client, sample_workspace):
    body = client.get("/api/fs/dirs").json()
    assert body["path"] == str(sample_workspace.resolve().parent)


def test_dirs_rejects_missing_and_relative_paths(client, tmp_path):
    assert client.get("/api/fs/dirs", params={"path": str(tmp_path / "nope")}).status_code == 404
    assert client.get("/api/fs/dirs", params={"path": "relative"}).status_code == 400


# ------------------------------------------------------ the workspaces folder
def root_client(root: Path, tmp_path: Path, home: Path | None = None) -> TestClient:
    settings = Settings(
        workspaces_root=root, client_dist=tmp_path / "no-client", home=home or tmp_path / "home", scheduler=False
    )
    return TestClient(create_app(settings))


def make_ws(path: Path) -> Path:
    (path / "pipelines").mkdir(parents=True)
    (path / "src").mkdir()
    return path


def test_first_workspace_in_folder_is_default_and_active(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "beta")
    make_ws(root / "Alpha")
    (root / "not-a-workspace").mkdir()  # no pipelines/
    make_ws(root / ".hidden")
    with root_client(root, tmp_path) as c:
        body = c.get("/api/workspaces").json()
        assert body["root"] == str(root.resolve())
        assert body["active"] == str((root / "Alpha").resolve())
        assert [(w["name"], w["active"], w["default"], w["in_root"]) for w in body["workspaces"]] == [
            ("Alpha", True, True, True),
            ("beta", False, False, True),
        ]
        assert c.get("/api/health").json()["workspace"] == str((root / "Alpha").resolve())


def test_empty_folder_gets_a_default_workspace(tmp_path):
    root = tmp_path / "workspaces"
    with root_client(root, tmp_path) as c:
        body = c.get("/api/workspaces").json()
    assert body["active"] == str((root / "default").resolve())
    assert (root / "default" / "pipelines").is_dir() and (root / "default" / "src").is_dir()


def test_workspace_created_in_folder_is_listed_by_name(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    with root_client(root, tmp_path) as c:
        assert c.get("/api/fs/dirs").json()["path"] == str(root.resolve())  # picker starts here
        r = c.post("/api/workspaces", json={"parent": str(root), "name": "aaa"})
        assert r.json()["in_root"] is True
        body = c.get("/api/workspaces").json()
        assert [w["name"] for w in body["workspaces"]] == ["aaa", "main"]  # by name
        # "aaa" is now first, but the active workspace doesn't change by itself
        assert body["active"] == str((root / "main").resolve())
        # in-folder workspaces can't be forgotten: they'd be found again
        c.post("/api/workspaces", json={"parent": str(root), "name": "zzz"})
        r = c.delete("/api/workspaces", params={"path": str(root / "zzz")})
        assert r.status_code == 400 and "workspaces folder" in r.json()["detail"]
    # the active workspace is saved; in-folder workspaces aren't (they're found by name)
    saved = json.loads((tmp_path / "home" / "workspaces.json").read_text())
    assert saved == {"active": str((root / "main").resolve()), "workspaces": []}


def test_active_stays_after_restart_when_a_new_first_workspace_appears(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    with root_client(root, tmp_path) as c:
        c.post("/api/workspaces", json={"parent": str(root), "name": "aaa"})
    with root_client(root, tmp_path) as c:
        body = c.get("/api/workspaces").json()
    assert body["active"] == str((root / "main").resolve())
    assert [w["name"] for w in body["workspaces"]][0] == "aaa"


def test_chosen_workspace_survives_restart_in_folder(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "a")
    make_ws(root / "b")
    with root_client(root, tmp_path) as c:
        c.put("/api/workspaces/active", json={"path": str(root / "b")})
    with root_client(root, tmp_path) as c:
        assert c.get("/api/workspaces").json()["active"] == str((root / "b").resolve())


def test_explicit_default_wins_over_first_in_folder(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "a")
    pinned = make_ws(tmp_path / "pinned")
    settings = Settings(
        workspaces_root=root, workspace=pinned, client_dist=tmp_path / "x", home=tmp_path / "home", scheduler=False
    )
    with TestClient(create_app(settings)) as c:
        body = c.get("/api/workspaces").json()
    assert body["active"] == str(pinned.resolve())
    assert [w["name"] for w in body["workspaces"]] == ["pinned", "a"]


def test_catalog_sits_next_to_the_workspaces_folder(tmp_path):
    settings = Settings(workspaces_root=tmp_path / "workspaces", workspace=tmp_path / "workspaces" / "a")
    assert settings.catalog_dir == tmp_path / "catalog"

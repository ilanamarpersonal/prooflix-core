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
        "branch": None,
        "is_copy": False,
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
        "branch": None,
        "is_copy": False,
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


def test_empty_folder_means_an_empty_list(tmp_path):
    root = tmp_path / "workspaces"
    with root_client(root, tmp_path) as c:
        body = c.get("/api/workspaces").json()
        assert body["active"] is None and body["workspaces"] == []
        assert c.get("/api/pipelines").json() == []  # runs on the empty placeholder
        # the first workspace created becomes active
        c.post("/api/workspaces", json={"parent": str(root), "name": "first"})
        body = c.get("/api/workspaces").json()
        assert body["active"] == str((root / "first").resolve())
        assert c.get("/api/health").json()["workspace"] == str((root / "first").resolve())
    assert not (root / "default").exists()


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
    # the active workspace is saved; in-folder workspaces aren't (they're found by name)
    saved = json.loads((tmp_path / "home" / "workspaces.json").read_text())
    assert saved == {"active": str((root / "main").resolve()), "workspaces": [], "hidden": []}


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


def test_first_in_folder_workspace_can_be_removed_once_another_is_active(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "aaa")
    make_ws(root / "bbb")
    with root_client(root, tmp_path) as c:
        c.put("/api/workspaces/active", json={"path": str(root / "bbb")})
        r = c.delete("/api/workspaces", params={"path": str(root / "aaa")})
        assert r.status_code == 200
        assert [(w["name"], w["active"], w["default"]) for w in r.json()["workspaces"]] == [("bbb", True, True)]


def test_removing_in_folder_workspace_keeps_its_folder_and_stays_removed(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    make_ws(root / "old")
    (root / "old" / "pipelines" / "p.yaml").write_text("name: p\ntasks: []\n")
    with root_client(root, tmp_path) as c:
        r = c.delete("/api/workspaces", params={"path": str(root / "old")})
        assert r.status_code == 200
        assert [w["name"] for w in r.json()["workspaces"]] == ["main"]
        assert (root / "old" / "pipelines" / "p.yaml").is_file()  # nothing moved or deleted
    # still removed after a restart
    with root_client(root, tmp_path) as c:
        assert [w["name"] for w in c.get("/api/workspaces").json()["workspaces"]] == ["main"]
        # opening it again lists it again
        c.put("/api/workspaces/active", json={"path": str(root / "old")})
        assert [w["name"] for w in c.get("/api/workspaces").json()["workspaces"]] == ["main", "old"]


def test_removing_active_workspace_switches_to_another_first(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "aaa")
    make_ws(root / "bbb")
    with root_client(root, tmp_path) as c:
        assert c.get("/api/workspaces").json()["active"] == str((root / "aaa").resolve())
        r = c.delete("/api/workspaces", params={"path": str(root / "aaa")})
        assert r.status_code == 200
        body = r.json()
        assert body["active"] == str((root / "bbb").resolve())
        assert [w["name"] for w in body["workspaces"]] == ["bbb"]
        assert c.get("/api/health").json()["workspace"] == str((root / "bbb").resolve())
        assert (root / "aaa" / "pipelines").is_dir()


def test_removing_the_last_workspace_leaves_the_list_empty(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "only")
    (root / "only" / "pipelines" / "p.yaml").write_text("name: p\ntasks: []\n")
    with root_client(root, tmp_path) as c:
        assert len(c.get("/api/pipelines").json()) == 1
        r = c.delete("/api/workspaces", params={"path": str(root / "only")})
        assert r.status_code == 200
        assert r.json()["active"] is None and r.json()["workspaces"] == []
        assert c.get("/api/pipelines").json() == []
        assert (root / "only" / "pipelines" / "p.yaml").is_file()
    # empty after a restart too, and no workspace was created
    with root_client(root, tmp_path) as c:
        assert c.get("/api/workspaces").json()["workspaces"] == []
    assert sorted(d.name for d in root.iterdir()) == [".no-workspace", "only"]


def _b64(text: str) -> str:
    import base64

    return base64.b64encode(text.encode()).decode()


def test_import_workspace_creates_lists_and_activates_it(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    files = [
        {"path": "pipelines/hello.yaml", "content_base64": _b64("name: Hello\ntasks:\n  - key: a\n    type: shell\n    command: echo hi\n")},
        {"path": "README.md", "content_base64": _b64("# bundle\n")},
    ]
    copies = tmp_path / "home" / "workspaces"  # uploads are copied into PROOFLIX_HOME/workspaces
    with root_client(root, tmp_path) as c:
        r = c.post("/api/workspaces/import", json={"name": "bundle", "files": files})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["written"] == 2 and body["pipelines"] == ["hello"]
        assert body["workspace"]["name"] == "bundle" and body["workspace"]["active"] is True
        assert (copies / "bundle" / "src").is_dir()  # created when missing
        assert [p["id"] for p in c.get("/api/pipelines").json()] == ["hello"]
        # the same name again is refused, and nothing is written
        r = c.post("/api/workspaces/import", json={"name": "bundle", "files": files})
        assert r.status_code == 409
        detail = r.json()["detail"]
        assert detail["exists"] and detail["workspace"] and not detail["removed"]
        assert detail["path"] == str((copies / "bundle").resolve())
        # without activate it is only listed
        r = c.post("/api/workspaces/import", json={"name": "other", "files": files, "activate": False})
        assert r.json()["workspace"]["active"] is False
        assert c.get("/api/workspaces").json()["active"] == str((copies / "bundle").resolve())


@pytest.mark.parametrize(
    "path, name, code",
    [("../evil.txt", "x", 400), (".git/config", "x", 400), ("a.txt", "../x", 400), ("a.txt", ".hidden", 400)],
)
def test_import_workspace_rejects_bad_paths_and_names(tmp_path, path, name, code):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    with root_client(root, tmp_path) as c:
        r = c.post("/api/workspaces/import", json={"name": name, "files": [{"path": path, "content_base64": _b64("x")}]})
        assert r.status_code == code
    assert sorted(d.name for d in root.iterdir()) == ["main"]


def test_import_again_after_removing_updates_the_existing_workspace(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    v1 = [
        {"path": "pipelines/a.yaml", "content_base64": _b64("name: A\ntasks:\n  - key: t\n    type: shell\n    command: echo 1\n")},
        {"path": "notes.txt", "content_base64": _b64("v1")},
    ]
    copies = tmp_path / "home" / "workspaces"
    with root_client(root, tmp_path) as c:
        c.post("/api/workspaces/import", json={"name": "bundle", "files": v1, "activate": False})
        (copies / "bundle" / "local.txt").write_text("kept")
        c.delete("/api/workspaces", params={"path": str(copies / "bundle")})
        # importing it again tells the client it exists and was removed
        r = c.post("/api/workspaces/import", json={"name": "bundle", "files": v1})
        assert r.status_code == 409 and r.json()["detail"]["removed"] is True
        # overwrite updates it, lists it again and makes it active
        v2 = [{"path": "notes.txt", "content_base64": _b64("v2")}]
        r = c.post("/api/workspaces/import", json={"name": "bundle", "files": v2, "overwrite": True})
        assert r.status_code == 201, r.text
        assert r.json()["workspace"]["active"] is True
        assert (copies / "bundle" / "notes.txt").read_text() == "v2"
        assert (copies / "bundle" / "local.txt").read_text() == "kept"  # the rest is kept
        assert (copies / "bundle" / "pipelines" / "a.yaml").is_file()
        # the workspaces folder's own first, then the copies in PROOFLIX_HOME/workspaces
        assert [w["name"] for w in c.get("/api/workspaces").json()["workspaces"]] == ["main", "bundle"]


def test_import_never_overwrites_a_folder_that_is_not_a_workspace(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    copies = tmp_path / "home" / "workspaces"
    (copies / "stuff").mkdir(parents=True)
    (copies / "stuff" / "f.txt").write_text("mine")
    with root_client(root, tmp_path) as c:
        r = c.post(
            "/api/workspaces/import",
            json={"name": "stuff", "files": [{"path": "f.txt", "content_base64": _b64("x")}], "overwrite": True},
        )
        assert r.status_code == 409 and r.json()["detail"]["workspace"] is False
    assert (copies / "stuff" / "f.txt").read_text() == "mine"




def _project(path: Path) -> Path:
    (path / "pipelines").mkdir(parents=True)
    (path / "pipelines" / "hello.yaml").write_text("name: Hello\ntasks:\n  - key: a\n    type: shell\n    command: echo hi\n")
    (path / "src").mkdir()
    return path


def test_import_path_in_place_works_on_the_branch_checked_out(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    repo = _project(tmp_path / "repo")
    (repo / ".git").mkdir()
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/feature/x\n")
    with root_client(root, tmp_path) as c:
        r = c.post("/api/workspaces/import-path", json={"path": str(repo), "mode": "in_place"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["workspace"]["path"] == str(repo.resolve()) and body["workspace"]["branch"] == "feature/x"
        assert body["workspace"]["active"] is True and body["workspace"]["is_copy"] is False
        assert body["pipelines"] == ["hello"] and body["copied_files"] is None
        # it is the folder itself: a change there is what Prooflix sees
        (repo / "pipelines" / "two.yaml").write_text("tasks:\n  - key: a\n    type: shell\n    command: echo 2\n")
        assert sorted(p["id"] for p in c.get("/api/pipelines").json()) == ["hello", "two"]


def test_import_path_copy_goes_to_prooflix_home(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    repo = _project(tmp_path / "repo")
    (repo / ".git").mkdir()
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / "src" / "__pycache__").mkdir()
    (repo / "src" / "__pycache__" / "x.pyc").write_bytes(b"0")
    with root_client(root, tmp_path) as c:
        r = c.post("/api/workspaces/import-path", json={"path": str(repo), "mode": "copy", "name": "my copy"})
        assert r.status_code == 201, r.text
        copy = tmp_path / "home" / "workspaces" / "my copy"
        body = r.json()
        assert body["workspace"]["path"] == str(copy.resolve()) and body["workspace"]["is_copy"] is True
        assert (copy / "pipelines" / "hello.yaml").is_file()
        assert not (copy / ".git").exists() and not (copy / "src" / "__pycache__").exists()
        assert body["workspace"]["branch"] is None  # a copy has no git history
        assert c.post("/api/workspaces/import-path", json={"path": str(repo), "mode": "copy", "name": "my copy"}).status_code == 409
        # the original is untouched by work on the copy
        (copy / "pipelines" / "hello.yaml").write_text("changed")
        assert "Hello" in (repo / "pipelines" / "hello.yaml").read_text()


@pytest.mark.parametrize("where", ["missing", "not_project", "home", "above_home"])
def test_import_path_refusals(tmp_path, where):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    home = tmp_path / "box" / "home"
    home.mkdir(parents=True)
    (home / "users.json").write_text("{}")
    paths = {"missing": tmp_path / "nope", "not_project": tmp_path, "home": _project(home / "evil"),
             "above_home": _project(tmp_path / "box")}
    with root_client(root, tmp_path, home=home) as c:
        r = c.post("/api/workspaces/import-path", json={"path": str(paths[where]), "mode": "in_place"})
        assert r.status_code in (400, 422), r.text


def test_find_a_chosen_folder_on_the_server(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "me")
    a = _project(tmp_path / "me" / "github" / "repo-a" / "proj")
    (a / "src" / "job.py").write_text("x")
    _project(tmp_path / "me" / "old" / "proj")  # same name, fewer of the chosen files
    _project(tmp_path / "me" / ".hidden" / "proj")  # hidden folders aren't searched
    (tmp_path / "me" / "notproj" / "proj").mkdir(parents=True)  # no pipelines/: not a project
    with root_client(root, tmp_path) as c:
        # a folder holding every chosen file ends the search
        found = c.post("/api/workspaces/find", json={"name": "proj", "files": ["src/job.py", "pipelines/hello.yaml"]}).json()
        assert [(Path(f["path"]).parts[-3:], f["matches"]) for f in found] == [(("github", "repo-a", "proj"), 2)]
        # otherwise every candidate, best match first
        found = c.post("/api/workspaces/find", json={"name": "proj", "files": ["src/job.py", "nope.txt"]}).json()
        assert [(Path(f["path"]).parts[-3:], f["matches"]) for f in found] == [
            (("github", "repo-a", "proj"), 1), (("me", "old", "proj"), 0)]

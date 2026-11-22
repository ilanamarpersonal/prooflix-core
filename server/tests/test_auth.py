"""Users, sign-in and tabs per user (PROOFLIX_AUTH)."""

from __future__ import annotations

import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prooflix.auth import UserStore, can_access, hash_password, password_problems, verify_password
from prooflix.config import Settings
from prooflix.main import create_app

GOOD = "Secret123"


@pytest.mark.parametrize(
    ("password", "problems"),
    [
        ("Secret123", []),
        ("Sec1", ["at least 8 characters"]),
        ("secret123", ["a capital letter"]),
        ("SecretPass", ["a number"]),
        ("", ["at least 8 characters", "a capital letter", "a number"]),
    ],
)
def test_password_rules(password, problems):
    assert password_problems(password) == problems


def test_passwords_are_hashed(tmp_path: Path):
    h = hash_password(GOOD)
    assert GOOD not in h and verify_password(GOOD, h) and not verify_password("Secret124", h)
    store = UserStore(tmp_path)
    store.create("dana", GOOD)
    text = (tmp_path / "users.json").read_text()
    assert GOOD not in text and "scrypt$" in text
    assert stat.S_IMODE((tmp_path / "users.json").stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / "session.key").stat().st_mode) == 0o600


def test_sessions_end_when_the_password_changes_or_the_user_is_disabled(tmp_path: Path):
    store = UserStore(tmp_path)
    store.create("admin", GOOD, role="admin")
    dana = store.create("dana", GOOD)
    token = store.issue(dana)
    assert store.user_for(token).username == "dana"
    assert store.user_for(token + "x") is None and store.user_for("junk") is None
    store.update("dana", actor="admin", password="Another123")
    assert store.user_for(token) is None
    token = store.issue(store.get("dana"))
    store.update("dana", actor="admin", disabled=True)
    assert store.user_for(token) is None
    # the key survives a restart, so sessions do too
    store.update("dana", actor="admin", disabled=False)
    token = store.issue(store.get("dana"))
    assert UserStore(tmp_path).user_for(token).username == "dana"


def test_last_admin_is_protected(tmp_path: Path):
    store = UserStore(tmp_path)
    store.create("admin", GOOD, role="admin")
    store.create("dana", GOOD)
    for change in ({"role": "user"}, {"disabled": True}):
        with pytest.raises(ValueError):
            store.update("admin", actor="dana", **change)
    with pytest.raises(ValueError):
        store.delete("admin", actor="dana")
    with pytest.raises(ValueError):
        store.delete("dana", actor="dana")  # not your own account
    with pytest.raises(ValueError, match="already"):
        store.create("Dana", GOOD)  # names are case-insensitive


def test_lockout_after_wrong_passwords(tmp_path: Path):
    store = UserStore(tmp_path)
    store.create("dana", GOOD)
    for _ in range(5):
        with pytest.raises(ValueError, match="Wrong"):
            store.authenticate("dana", "Wrong1234")
    with pytest.raises(ValueError, match="Too many"):
        store.authenticate("dana", GOOD)


def test_tab_access_per_path(tmp_path: Path):
    store = UserStore(tmp_path)
    store.create("admin", GOOD, role="admin")
    viewer = store.create("viewer", GOOD, tabs=["catalog"])
    assert can_access(viewer, "/api/catalog")
    assert can_access(viewer, "/api/sql/query")  # the Catalog runs queries
    assert not can_access(viewer, "/api/pipelines")
    assert not can_access(viewer, "/api/users")
    assert not can_access(viewer, "/api/unknown")
    assert can_access(store.get("admin"), "/api/users")


@pytest.fixture
def client(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog", auth=True)
    with TestClient(create_app(settings)) as c:
        yield c


def test_sign_in_flow_and_tabs(client):
    c = client
    s = c.get("/api/auth/status").json()
    assert s["enabled"] and s["setup_needed"] and s["user"] is None
    assert c.get("/api/pipelines").status_code == 401
    assert c.get("/api/health").status_code == 200  # public

    # first admin: the password rules apply
    assert c.post("/api/auth/setup", json={"username": "boss", "password": "weak"}).status_code == 422
    r = c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
    assert "httponly" in r.headers["set-cookie"].lower()
    assert c.post("/api/auth/setup", json={"username": "x", "password": GOOD}).status_code == 409
    assert c.get("/api/pipelines").status_code == 200

    # an admin adds a user who sees only the Catalog
    r = c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["catalog"]})
    assert r.status_code == 201 and r.json()["visible_tabs"] == ["catalog"]
    assert c.post("/api/users", json={"username": "eve", "password": "nocaps123"}).status_code == 422
    assert c.put("/api/users/boss", json={"role": "user"}).status_code == 422  # the only admin

    c.post("/api/auth/logout")
    assert c.get("/api/pipelines").status_code == 401
    assert c.post("/api/auth/login", json={"username": "dana", "password": "Wrong1234"}).status_code == 401
    r = c.post("/api/auth/login", json={"username": "DANA", "password": GOOD})
    assert r.status_code == 200 and r.json()["user"]["username"] == "dana"
    assert c.get("/api/catalog").status_code == 200
    assert c.get("/api/pipelines").status_code == 403
    assert c.get("/api/users").status_code == 403

    # changing her own password keeps her signed in
    assert c.post("/api/auth/password", json={"current": "nope", "new": "Newpass123"}).status_code == 422
    assert c.post("/api/auth/password", json={"current": GOOD, "new": "Newpass123"}).status_code == 200
    assert c.get("/api/catalog").status_code == 200


def test_auth_off_keeps_everything_open(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    with TestClient(create_app(Settings(workspace=ws, home=tmp_path / "h", scheduler=False,
                                        catalog=tmp_path / "c"))) as c:
        assert c.get("/api/auth/status").json()["enabled"] is False
        assert c.get("/api/pipelines").status_code == 200
        assert c.get("/api/users").status_code == 409


# ------------------------------------------------------------ review fixes
def test_every_api_route_belongs_to_a_tab_admins_or_public(client):
    from prooflix.auth import ADMIN_PATHS, PUBLIC_PATHS, required_tabs

    c = client
    for route in c.app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/"):
            continue
        public = any(path == p or (p.endswith("/") and path.startswith(p)) for p in PUBLIC_PATHS)
        admin = any(path == p or path.startswith(p + "/") for p in ADMIN_PATHS)
        assert public or admin or required_tabs(path), f"{path} is in no tab: add it to TAB_PATHS"


def test_unreadable_users_file_fails_closed(tmp_path: Path):
    store = UserStore(tmp_path)
    store.create("boss", GOOD, role="admin")
    store.create("dana", GOOD)
    (tmp_path / "users.json").write_text("{ not json")
    with pytest.raises(RuntimeError, match="users file"):
        _ = store.setup_needed
    with pytest.raises(RuntimeError):
        store.create_first_admin("evil", GOOD)
    assert (tmp_path / "users.json").read_text() == "{ not json"  # never written over


def test_unreadable_users_file_over_http(client, tmp_path: Path):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    (tmp_path / "home" / "users.json").write_text("garbage")
    assert c.get("/api/auth/status").status_code == 500
    assert c.post("/api/auth/setup", json={"username": "evil", "password": GOOD}).status_code == 500
    assert c.get("/api/pipelines").status_code == 500


def test_first_admin_race_makes_one_admin(tmp_path: Path):
    import threading

    store = UserStore(tmp_path)
    results = []

    def go(name):
        try:
            store.create_first_admin(name, GOOD)
            results.append(name)
        except ValueError:
            pass

    threads = [threading.Thread(target=go, args=(f"admin{i}",)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(results) == 1 and len(store.list()) == 1


def test_sign_in_during_an_admin_change_does_not_undo_it(tmp_path: Path, monkeypatch):
    import threading

    import prooflix.auth as auth

    store = UserStore(tmp_path)
    store.create("boss", GOOD, role="admin")
    store.create("dana", GOOD)
    started, release = threading.Event(), threading.Event()
    real = auth.verify_password

    def slow(password, stored):
        started.set()
        release.wait(5)
        return real(password, stored)

    monkeypatch.setattr(auth, "verify_password", slow)
    errors = []
    t = threading.Thread(target=lambda: errors.append(_try(store.authenticate, "dana", GOOD)))
    t.start()
    started.wait(5)
    store.update("dana", actor="boss", disabled=True)  # while dana's sign-in is in scrypt
    release.set()
    t.join()
    assert store.get("dana").disabled and errors == ["refused"]


def _try(fn, *args):
    try:
        fn(*args)
        return "ok"
    except ValueError:
        return "refused"


def test_unknown_names_cost_a_password_check(tmp_path: Path, monkeypatch):
    import prooflix.auth as auth

    store = UserStore(tmp_path)
    calls = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda p, s: calls.append(1) or real(p, s))
    with pytest.raises(ValueError):
        store.authenticate("nobody", GOOD)
    assert calls == [1]


def test_lockout_answers_429(client):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    c.post("/api/auth/logout")
    for _ in range(5):
        assert c.post("/api/auth/login", json={"username": "boss", "password": "Wrong1234"}).status_code == 401
    r = c.post("/api/auth/login", json={"username": "boss", "password": GOOD})
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


def test_users_routes(client):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["catalog"]})
    assert c.put("/api/users/dana", json={"tabs": ["sql", "catalog"]}).json()["tabs"] == ["sql", "catalog"]
    assert c.put("/api/users/dana", json={"tabs": ["nope"]}).status_code == 422
    assert c.put("/api/users/ghost", json={"tabs": []}).status_code == 404
    assert c.delete("/api/users/boss").status_code == 422  # yourself / the last admin
    assert c.delete("/api/users/ghost").status_code == 404
    # an admin's own new password keeps this session
    assert c.put("/api/users/boss", json={"password": "Newpass123"}).status_code == 200
    assert c.get("/api/users").status_code == 200
    # disabling dana ends her session
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "dana", "password": GOOD})
    assert c.get("/api/catalog").status_code == 200
    dana_cookie = c.cookies.get("prooflix_session")
    c.cookies.clear()
    c.post("/api/auth/login", json={"username": "boss", "password": "Newpass123"})
    assert c.put("/api/users/dana", json={"disabled": True}).status_code == 200
    c.cookies.clear()  # else boss's cookie (set for the test host) is the one sent
    c.cookies.set("prooflix_session", dana_cookie)
    assert c.get("/api/catalog").status_code == 401
    assert c.delete("/api/users/dana").status_code in (401, 204)


def test_sign_in_switch_is_not_editable(client):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    assert c.put("/api/system/parameters/PROOFLIX_AUTH", json={"value": "0"}).status_code >= 400


def test_ingestion_users_cant_edit_pipelines_and_shell_is_admin_only(client):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    c.post("/api/users", json={"username": "ing", "password": GOOD, "tabs": ["ingestion"]})
    c.post("/api/users", json={"username": "pip", "password": GOOD, "tabs": ["pipelines"]})
    shell = "tasks:\n- key: x\n  type: shell\n  command: echo hi\n"
    assert c.put("/api/pipelines/admin_shell", json={"source": shell}).status_code == 201  # admin may
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "ing", "password": GOOD})
    assert c.get("/api/pipelines").status_code == 403
    assert c.put("/api/pipelines/x", json={"source": shell}).status_code == 403
    assert c.get("/api/runs").status_code == 200
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "pip", "password": GOOD})
    assert c.put("/api/pipelines/x", json={"source": shell}).status_code == 403
    ok = "tasks:\n- key: x\n  type: pipeline\n  pipeline: admin_shell\n"
    assert c.put("/api/pipelines/caller", json={"source": ok}).status_code == 201


def test_entrypoints_must_be_workspace_code(tmp_path: Path):
    from prooflix.engine.runners import load_callable

    src = tmp_path / "src"
    src.mkdir()
    (src / "jobs_x.py").write_text("from os import system\n\ndef run():\n    return 1\n")
    assert load_callable(src, "jobs_x:run")() == 1
    for bad in ("os:system", "subprocess:getoutput", "builtins:eval", "jobs_x:system"):
        with pytest.raises(AttributeError):
            load_callable(src, bad)


def test_linked_folders_never_reach_the_private_folder(tmp_path: Path):
    from prooflix import linked_folders
    from prooflix.linked_folders import FolderError

    home, ws = tmp_path / "home", tmp_path / "ws"
    home.mkdir()
    (ws / "pipelines").mkdir(parents=True)
    for target in (home, home.parent, tmp_path.parent):  # it, or a folder holding it
        with pytest.raises(FolderError, match="private"):
            linked_folders.link(ws, "source_data", target, protected=home)
    # an older link to it is removed at start
    (ws / "source").symlink_to(home, target_is_directory=True)
    linked_folders.apply(ws, {"source_data": home, "data_lake": None}, protected=home)
    assert not (ws / "source").is_symlink()


def test_workspace_routes_never_reach_the_private_folder(client, tmp_path: Path):
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    home = tmp_path / "home"
    assert c.put("/api/workspace/folders/source-data", json={"path": str(home)}).status_code == 400
    ws = tmp_path / "ws"
    (ws / "data").symlink_to(home, target_is_directory=True)  # planted by hand
    assert c.get("/api/workspace/file", params={"path": "data/session.key"}).status_code in (400, 404)
    r = c.post("/api/workspace/import", json={"files": [{"path": "data/users.json", "content_base64": "e30="}],
                                              "overwrite": True})
    assert r.status_code == 400


def test_refused_entrypoints_leave_server_modules_alone(tmp_path: Path):
    import sys

    import prooflix.auth
    from prooflix.engine.runners import load_callable

    src = tmp_path / "src"
    src.mkdir()
    before = (sys.modules["json"], sys.modules["prooflix.auth"])
    for bad in ("json:dumps", "prooflix.auth:x", "asyncio:run"):
        with pytest.raises(AttributeError):
            load_callable(src, bad)
    assert (sys.modules["json"], sys.modules["prooflix.auth"]) == before
    assert sys.modules["prooflix.auth"] is prooflix.auth


def test_shell_references_are_never_code(tmp_path: Path):
    from prooflix.pipelines.templating import resolve_shell

    cmd, env = resolve_shell('echo "Hello, ${params.who}!"', {"params": {"who": '"; touch PWNED; "'}})
    assert "touch" not in cmd and env["PROOFLIX_REF_1"] == '"; touch PWNED; "'
    import subprocess

    out = subprocess.run(cmd, shell=True, cwd=tmp_path, env={**env, "PATH": "/usr/bin:/bin"},
                         capture_output=True, text=True)
    assert not (tmp_path / "PWNED").exists() and "touch PWNED" in out.stdout


def test_connection_addresses_carry_no_options(tmp_path: Path):
    from prooflix.connections import Connection, ConnectionStore

    store = ConnectionStore(tmp_path)
    for host, db in (("evil", "db?allowLoadLocalInfile=true"), ("h;x", "d"), ("h", "d;encrypt=false")):
        with pytest.raises(ValueError):
            store.save(Connection("x", "mysql", host, 3306, db, "u"))


def test_unreadable_connections_file_fails_closed(tmp_path: Path):
    from prooflix.connections import Connection, ConnectionsFileError, ConnectionStore

    store = ConnectionStore(tmp_path)
    store.save(Connection("a", "mysql", "db", 3306, "bank", "u", "pw"))
    (tmp_path / "connections.json").write_text("{ broken")
    with pytest.raises(ConnectionsFileError):
        store.list()
    with pytest.raises(ConnectionsFileError):
        store.save(Connection("b", "mysql", "db", 3306, "bank", "u", "pw"))
    assert (tmp_path / "connections.json").read_text() == "{ broken"


def test_short_session_key_refuses_to_start(tmp_path: Path):
    (tmp_path / "session.key").write_text("")
    with pytest.raises(RuntimeError, match="32-byte"):
        UserStore(tmp_path)


def test_only_admins_delete_a_schemas_data(client, tmp_path: Path):
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = tmp_path / "ws" / "data" / "tenant1" / "bronze" / "orders"
    table.mkdir(parents=True)
    pq.write_table(pa.table({"id": [1]}), table / "part-0.parquet")
    c = client
    c.post("/api/auth/setup", json={"username": "boss", "password": GOOD})
    c.post("/api/users", json={"username": "dana", "password": GOOD, "tabs": ["catalog"]})
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "dana", "password": GOOD})
    r = c.delete("/api/catalog/schemas/tenant1.bronze", params={"mode": "delete"})
    assert r.status_code == 403 and (table / "part-0.parquet").is_file()
    r = c.delete("/api/catalog/catalogs/tenant1", params={"mode": "delete"})
    assert r.status_code == 403 and (table / "part-0.parquet").is_file()
    assert c.delete("/api/catalog/schemas/tenant1.bronze", params={"mode": "hide"}).status_code == 200
    assert c.delete("/api/catalog/hidden/tenant1.bronze").status_code == 204
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "boss", "password": GOOD})
    assert c.delete("/api/catalog/schemas/tenant1.bronze", params={"mode": "delete"}).status_code == 200
    assert not table.exists()

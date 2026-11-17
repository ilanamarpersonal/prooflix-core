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

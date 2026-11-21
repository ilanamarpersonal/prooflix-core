"""Users, passwords, sign-in sessions and which tabs each user may open.

With ``PROOFLIX_AUTH`` on (the default for the server), every ``/api`` route needs a
signed-in user. Users are kept in ``PROOFLIX_HOME/users.json`` (readable by the
server's user only) with their password as a salted scrypt hash, never in clear.

- **Roles.** An ``admin`` sees every tab plus the Users tab, where users are added,
  edited and removed. A ``user`` sees only the tabs chosen for them.
- **Passwords** have at least 8 characters, a capital letter and a digit
  (``password_problems``).
- **First start.** With no users yet, the login page offers to create the first
  admin; there is no built-in account or default password.
- **Sessions** are a signed cookie (HMAC-SHA256 with a key kept in
  ``PROOFLIX_HOME/session.key``) holding the user name, an expiry and a stamp of
  the password hash, so changing a password or disabling a user ends their sessions.
- **Tabs are enforced by the server too**: each API path belongs to the tabs that
  use it (``TAB_PATHS``), so hiding a tab is not only cosmetic.
- **Too many wrong passwords** (5) lock the name for a minute.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

USERS_FILE = "users.json"
KEY_FILE = "session.key"
COOKIE = "prooflix_session"
SESSION_SECONDS = 12 * 3600
USERNAME_PATTERN = r"^[a-z0-9][a-z0-9._-]{2,31}$"
ROLES = ("admin", "user")

# The tabs of the web client (client/src/lib/tabs.ts) a user can be given.
TABS = ("pipelines", "ingestion", "sql", "catalog", "semantic", "workspace", "clickhouse", "alerts", "system")
# Tabs only admins see: Users, and AI Assist (the Claude account settings).
ADMIN_TABS = ("users", "ai-assist")

# API path prefix -> the tabs that use it (any one of them gives access). Longest prefix wins.
TAB_PATHS: dict[str, tuple[str, ...]] = {
    "/api/pipelines": ("pipelines",),  # Ingestion runs its jobs through /api/ingestion
    "/api/runs": ("pipelines", "ingestion"),
    "/api/schedules": ("pipelines", "ingestion"),
    "/api/ingestion": ("ingestion",),
    "/api/sql": ("sql", "catalog"),  # the Catalog runs queries for its previews
    "/api/catalog": ("catalog", "sql"),
    "/api/workspace": ("workspace",),
    "/api/workspaces": ("workspace",),
    "/api/fs": ("workspace", "system"),  # the folder picker
    "/api/clickhouse": ("clickhouse",),
    "/api/alerts": ("alerts",),
    "/api/semantic": ("semantic",),
    "/api/system": ("system",),
    "/api/ai-assist/status": TABS,  # whether AI Assist can answer: any signed-in user
    "/api/ai-assist/sql": ("sql",),  # ask AI Assist about a failed query
    "/api/ai-assist/runs": ("pipelines", "ingestion"),  # ask AI Assist about a failed run
}
PUBLIC_PATHS = ("/api/health", "/api/auth/")
ADMIN_PATHS = ("/api/users", "/api/ai-assist/settings")  # AI Assist's Claude account: admins only

MAX_FAILURES = 5
LOCK_SECONDS = 60


MAX_PASSWORD = 1024  # scrypt on megabytes of input would be a cheap denial of service


class AuthError(ValueError):
    """A refused request; the message says why."""


class SetupDone(AuthError):
    """The first admin exists already."""


class LockedOut(AuthError):
    """Too many wrong passwords for this name; ``retry_after`` seconds to wait."""

    def __init__(self, retry_after: int):
        super().__init__(f"Too many wrong passwords; try again in {retry_after} seconds")
        self.retry_after = retry_after


USERS_FILE_BROKEN = "The users file can't be read; an operator must fix or restore it (see the server log)"
log = logging.getLogger(__name__)


class UsersFileError(RuntimeError):
    """users.json exists but can't be read: refuse everything rather than treat it as empty."""


def password_problems(password: str) -> list[str]:
    """What the password lacks: [] when it is acceptable."""
    problems = []
    if len(password) > MAX_PASSWORD:
        return [f"at most {MAX_PASSWORD} characters"]
    if len(password) < 8:
        problems.append("at least 8 characters")
    if not re.search(r"[A-Z]", password):
        problems.append("a capital letter")
    if not re.search(r"\d", password):
        problems.append("a number")
    return problems


def check_password_policy(password: str) -> None:
    problems = password_problems(password)
    if problems:
        raise AuthError("The password needs " + ", ".join(problems))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    n, r, p = 2**14, 8, 1
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if len(password) > MAX_PASSWORD:
        return False
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(bytes.fromhex(digest)))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class User:
    username: str
    password: str  # the scrypt hash
    role: str = "user"
    tabs: list[str] = field(default_factory=list)
    disabled: bool = False
    created_at: str = field(default_factory=_now)
    last_login: str | None = None

    @property
    def visible_tabs(self) -> list[str]:
        return [*TABS, *ADMIN_TABS] if self.role == "admin" else [t for t in TABS if t in self.tabs]

    @property
    def stamp(self) -> str:
        """Changes when the password changes, so older sessions stop working."""
        return hashlib.sha256(self.password.encode()).hexdigest()[:16]

    def public(self) -> dict:
        d = asdict(self)
        d.pop("password")
        d["visible_tabs"] = self.visible_tabs
        return d


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    os.chmod(tmp, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


class UserStore:
    """The users in ``<home>/users.json`` (in memory when home is None), and sessions."""

    def __init__(self, home: Path | None):
        self.file = home / USERS_FILE if home is not None else None
        self.key_file = home / KEY_FILE if home is not None else None
        self._memory: dict[str, dict] = {}
        # one lock for every read-modify-write of users.json and for the failure counts
        self._lock = threading.RLock()
        self._failures: dict[str, tuple[int, float]] = {}
        self._cache: tuple[tuple[int, int], dict[str, dict]] | None = None  # ((mtime_ns, size), users)
        self._dummy = hash_password(secrets.token_urlsafe(16))  # same work for unknown names
        self._key = self._load_key()

    # ------------------------------------------------------------ storage
    def _load_key(self) -> bytes:
        if self.key_file is not None and self.key_file.exists():
            try:
                key = bytes.fromhex(self.key_file.read_text().strip())
            except (OSError, ValueError):
                key = b""
            if len(key) != 32:  # fail closed: never sign sessions with an empty or short key
                raise UsersFileError(f"{self.key_file} is not a 32-byte key; restore it or delete it to start over")
            return key
        key = secrets.token_bytes(32)
        if self.key_file is not None:
            _write_private(self.key_file, key.hex())
        return key

    def _read(self) -> dict[str, dict]:
        """The users; {} only when there is no file. A file that exists but can't be read or
        parsed raises UsersFileError (fail closed: never reopen first-admin setup, never
        write over it). Parsed once per change of the file, not on every request."""
        if self.file is None:
            return dict(self._memory)
        try:
            st = self.file.stat()
        except FileNotFoundError:
            return {}
        except OSError as e:
            log.error("%s can't be read: %s", self.file, e)
            raise UsersFileError(USERS_FILE_BROKEN) from None
        stamp = (st.st_mtime_ns, st.st_size)
        if self._cache is not None and self._cache[0] == stamp:
            return dict(self._cache[1])
        try:
            data = json.loads(self.file.read_text())
            users = data["users"]
            if not isinstance(users, dict) or not all(isinstance(v, dict) for v in users.values()):
                raise ValueError("'users' is not a map of users")
        except (OSError, ValueError, KeyError, TypeError) as e:
            log.error("%s can't be read: %s", self.file, e)  # details for the operator, not for callers
            raise UsersFileError(USERS_FILE_BROKEN) from None
        self._cache = (stamp, users)
        return dict(users)

    def _write(self, users: dict[str, dict]) -> None:
        if self.file is None:
            self._memory = dict(users)
        else:
            _write_private(self.file, json.dumps({"users": dict(sorted(users.items()))}, indent=2))
            self._cache = None

    def list(self) -> list[User]:
        out = []
        for name, values in sorted(self._read().items()):
            try:
                out.append(User(username=name, **{k: v for k, v in values.items() if k != "username"}))
            except TypeError:
                continue
        return out

    def get(self, username: str) -> User | None:
        return next((u for u in self.list() if u.username == username.strip().lower()), None)

    def _save(self, user: User) -> User:
        with self._lock:
            users = self._read()  # raises rather than return {} for a bad file: nothing is lost
            values = asdict(user)
            values.pop("username")
            users[user.username] = values
            self._write(users)
            return user

    @property
    def setup_needed(self) -> bool:
        return not self._read()

    def _admins(self) -> list[User]:
        return [u for u in self.list() if u.role == "admin" and not u.disabled]

    # ------------------------------------------------------------ changes
    def create_first_admin(self, username: str, password: str) -> User:
        """The first admin, only while there are no users (checked under the lock, so two
        requests at once can't both create one)."""
        with self._lock:
            if not self.setup_needed:
                raise SetupDone("The first admin exists already; sign in")
            return self.create(username, password, role="admin")

    def create(self, username: str, password: str, role: str = "user", tabs: list[str] | None = None) -> User:
        username = username.strip().lower()
        if not re.match(USERNAME_PATTERN, username):
            raise AuthError("User name: 3 to 32 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit")
        if role not in ROLES:
            raise AuthError(f"Role: one of {', '.join(ROLES)}")
        check_password_policy(password)
        with self._lock:
            if self.get(username) is not None:
                raise AuthError(f"There is already a user named {username}")
            return self._save(User(username, hash_password(password), role, _tabs(tabs)))

    def update(self, username: str, *, actor: str, role: str | None = None, tabs: list[str] | None = None,
               password: str | None = None, disabled: bool | None = None) -> User:
        with self._lock:
            user = self.get(username)
            if user is None:
                raise KeyError(username)
            if role is not None:
                if role not in ROLES:
                    raise AuthError(f"Role: one of {', '.join(ROLES)}")
                if user.role == "admin" and role != "admin" and len(self._admins()) <= 1:
                    raise AuthError("This is the only admin; make another user an admin first")
                if user.username == actor and role != "admin":
                    raise AuthError("You can't take away your own admin role")
                user.role = role
            if tabs is not None:
                user.tabs = _tabs(tabs)
            if disabled is not None:
                if disabled and user.username == actor:
                    raise AuthError("You can't disable your own account")
                if disabled and user.role == "admin" and len(self._admins()) <= 1:
                    raise AuthError("This is the only admin; it can't be disabled")
                user.disabled = disabled
            if password:
                check_password_policy(password)
                user.password = hash_password(password)
            return self._save(user)

    def delete(self, username: str, *, actor: str) -> None:
        with self._lock:
            user = self.get(username)
            if user is None:
                raise KeyError(username)
            if user.username == actor:
                raise AuthError("You can't delete your own account")
            if user.role == "admin" and len(self._admins()) <= 1:
                raise AuthError("This is the only admin; it can't be deleted")
            users = self._read()
            users.pop(user.username, None)
            self._write(users)

    def change_own_password(self, username: str, current: str, new: str) -> User:
        user = self.get(username)
        if user is None or not verify_password(current, user.password):
            raise AuthError("The current password is wrong")
        if current == new:
            raise AuthError("The new password must be different")
        return self.update(username, actor=username, password=new)

    # ------------------------------------------------------------ sign-in
    def authenticate(self, username: str, password: str) -> User:
        name = username.strip().lower()[:64]
        with self._lock:
            count, until = self._failures.get(name, (0, 0.0))
            if until > time.time():
                raise LockedOut(int(until - time.time()) + 1)
        user = self.get(name)
        # scrypt runs outside the lock, and for unknown names too, so timing doesn't tell them apart
        ok = verify_password(password, user.password if user is not None else self._dummy) and user is not None
        with self._lock:
            if not ok or user.disabled:
                count = self._failures.get(name, (0, 0.0))[0] + 1
                self._failures[name] = (count, time.time() + LOCK_SECONDS if count >= MAX_FAILURES else 0.0)
                if len(self._failures) > 10_000:  # bound the memory any caller can make it use
                    now = time.time()
                    self._failures = {k: v for k, v in self._failures.items() if v[1] > now}
                if ok and user.disabled:
                    raise AuthError("This account is disabled")
                raise AuthError("Wrong user name or password")
            self._failures.pop(name, None)
            # re-read: an admin may have changed the user during scrypt; never write back an old copy
            fresh = self.get(name)
            if fresh is None or fresh.disabled or fresh.password != user.password:
                raise AuthError("Wrong user name or password")
            fresh.last_login = _now()
            return self._save(fresh)

    def issue(self, user: User) -> str:
        payload = {"u": user.username, "exp": int(time.time()) + SESSION_SECONDS, "s": user.stamp}
        body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
        return f"{body}.{self._sign(body)}"

    def _sign(self, body: str) -> str:
        return hmac.new(self._key, body.encode(), hashlib.sha256).hexdigest()

    def user_for(self, token: str | None) -> User | None:
        """The signed-in user of a session cookie, or None (bad, expired, password changed, disabled)."""
        if not token or "." not in token:
            return None
        body, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(sig, self._sign(body)):
            return None
        try:
            payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        except ValueError:
            return None
        if payload.get("exp", 0) < time.time():
            return None
        user = self.get(payload.get("u", ""))
        if user is None or user.disabled or payload.get("s") != user.stamp:
            return None
        return user


def _tabs(tabs: list[str] | None) -> list[str]:
    unknown = [t for t in tabs or [] if t not in TABS]
    if unknown:
        raise AuthError(f"Unknown tab {', '.join(unknown)}; tabs are {', '.join(TABS)}")
    return [t for t in TABS if t in (tabs or [])]


def required_tabs(path: str) -> tuple[str, ...] | None:
    """The tabs one of which opens this API path; None when no tab owns it (admins only)."""
    best = max((p for p in TAB_PATHS if path == p or path.startswith(p + "/")), key=len, default=None)
    return TAB_PATHS[best] if best else None


def can_access(user: User, path: str) -> bool:
    if user.role == "admin":
        return True
    if any(path == p or path.startswith(p + "/") for p in ADMIN_PATHS):
        return False
    tabs = required_tabs(path)
    return tabs is not None and any(t in user.tabs for t in tabs)

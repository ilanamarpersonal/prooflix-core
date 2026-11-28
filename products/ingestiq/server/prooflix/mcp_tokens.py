"""Personal tokens for the MCP server: how an AI app outside Prooflix (Claude Code, Claude Desktop)
signs in as a user.

A user creates a token in InsightIQ (Objects → Connect an AI app). It is shown once; only its
SHA-256 is kept, in ``PROOFLIX_HOME/mcp_tokens.json`` (mode 600, like the users file). A token
acts as its user with that user's current role, tabs and access: a disabled or deleted user's
tokens stop working, and so does an expired or revoked token. At most ``MAX_PER_USER`` per user.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .auth import _write_private

PREFIX = "pfx_"
MAX_PER_USER = 10
DAYS = (7, 30, 90, 365)
MAX_NAME = 80
TOUCH_SECONDS = 60  # last use is written at most once a minute per token


class TokenError(ValueError):
    """A token request that can't be done (too many, a bad name or expiry)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TokenStore:
    def __init__(self, home: Path | None):
        self.path = (home / "mcp_tokens.json") if home else None
        self._lock = threading.Lock()
        self._memory: list[dict] = []  # no home (tests without one)

    def _read(self) -> list[dict]:
        if self.path is None:
            return [dict(t) for t in self._memory]
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError) as e:  # fail closed: an unreadable file signs nobody in
            raise TokenError(f"{self.path} can't be read: {e}") from None
        return list(data.get("tokens", []))

    def _write(self, tokens: list[dict]) -> None:
        if self.path is None:
            self._memory = [dict(t) for t in tokens]
            return
        _write_private(self.path, json.dumps({"tokens": tokens}, indent=2))

    @staticmethod
    def public(t: dict) -> dict:
        return {k: t.get(k) for k in ("id", "username", "name", "hint", "created", "expires", "last_used")}

    def list(self, username: str | None) -> list[dict]:
        """One user's tokens (every token for None: an admin's view), newest first; never the secret."""
        with self._lock:
            tokens = self._read()
        mine = [t for t in tokens if username is None or t["username"] == username]
        return [self.public(t) for t in sorted(mine, key=lambda t: t["created"], reverse=True)]

    def create(self, username: str, name: str, days: int) -> tuple[str, dict]:
        """A new token for the user: (the token, shown once; its public record)."""
        name = " ".join(name.split())
        if not name or len(name) > MAX_NAME:
            raise TokenError(f"Give the token a name (at most {MAX_NAME} characters), e.g. the app it's for")
        if days not in DAYS:
            raise TokenError(f"A token lasts {', '.join(map(str, DAYS))} days")
        token = PREFIX + secrets.token_urlsafe(32)
        now = _now()
        record = {"id": uuid.uuid4().hex, "username": username, "name": name, "hash": _hash(token),
                  "hint": token[-4:], "created": _iso(now), "expires": _iso(now + timedelta(days=days)),
                  "last_used": None}
        with self._lock:
            tokens = [t for t in self._read() if t["expires"] > _iso(now)]  # expired ones are dropped
            if sum(t["username"] == username for t in tokens) >= MAX_PER_USER:
                raise TokenError(f"You have {MAX_PER_USER} tokens: revoke one first")
            tokens.append(record)
            self._write(tokens)
        return token, self.public(record)

    def revoke(self, token_id: str, username: str | None) -> bool:
        """Delete a token: the user's own, or any for None (an admin). False when there's no such token."""
        with self._lock:
            tokens = self._read()
            keep = [t for t in tokens if not (t["id"] == token_id and (username is None or t["username"] == username))]
            if len(keep) == len(tokens):
                return False
            self._write(keep)
        return True

    def revoke_user(self, username: str) -> None:
        with self._lock:
            tokens = self._read()
            keep = [t for t in tokens if t["username"] != username]
            if len(keep) != len(tokens):
                self._write(keep)

    def check(self, token: str | None) -> dict | None:
        """The record of a valid, unexpired token (and its last use noted), or None."""
        if not token or not token.startswith(PREFIX) or len(token) > 200:
            return None
        digest = _hash(token)
        now = _now()
        with self._lock:
            tokens = self._read()
            found = next((t for t in tokens if hmac.compare_digest(t["hash"], digest)), None)
            if found is None or found["expires"] <= _iso(now):
                return None
            last = found.get("last_used")
            if last is None or (now - datetime.fromisoformat(last)).total_seconds() > TOUCH_SECONDS:
                found["last_used"] = _iso(now)
                self._write(tokens)
        return dict(found)

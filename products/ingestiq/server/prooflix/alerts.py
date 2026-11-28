"""Alerts: a task log line that matches a rule's message format notifies channels.

The Alerts tab defines:

- **Channels**, where alerts go: ``email`` (an SMTP server and recipients),
  ``slack`` (an incoming webhook), ``teams`` (a Microsoft Teams workflow webhook)
  and ``webhook`` (any HTTP endpoint, which gets the alert as JSON). Their URLs and
  passwords are secrets: kept in ``PROOFLIX_HOME/alerts.json`` (mode 600) and
  returned masked.
- **Rules**: a log message format such as ``ALERT {severity}: {message}`` (``{name}``
  matches any text and becomes a field of the alert) or a regular expression,
  the pipelines it watches (none chosen: all), and the channels it notifies (none
  chosen: every channel, including ones added later). A cooldown stops a rule from
  notifying more than once per pipeline in that time; matches in between are counted.

Every task log line (``TaskRun.log``) is checked against the enabled rules as it
is written, including the executor's own ``ERROR ...`` lines for failed tasks.
Sending happens on background threads, so a slow mail server never slows a run,
and the outcome per channel is kept in ``PROOFLIX_HOME/alerts-history.json``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import smtplib
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

log = logging.getLogger(__name__)

ALERTS_FILE = "alerts.json"
HISTORY_FILE = "alerts-history.json"
HISTORY_SIZE = 200
MASK = "********"
TIMEOUT = 10  # seconds per delivery
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
FIELD_PATTERN = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
MAX_PATTERN = 500
SEVERITIES = ("info", "warning", "critical")

# kind -> (label, fields: key, label, secret, required)
CHANNEL_KINDS: dict[str, tuple[str, list[tuple[str, str, bool, bool]]]] = {
    "email": ("Email", [
        ("smtp_host", "SMTP server", False, True),
        ("smtp_port", "Port", False, True),
        ("security", "Security (starttls, ssl or none)", False, True),
        ("username", "User name", False, False),
        ("password", "Password", True, False),
        ("sender", "From address", False, True),
        ("recipients", "To (comma-separated)", False, True),
    ]),
    "slack": ("Slack", [("url", "Incoming webhook URL", True, True)]),
    "teams": ("Microsoft Teams", [("url", "Workflow webhook URL", True, True)]),
    "webhook": ("Webhook", [
        ("url", "URL", True, True),
        ("authorization", "Authorization header (optional)", True, False),
    ]),
}


class AlertsFileError(RuntimeError):
    """alerts.json exists but can't be read: refuse rather than treat it as empty."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------ message formats
@lru_cache(maxsize=256)
def compile_rule(mode: str, pattern: str) -> re.Pattern:
    """The regex for a rule. ``format``: literal text with ``{name}`` fields that match
    any text; ``regex``: a regular expression (named groups become fields)."""
    if not pattern or len(pattern) > MAX_PATTERN:
        raise ValueError(f"The message format needs 1 to {MAX_PATTERN} characters")
    if mode == "regex":
        try:
            return re.compile(pattern)
        except re.error as e:
            raise ValueError(f"Not a valid regular expression: {e}") from None
    if mode != "format":
        raise ValueError("mode: format or regex")
    parts, names, pos = [], set(), 0
    matches = list(FIELD_PATTERN.finditer(pattern))
    for i, m in enumerate(matches):
        name = m.group(1)
        if name in names:
            raise ValueError(f"The field {{{name}}} appears twice")
        names.add(name)
        parts.append(re.escape(pattern[pos:m.start()]))
        last = i == len(matches) - 1 and m.end() == len(pattern)
        parts.append(f"(?P<{name}>.+)" if last else f"(?P<{name}>.+?)")
        pos = m.end()
    parts.append(re.escape(pattern[pos:]))
    return re.compile("".join(parts))


def match(rule: dict, line: str) -> dict | None:
    """The fields of a match ({} when the format has none), or None."""
    m = compile_rule(rule["mode"], rule["pattern"]).search(line)
    if m is None:
        return None
    return {k: (v or "").strip() for k, v in m.groupdict().items()}


# ------------------------------------------------------------ store
def _write_private(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    os.chmod(tmp, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def check_channel(kind: str, config: dict) -> dict:
    """Validate and normalise a channel's settings. Raises ValueError."""
    if kind not in CHANNEL_KINDS:
        raise ValueError(f"kind: one of {', '.join(CHANNEL_KINDS)}")
    fields = CHANNEL_KINDS[kind][1]
    out = {}
    for key, label, _secret, required in fields:
        value = str(config.get(key, "") or "").strip()
        if required and not value:
            raise ValueError(f"{label} is required")
        out[key] = value
    if kind == "slack" and out["url"] != MASK and not out["url"].startswith("https://hooks.slack.com/"):
        raise ValueError("A Slack incoming webhook URL starts with https://hooks.slack.com/")
    if kind == "teams" and out["url"] != MASK and not out["url"].startswith("https://"):
        raise ValueError("A Teams workflow URL starts with https://")
    if kind == "webhook" and out["url"] != MASK and not re.match(r"^https?://[^\s/]+", out["url"]):
        raise ValueError("The URL must start with http:// or https://")
    if kind == "email":
        if out["security"] not in ("starttls", "ssl", "none"):
            raise ValueError("Security: starttls, ssl or none")
        if not out["smtp_port"].isdigit() or not 0 < int(out["smtp_port"]) < 65536:
            raise ValueError("Port: 1 to 65535")
        recipients = [r.strip() for r in out["recipients"].split(",") if r.strip()]
        if not recipients or not all(re.match(r"^[^@\s,]+@[^@\s,]+$", r) for r in [*recipients, out["sender"]]):
            raise ValueError("From and To need valid email addresses")
        out["recipients"] = ", ".join(recipients)
    return out


def check_rule(rule: dict, channel_ids: set[str]) -> dict:
    out = {
        "name": str(rule.get("name") or "").strip(),
        "enabled": bool(rule.get("enabled", True)),
        "mode": rule.get("mode", "format"),
        "pattern": str(rule.get("pattern") or ""),
        "severity": rule.get("severity", "warning"),
        "pipelines": [str(p) for p in rule.get("pipelines") or []],
        "channels": [str(c) for c in rule.get("channels") or []],
        "cooldown_seconds": int(rule.get("cooldown_seconds", 300)),
    }
    if not out["name"]:
        raise ValueError("name is required")
    if out["severity"] not in SEVERITIES:
        raise ValueError(f"severity: one of {', '.join(SEVERITIES)}")
    if not 0 <= out["cooldown_seconds"] <= 86400:
        raise ValueError("cooldown: 0 to 86400 seconds")
    unknown = [c for c in out["channels"] if c not in channel_ids]
    if unknown:
        raise ValueError(f"Unknown channel {', '.join(unknown)}")
    compile_rule(out["mode"], out["pattern"])
    return out


class AlertStore:
    """Channels and rules in ``<home>/alerts.json`` (in memory when home is None)."""

    def __init__(self, home: Path | None):
        self.file = home / ALERTS_FILE if home is not None else None
        self.history_file = home / HISTORY_FILE if home is not None else None
        self._memory: dict = {"channels": {}, "rules": {}}
        self._history: list[dict] = []
        self._lock = threading.RLock()
        self._cache: tuple[float, dict] | None = None  # (when read, data) for snapshot()

    def _read(self) -> dict:
        """A fresh copy, for changes (callers may modify it)."""
        if self.file is None:
            return json.loads(json.dumps(self._memory))
        try:
            data = json.loads(self.file.read_text())
        except FileNotFoundError:
            return {"channels": {}, "rules": {}}
        except (OSError, ValueError) as e:
            log.error("%s can't be read: %s", self.file, e)
            raise AlertsFileError("The alerts file can't be read; fix or restore it (see the server log)") from None
        if not isinstance(data, dict) or not isinstance(data.get("channels"), dict) or not isinstance(data.get("rules"), dict):
            raise AlertsFileError("The alerts file isn't valid; fix or restore it (see the server log)")
        return data

    def _write(self, data: dict) -> None:
        if self.file is None:
            self._memory = json.loads(json.dumps(data))
        else:
            _write_private(self.file, data)
        self._cache = None

    def snapshot(self) -> dict:
        """Channels and rules for reading only (not to be modified). Checked against the
        file at most once a second, since every task log line asks for it."""
        with self._lock:
            if self._cache is None or time.monotonic() - self._cache[0] > 1.0:
                self._cache = (time.monotonic(), self._read())
            return self._cache[1]

    # channels
    def save_channel(self, cid: str, kind: str, name: str, config: dict) -> dict:
        if not ID_PATTERN.match(cid):
            raise ValueError("id: lowercase letters, digits, _ and -, starting with a letter")
        cfg = check_channel(kind, config)
        with self._lock:
            data = self._read()
            old = data["channels"].get(cid, {})
            for key, _label, secret, _req in CHANNEL_KINDS[kind][1]:
                if secret and cfg.get(key) == MASK:  # keep the saved secret
                    cfg[key] = old.get("config", {}).get(key, "")
            data["channels"][cid] = {"kind": kind, "name": name.strip() or cid, "config": cfg}
            self._write(data)
            return data["channels"][cid]

    def delete_channel(self, cid: str) -> None:
        with self._lock:
            data = self._read()
            if cid not in data["channels"]:
                raise KeyError(cid)
            used = [r["name"] for r in data["rules"].values() if cid in r.get("channels", [])]
            if used:
                raise ValueError(f"Used by rule {', '.join(used)}; remove it there first")
            del data["channels"][cid]
            self._write(data)

    # rules
    def save_rule(self, rid: str | None, rule: dict) -> tuple[str, dict]:
        with self._lock:
            data = self._read()
            r = check_rule(rule, set(data["channels"]))
            rid = rid or uuid.uuid4().hex[:10]
            data["rules"][rid] = r
            self._write(data)
            return rid, r

    def delete_rule(self, rid: str) -> None:
        with self._lock:
            data = self._read()
            if data["rules"].pop(rid, None) is None:
                raise KeyError(rid)
            self._write(data)

    # history
    def history(self) -> list[dict]:
        with self._lock:
            if self.history_file is None:
                return list(self._history)
            try:
                items = json.loads(self.history_file.read_text())
                return items if isinstance(items, list) else []
            except (OSError, ValueError):
                return []

    def add_history(self, entry: dict) -> None:
        with self._lock:
            items = [entry, *self.history()][:HISTORY_SIZE]
            if self.history_file is None:
                self._history = items
            else:
                _write_private(self.history_file, items)

    def delete_history(self, ids: list[str] | None) -> int:
        """Remove these alerts from the history (None: all of them). Returns how many."""
        with self._lock:
            items = self.history()
            keep = [] if ids is None else [e for e in items if e.get("id") not in set(ids)]
            if self.history_file is None:
                self._history = keep
            else:
                _write_private(self.history_file, keep)
            return len(items) - len(keep)

    def update_history(self, entry_id: str, change: Callable[[dict], None]) -> None:
        with self._lock:
            items = self.history()
            for e in items:
                if e.get("id") == entry_id:
                    change(e)
            if self.history_file is None:
                self._history = items
            else:
                _write_private(self.history_file, items)


def public_channel(cid: str, ch: dict) -> dict:
    secrets = {k for k, _l, s, _r in CHANNEL_KINDS[ch["kind"]][1] if s}
    cfg = {k: (MASK if k in secrets and v else v) for k, v in ch["config"].items()}
    return {"id": cid, "kind": ch["kind"], "name": ch["name"], "config": cfg}


# ------------------------------------------------------------ sending
def _post_json(url: str, payload: dict, headers: dict | None = None) -> None:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        res.read(4096)


def _title(event: dict) -> str:
    return f"[{event['severity'].upper()}] Prooflix alert: {event['rule']}"


def _details(event: dict) -> list[tuple[str, str]]:
    rows = [("Pipeline", event["pipeline"]), ("Task", event["task"]), ("Run", event["run_id"])]
    rows += [(k, v) for k, v in event.get("fields", {}).items()]
    if event.get("suppressed"):
        rows.append(("Also matched", f"{event['suppressed']} time(s) during the cooldown"))
    return rows


def send(channel: dict, event: dict) -> None:
    """Deliver one alert to one channel. Raises on failure."""
    kind, cfg = channel["kind"], channel["config"]
    text = "\n".join([_title(event), event["line"], *[f"{k}: {v}" for k, v in _details(event)]])
    if kind == "slack":
        _post_json(cfg["url"], {"text": text})
    elif kind == "teams":
        facts = [{"title": k, "value": v} for k, v in _details(event)]
        card = {
            "type": "AdaptiveCard", "version": "1.4",
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "body": [
                {"type": "TextBlock", "text": _title(event), "weight": "Bolder", "wrap": True},
                {"type": "TextBlock", "text": event["line"], "wrap": True, "fontType": "Monospace"},
                {"type": "FactSet", "facts": facts},
            ],
        }
        _post_json(cfg["url"], {"type": "message", "attachments": [
            {"contentType": "application/vnd.microsoft.card.adaptive", "content": card}]})
    elif kind == "webhook":
        headers = {"Authorization": cfg["authorization"]} if cfg.get("authorization") else {}
        _post_json(cfg["url"], {"source": "prooflix", **{k: v for k, v in event.items() if k != "deliveries"}},
                   headers)
    elif kind == "email":
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = _title(event), cfg["sender"], cfg["recipients"]
        msg.set_content(text)
        port = int(cfg["smtp_port"])
        if cfg["security"] == "ssl":
            server = smtplib.SMTP_SSL(cfg["smtp_host"], port, timeout=TIMEOUT, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(cfg["smtp_host"], port, timeout=TIMEOUT)
        with server:
            if cfg["security"] == "starttls":
                server.starttls(context=ssl.create_default_context())
            if cfg.get("username"):
                server.login(cfg["username"], cfg.get("password", ""))
            server.send_message(msg)
    else:
        raise ValueError(f"unknown channel kind {kind}")


def _clean_error(e: Exception, channel: dict) -> str:
    text = str(getattr(e, "reason", None) or e) or type(e).__name__
    if isinstance(e, urllib.error.HTTPError):
        text = f"HTTP {e.code} {e.reason}"
    for key, _l, secret, _r in CHANNEL_KINDS[channel["kind"]][1]:
        value = channel["config"].get(key)
        if secret and value:
            text = text.replace(value, MASK)  # never show a webhook URL or password
    return text[:300]


# ------------------------------------------------------------ the engine
@dataclass
class AlertEngine:
    """Checks task log lines against the rules and sends the alerts."""

    store: AlertStore
    sender: Callable[[dict, dict], None] = send
    _last: dict = field(default_factory=dict)  # (rule id, pipeline) -> time it last notified
    _suppressed: dict = field(default_factory=dict)  # (rule id, pipeline) -> matches since then
    _pool: ThreadPoolExecutor = field(default_factory=lambda: ThreadPoolExecutor(4, thread_name_prefix="alerts"))
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def handle(self, run, task_key: str, line: str) -> None:
        """Called for every task log line (from the run's event loop): must stay quick."""
        if line.startswith("$ "):  # the shell command being run, not its output
            return
        try:
            data = self.store.snapshot()
        except AlertsFileError:
            return
        for rid, rule in data["rules"].items():
            if not rule.get("enabled", True):
                continue
            if rule.get("pipelines") and run.pipeline not in rule["pipelines"]:
                continue
            try:
                fields = match(rule, line)
            except ValueError:
                continue
            if fields is None:
                continue
            key = (rid, run.pipeline)
            with self._lock:
                now = time.monotonic()
                if now - self._last.get(key, -1e9) < rule.get("cooldown_seconds", 300):
                    self._suppressed[key] = self._suppressed.get(key, 0) + 1
                    continue
                self._last[key] = now
                suppressed = self._suppressed.pop(key, 0)
            event = {
                "id": uuid.uuid4().hex[:12], "at": _now(), "rule_id": rid, "rule": rule["name"],
                "severity": rule["severity"], "pipeline": run.pipeline, "run_id": run.id,
                "task": task_key, "line": line, "fields": fields, "suppressed": suppressed,
            }
            targets = rule.get("channels") or list(data["channels"])  # none chosen: every channel
            self.fire(event, {c: data["channels"][c] for c in targets if c in data["channels"]})

    def fire(self, event: dict, channels: dict[str, dict]) -> dict:
        """Record the alert and send it to the channels in the background."""
        event["deliveries"] = {cid: {"channel": ch["name"], "kind": ch["kind"], "status": "sending"}
                               for cid, ch in channels.items()}
        if not channels:
            event["note"] = "no channels: add one in the Alerts tab"
        self.store.add_history(event)
        for cid, ch in channels.items():
            self._pool.submit(self._deliver, event["id"], cid, ch, dict(event))
        return event

    def _deliver(self, event_id: str, cid: str, channel: dict, event: dict) -> None:
        try:
            self.sender(channel, event)
            status, error = "sent", None
        except Exception as e:  # noqa: BLE001 - every transport has its own errors
            status, error = "failed", _clean_error(e, channel)
            log.warning("Alert %s to %s failed: %s", event_id, cid, error)

        def change(entry: dict) -> None:
            entry["deliveries"][cid].update(status=status, error=error, at=_now())

        self.store.update_history(event_id, change)

    def test_channel(self, cid: str) -> dict:
        """Send a test alert to one channel now; {"ok", "error"}."""
        data = self.store.snapshot()
        ch = data["channels"].get(cid)
        if ch is None:
            raise KeyError(cid)
        event = {"id": "test", "at": _now(), "rule_id": "", "rule": "Test from the Alerts tab", "severity": "info",
                 "pipeline": "-", "run_id": "-", "task": "-", "line": "This is a test alert from Prooflix.",
                 "fields": {}, "suppressed": 0}
        try:
            self.sender(ch, event)
            return {"ok": True, "error": None}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": _clean_error(e, ch)}

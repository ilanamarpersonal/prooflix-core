"""``/api/alerts`` routes: channels, rules and recent alerts (the Alerts tab)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from ..alerts import CHANNEL_KINDS, SEVERITIES, AlertEngine, AlertStore, match, public_channel

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _store(request: Request) -> AlertStore:
    return request.app.state.alert_store


def _engine(request: Request) -> AlertEngine:
    return request.app.state.alerts


def _bad(e: ValueError) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))


class ChannelIn(BaseModel):
    kind: str
    name: str = ""
    config: dict = {}  # secrets as "********" keep the saved value


class RuleIn(BaseModel):
    name: str
    enabled: bool = True
    mode: str = "format"  # format: text with {fields}; regex: a regular expression
    pattern: str
    severity: str = "warning"
    pipelines: list[str] = []  # [] = every pipeline
    channels: list[str] = []  # [] = every channel
    cooldown_seconds: int = 300


class TryIn(BaseModel):
    mode: str = "format"
    pattern: str
    line: str


@router.get("/kinds")
def kinds() -> dict:
    return {
        "channels": [
            {"kind": k, "label": label, "fields": [{"key": f, "label": lbl, "secret": s, "required": r}
                                                    for f, lbl, s, r in fields]}
            for k, (label, fields) in CHANNEL_KINDS.items()
        ],
        "severities": list(SEVERITIES),
    }


@router.get("/channels")
def list_channels(request: Request) -> list[dict]:
    return [public_channel(cid, ch) for cid, ch in sorted(_store(request).snapshot()["channels"].items())]


@router.put("/channels/{cid}")
def save_channel(cid: str, body: ChannelIn, request: Request) -> dict:
    try:
        return public_channel(cid, _store(request).save_channel(cid, body.kind, body.name, body.config))
    except ValueError as e:
        raise _bad(e) from None


@router.delete("/channels/{cid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_channel(cid: str, request: Request) -> None:
    try:
        _store(request).delete_channel(cid)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No channel {cid}") from None
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None


@router.post("/channels/{cid}/test")
async def test_channel(cid: str, request: Request) -> dict:
    """Send a test alert to the channel now."""
    try:
        return await asyncio.to_thread(_engine(request).test_channel, cid)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No channel {cid}") from None


@router.get("/rules")
def list_rules(request: Request) -> list[dict]:
    return [{"id": rid, **r} for rid, r in _store(request).snapshot()["rules"].items()]


@router.post("/rules", status_code=status.HTTP_201_CREATED)
def create_rule(body: RuleIn, request: Request) -> dict:
    try:
        rid, r = _store(request).save_rule(None, body.model_dump())
    except ValueError as e:
        raise _bad(e) from None
    return {"id": rid, **r}


@router.put("/rules/{rid}")
def update_rule(rid: str, body: RuleIn, request: Request) -> dict:
    if rid not in _store(request).snapshot()["rules"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No rule {rid}")
    try:
        rid, r = _store(request).save_rule(rid, body.model_dump())
    except ValueError as e:
        raise _bad(e) from None
    return {"id": rid, **r}


@router.delete("/rules/{rid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(rid: str, request: Request) -> None:
    try:
        _store(request).delete_rule(rid)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No rule {rid}") from None


@router.post("/try")
def try_format(body: TryIn) -> dict:
    """Does this log line match the format, and with which fields? (nothing is sent)"""
    try:
        fields = match({"mode": body.mode, "pattern": body.pattern}, body.line)
    except ValueError as e:
        raise _bad(e) from None
    return {"matches": fields is not None, "fields": fields or {}}


@router.get("/history")
def history(request: Request) -> list[dict]:
    return _store(request).history()


class HistoryDelete(BaseModel):
    ids: list[str] | None = None  # None: every alert


@router.post("/history/delete")
def delete_history(body: HistoryDelete, request: Request) -> dict:
    """Remove alerts from Recent alerts (the chosen ones, or all with ``ids: null``)."""
    return {"deleted": _store(request).delete_history(body.ids)}

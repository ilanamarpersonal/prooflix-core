"""``/api/schedules`` routes: check a cron expression before saving it."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from ..pipelines.cron import Cron, CronError
from .schemas import SchedulePreview, SchedulePreviewIn

router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@router.post("/preview", response_model=SchedulePreview)
async def preview(body: SchedulePreviewIn) -> SchedulePreview:
    """Is this a valid schedule, and when would it run next?"""
    try:
        cron = Cron.parse(body.cron)
        runs = cron.next_runs(datetime.now(timezone.utc), body.timezone or "UTC", 5)
    except CronError as exc:
        return SchedulePreview(valid=False, error=str(exc))
    return SchedulePreview(valid=True, cron=cron.expression, next_runs=runs)

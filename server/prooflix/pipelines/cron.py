"""Cron expressions for pipeline schedules.

Standard five fields, ``minute hour day-of-month month day-of-week``:

    */15 * * * *      every 15 minutes
    0 * * * *         every hour, on the hour
    30 2 * * *        every day at 02:30
    0 9 * * 1-5       weekdays at 09:00
    0 6 1 * *         the 1st of every month at 06:00

Each field takes ``*``, a number, a range ``a-b``, a step ``*/n`` or ``a-b/n``, and
lists of those separated by commas. Months and weekdays also take names (``jan``,
``mon``); Sunday is 0 or 7. As in standard cron, when both day-of-month and
day-of-week are restricted, a day matches if either one does.

Times are matched in the schedule's time zone, so "daily at 02:00" stays at 02:00
local time across daylight saving changes (a 02:30 that a spring-forward skips
doesn't run that day; a time repeated in the autumn runs once).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_FIELDS = (  # name, low, high
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day of month", 1, 31),
    ("month", 1, 12),
    ("day of week", 0, 7),
)
_NAMES = {
    3: {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())},
    4: {d: i for i, d in enumerate("sun mon tue wed thu fri sat".split())},
}
_SEARCH_LIMIT = timedelta(days=366 * 5)  # no cron matches less often than this (Feb 29 is every 4 years)


class CronError(ValueError):
    """An invalid cron expression or time zone; the message says what is wrong."""


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CronError(f"Unknown time zone '{name}'") from exc


def _parse_field(text: str, index: int) -> frozenset[int]:
    name, low, high = _FIELDS[index]
    names = _NAMES.get(index, {})
    values: set[int] = set()

    def number(token: str) -> int:
        token = token.strip().lower()
        if token in names:
            return names[token]
        if not token.isdigit():
            raise CronError(f"'{token}' is not a valid {name}")
        n = int(token)
        if not low <= n <= high:
            raise CronError(f"{name} {n} is out of range ({low}-{high})")
        return n

    for part in text.split(","):
        if not part:
            raise CronError(f"empty value in the {name} field")
        rng, _, step_text = part.partition("/")
        step = 1
        if step_text:
            if not step_text.isdigit() or int(step_text) == 0:
                raise CronError(f"'{step_text}' is not a valid step for the {name}")
            step = int(step_text)
        if rng == "*":
            start, end = low, high
        elif "-" in rng:
            a, b = rng.split("-", 1)
            start, end = number(a), number(b)
            if start > end:
                raise CronError(f"{name} range {rng} goes backwards")
        else:
            start = number(rng)
            end = high if step_text else start  # "5/10" means from 5, every 10
        values.update(range(start, end + 1, step))
    if index == 4 and 7 in values:  # Sunday is 0 or 7
        values.discard(7)
        values.add(0)
    return frozenset(values)


@dataclass(frozen=True)
class Cron:
    expression: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 = Sunday
    any_day: bool  # day-of-month is "*"
    any_weekday: bool  # day-of-week is "*"

    @classmethod
    def parse(cls, expression: str) -> "Cron":
        fields = expression.split()
        if len(fields) != 5:
            raise CronError(
                f"A cron expression has 5 fields (minute hour day-of-month month day-of-week), got {len(fields)}"
            )
        parsed = [_parse_field(f, i) for i, f in enumerate(fields)]
        return cls(" ".join(fields), *parsed, any_day=fields[2] == "*", any_weekday=fields[4] == "*")

    def _day_matches(self, d: datetime) -> bool:
        if d.month not in self.months:
            return False
        dom = d.day in self.days
        dow = (d.isoweekday() % 7) in self.weekdays
        if self.any_day and self.any_weekday:
            return True
        if self.any_day:
            return dow
        if self.any_weekday:
            return dom
        return dom or dow  # both restricted: either one

    def next_after(self, after: datetime, tz: str = "UTC") -> datetime:
        """The first time strictly after ``after`` (an aware datetime) that matches,
        as an aware UTC datetime."""
        zi = zone(tz)
        local = after.astimezone(zi).replace(second=0, microsecond=0) + timedelta(minutes=1)
        limit = local + _SEARCH_LIMIT
        while local < limit:
            if not self._day_matches(local):
                local = (local + timedelta(days=1)).replace(hour=0, minute=0)
                continue
            if local.hour not in self.hours:
                local = (local + timedelta(hours=1)).replace(minute=0)
                continue
            if local.minute not in self.minutes:
                local += timedelta(minutes=1)
                continue
            # wall-clock time -> real instant; skip times a DST jump makes not exist
            candidate = local.replace(tzinfo=zi)
            back = candidate.astimezone(timezone.utc).astimezone(zi)
            if back.replace(tzinfo=None) == candidate.replace(tzinfo=None):
                result = candidate.astimezone(timezone.utc)
                if result > after:
                    return result
            local += timedelta(minutes=1)
        raise CronError(f"'{self.expression}' never matches")

    def next_runs(self, after: datetime, tz: str = "UTC", count: int = 3) -> list[datetime]:
        out: list[datetime] = []
        for _ in range(count):
            after = self.next_after(after, tz)
            out.append(after)
        return out

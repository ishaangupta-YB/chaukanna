"""The quiet hours check, re-run at ring time.

A window is stored as local wall clock time plus a zone name, never as an offset, so the check
converts `now` into that zone and compares there. India has no DST today, but the code is written
as if it did: `ZoneInfo` resolves the offset for the instant being tested, so a future rule change
(or a member whose window is stored in some other zone) needs no edit here. A hardcoded `+05:30`
would need one, silently and a year late.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

TIME_ZONE = "Asia/Kolkata"

#: What `apps/web/src/lib/db/models.ts` calls DEFAULT_WINDOW. Used when a member never set one.
DEFAULT_WINDOW: dict[str, Any] = {
    "days": [1, 2, 3, 4, 5],
    "start": "11:00",
    "end": "18:00",
    "tz": TIME_ZONE,
}


def to_minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def is_inside(window: dict[str, Any], moment: datetime) -> bool:
    """True when `moment`, seen in the window's own zone, falls on an allowed day and inside the
    time range. The start minute is inside, the end minute is not: a window that ends at 18:00 is
    over at 18:00, which is how a human reads it."""
    local = moment.astimezone(ZoneInfo(str(window.get("tz") or TIME_ZONE)))
    if local.isoweekday() not in [int(day) for day in window["days"]]:
        return False
    minute_of_day = local.hour * 60 + local.minute
    return to_minutes(window["start"]) <= minute_of_day < to_minutes(window["end"])

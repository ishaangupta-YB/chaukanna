"""The timestamp format the web app's zod models accept."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from lifecycle_service.clock import to_iso, utc_now_iso

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_now_ends_in_z_with_milliseconds() -> None:
    assert ISO_Z.match(utc_now_iso())


def test_it_is_never_the_offset_form() -> None:
    # `z.iso.datetime()` in apps/web rejects `+00:00`, so a drill written that way is unreadable.
    assert "+00:00" not in utc_now_iso()


def test_round_trips_through_fromisoformat() -> None:
    moment = datetime(2026, 9, 20, 5, 30, 0, 123456, tzinfo=UTC)
    text = to_iso(moment)
    assert text == "2026-09-20T05:30:00.123Z"
    assert datetime.fromisoformat(text) == moment.replace(microsecond=123000)


def test_a_non_utc_moment_is_converted_not_relabelled() -> None:
    from zoneinfo import ZoneInfo

    assert to_iso(datetime(2026, 9, 20, 11, 0, tzinfo=ZoneInfo("Asia/Kolkata"))) == "2026-09-20T05:30:00.000Z"

"""The quiet hours check, including the two boundary minutes it is easy to get backwards."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from lifecycle_service.window import DEFAULT_WINDOW, is_inside, to_minutes

IST = ZoneInfo("Asia/Kolkata")


def ist(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=IST)


def test_start_minute_is_inside() -> None:
    assert is_inside(DEFAULT_WINDOW, ist(2026, 9, 21, 11, 0)) is True


def test_end_minute_is_outside() -> None:
    # 18:00 means "over at six", the way a person reading the setting would expect.
    assert is_inside(DEFAULT_WINDOW, ist(2026, 9, 21, 18, 0)) is False


def test_minute_before_the_end_is_inside() -> None:
    assert is_inside(DEFAULT_WINDOW, ist(2026, 9, 21, 17, 59)) is True


def test_minute_before_the_start_is_outside() -> None:
    assert is_inside(DEFAULT_WINDOW, ist(2026, 9, 21, 10, 59)) is False


def test_day_not_in_the_window_is_outside() -> None:
    assert is_inside(DEFAULT_WINDOW, ist(2026, 9, 20, 12, 0)) is False  # a Sunday


def test_a_utc_instant_is_judged_in_local_time() -> None:
    """06:30 UTC is 12:00 IST on the Monday: inside, even though 06:30 is not."""
    assert is_inside(DEFAULT_WINDOW, datetime(2026, 9, 21, 6, 30, tzinfo=UTC)) is True


def test_a_utc_instant_can_be_the_previous_local_day() -> None:
    """20:00 UTC on Sunday is 01:30 IST on Monday: a Monday window, but the wrong hour."""
    assert is_inside(DEFAULT_WINDOW, datetime(2026, 9, 20, 20, 0, tzinfo=UTC)) is False


def test_the_zone_comes_from_the_window_not_a_hardcoded_offset() -> None:
    """The same instant, judged in two zones, gives two answers. India has no DST today; the
    conversion goes through ZoneInfo so that a zone which does would still be right."""
    moment = datetime(2026, 9, 21, 6, 30, tzinfo=UTC)
    london = {**DEFAULT_WINDOW, "tz": "Europe/London"}
    assert is_inside(DEFAULT_WINDOW, moment) is True  # 12:00 IST
    assert is_inside(london, moment) is False  # 07:30 BST


def test_to_minutes() -> None:
    assert to_minutes("00:00") == 0
    assert to_minutes("11:30") == 690
    assert to_minutes("23:59") == 1439

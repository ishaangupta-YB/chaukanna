"""The timestamp format the web app's zod models will accept.

This is pinned rather than trusted because the failure is silent on this side: the agent writes a
row successfully, and the app that has to show it throws when it reads it back. It cost a live
drill to find once.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta, timezone

import pytest

from chaukanna_agent.clock import to_iso, utc_now_iso

# The shape `z.iso.datetime()` accepts: a Z suffix, never an offset.
ZOD_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_now_matches_what_javascript_writes() -> None:
    assert ZOD_ISO.match(utc_now_iso()), utc_now_iso()


def test_the_offset_form_python_reaches_for_by_default_would_not_pass() -> None:
    # The exact value that broke a real drill row, kept so nobody reintroduces it.
    assert not ZOD_ISO.match(datetime.now(UTC).isoformat())
    assert not ZOD_ISO.match("2026-09-19T23:35:37.176154+00:00")


def test_milliseconds_are_three_digits_not_six() -> None:
    assert to_iso(datetime(2026, 9, 19, 23, 35, 37, 176_154, tzinfo=UTC)) == "2026-09-19T23:35:37.176Z"


def test_a_whole_second_still_carries_milliseconds() -> None:
    assert to_iso(datetime(2026, 1, 2, 3, 4, 5, 0, tzinfo=UTC)) == "2026-01-02T03:04:05.000Z"


def test_another_timezone_is_converted_not_relabelled() -> None:
    ist = timezone(timedelta(hours=5, minutes=30))
    assert to_iso(datetime(2026, 9, 20, 5, 5, 0, 0, tzinfo=ist)) == "2026-09-19T23:35:00.000Z"


@pytest.mark.parametrize("microsecond", [0, 1, 999, 1_000, 999_999])
def test_every_microsecond_truncates_rather_than_rounding_past_a_second(microsecond: int) -> None:
    stamped = to_iso(datetime(2026, 9, 19, 23, 35, 37, microsecond, tzinfo=UTC))
    assert ZOD_ISO.match(stamped)
    assert stamped.startswith("2026-09-19T23:35:37.")


def test_it_sorts_lexicographically() -> None:
    """Drill sort keys and the event log both depend on this."""
    earlier = to_iso(datetime(2026, 9, 19, 23, 35, 37, 1_000, tzinfo=UTC))
    later = to_iso(datetime(2026, 9, 19, 23, 35, 37, 2_000, tzinfo=UTC))
    assert earlier < later

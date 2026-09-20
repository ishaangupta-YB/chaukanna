"""The ring Lambda, end to end against fake AWS clients."""

from __future__ import annotations

from datetime import datetime

import pytest
from conftest import (
    DRILL_ID,
    HOUSEHOLD_ID,
    INSIDE,
    MEMBER_ID,
    FakeDdb,
    FakeSes,
    consent_item,
    drill_item,
    household_item,
    member_item,
    window_item,
)

from lifecycle_service import ring

EVENT = {"drillId": DRILL_ID, "memberId": MEMBER_ID}


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Monday noon IST unless a test says otherwise, so the default window is open."""
    monkeypatch.setattr(ring, "clock_now", lambda: INSIDE)


def at(moment: datetime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ring, "clock_now", lambda: moment)


def states(ddb: FakeDdb) -> str:
    return ddb.items[(f"MEMBER#{MEMBER_ID}", drill_item()["sk"]["S"])]["state"]["S"]


def lifecycle_events(ddb: FakeDdb) -> list[str]:
    return [item["name"]["S"] for item in ddb.puts]


# --- the happy path -----------------------------------------------------------------------


def test_scheduled_drill_becomes_due(ddb: FakeDdb, ses: FakeSes) -> None:
    assert ring.handler(EVENT, None) == {"status": "due", "drillId": DRILL_ID}
    assert states(ddb) == "due"
    assert lifecycle_events(ddb) == ["drill.due"]
    assert len(ses.sent) == 1


def test_due_write_sets_the_expiry_as_a_number_and_never_a_ttl(ddb: FakeDdb) -> None:
    ring.handler(EVENT, None)
    values = ddb.updates[0]["ExpressionAttributeValues"]
    # A plain attribute, marshalled as a Number. Writing `ttl` here would delete the drill.
    assert values[":expiry"]["N"].isdigit()
    assert int(values[":expiry"]["N"]) == int(INSIDE.timestamp()) + 30 * 60
    assert "ttl" not in ddb.updates[0]["UpdateExpression"]


def test_due_minutes_is_configurable(ddb: FakeDdb, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DRILL_DUE_MINUTES", "5")
    ring.handler(EVENT, None)
    values = ddb.updates[0]["ExpressionAttributeValues"]
    assert int(values[":expiry"]["N"]) == int(INSIDE.timestamp()) + 5 * 60


def test_lifecycle_event_row_carries_ids_and_a_ttl(ddb: FakeDdb) -> None:
    ring.handler(EVENT, None)
    row = ddb.puts[0]
    assert row["pk"]["S"] == f"DRILL#{DRILL_ID}"
    assert row["sk"]["S"].startswith("EVT#2026-")  # never mistakable for the agent's EVT#000004
    assert row["entity"]["S"] == "DrillEvent"
    assert row["actor"]["S"] == "scheduler"
    assert row["memberId"]["S"] == MEMBER_ID
    assert row["householdId"]["S"] == HOUSEHOLD_ID
    assert row["ttl"]["N"].isdigit()


# --- nothing to ring ----------------------------------------------------------------------


def test_missing_drill_returns_gone_without_raising(ddb: FakeDdb) -> None:
    ddb.items.clear()
    assert ring.handler(EVENT, None) == {"status": "gone"}
    assert ddb.updates == []


def test_already_cancelled_drill_is_left_alone(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.put(drill_item(state="cancelled"))
    assert ring.handler(EVENT, None) == {"status": "not_scheduled", "state": "cancelled"}
    assert ddb.updates == []
    assert ddb.puts == []
    assert ses.sent == []


def test_bad_event_is_a_validation_error(ddb: FakeDdb) -> None:
    with pytest.raises(ring.RingEventError):
        ring.handler({"drillId": DRILL_ID}, None)


# --- refusals, which cancel ---------------------------------------------------------------


def test_paused_member_cancels_with_paused(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.put(member_item(status="paused"))
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "paused"}
    assert states(ddb) == "cancelled"
    assert lifecycle_events(ddb) == ["drill.cancelled"]
    assert ddb.updates[0]["ExpressionAttributeValues"][":source"]["S"] == "ring:paused"
    assert ses.sent == []


def test_revoked_member_cancels_as_not_consented(ddb: FakeDdb) -> None:
    ddb.put(member_item(status="revoked"))
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "not_consented"}


def test_missing_member_row_cancels_as_not_consented(ddb: FakeDdb) -> None:
    del ddb.items[(f"HH#{HOUSEHOLD_ID}", f"MEMBER#{MEMBER_ID}")]
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "not_consented"}


def test_revoked_consent_cancels(ddb: FakeDdb) -> None:
    ddb.put(consent_item(revoked=True))
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "not_consented"}
    assert states(ddb) == "cancelled"


def test_absent_consent_cancels(ddb: FakeDdb) -> None:
    del ddb.items[(f"MEMBER#{MEMBER_ID}", "CONSENT#2026-09-01T10:00:00.000Z")]
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "not_consented"}


def test_outside_window_cancels(ddb: FakeDdb, monkeypatch: pytest.MonkeyPatch) -> None:
    at(INSIDE.replace(hour=20), monkeypatch)  # 01:30 IST the next day
    assert ring.handler(EVENT, None) == {"status": "cancelled", "reason": "outside_window"}
    assert ddb.updates[0]["ExpressionAttributeValues"][":source"]["S"] == "ring:outside_window"


def test_cancel_removes_the_session_token(ddb: FakeDdb) -> None:
    ddb.put(member_item(status="paused"))
    ring.handler(EVENT, None)
    assert "REMOVE sessionJti, sessionExpiresAt" in ddb.updates[0]["UpdateExpression"]


# --- races --------------------------------------------------------------------------------


def test_conditional_failure_on_the_due_write_yields_not_scheduled(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.fail_next_condition = True
    assert ring.handler(EVENT, None) == {"status": "not_scheduled"}
    assert states(ddb) == "scheduled"
    assert ddb.puts == []
    assert ses.sent == []


def test_conditional_failure_on_the_cancel_write_yields_not_scheduled(ddb: FakeDdb) -> None:
    ddb.put(member_item(status="paused"))
    ddb.fail_next_condition = True
    assert ring.handler(EVENT, None) == {"status": "not_scheduled"}
    assert ddb.puts == []


# --- the nudge is best effort --------------------------------------------------------------


def test_ses_failure_still_returns_due(ddb: FakeDdb, ses: FakeSes) -> None:
    ses.error = RuntimeError("SES said no")
    assert ring.handler(EVENT, None) == {"status": "due", "drillId": DRILL_ID}
    assert states(ddb) == "due"


def test_unset_sender_skips_the_email(ddb: FakeDdb, ses: FakeSes, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SENDER_EMAIL")
    assert ring.handler(EVENT, None) == {"status": "due", "drillId": DRILL_ID}
    assert ses.sent == []


def test_household_without_an_owner_email_skips_the_email(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.put(household_item(owner_email=None))
    assert ring.handler(EVENT, None) == {"status": "due", "drillId": DRILL_ID}
    assert ses.sent == []


# --- the stored window --------------------------------------------------------------------


def test_stored_window_is_read_from_the_row(ddb: FakeDdb, monkeypatch: pytest.MonkeyPatch) -> None:
    ddb.put(window_item(days=[1, 2, 3, 4, 5, 6, 7], start="00:00", end="23:59"))
    at(INSIDE.replace(hour=20), monkeypatch)  # outside the default, inside this one
    assert ring.handler(EVENT, None)["status"] == "due"


def test_window_falls_back_to_the_default_when_absent(ddb: FakeDdb) -> None:
    assert ring.load_window(MEMBER_ID) == {
        "days": [1, 2, 3, 4, 5],
        "start": "11:00",
        "end": "18:00",
        "tz": "Asia/Kolkata",
    }

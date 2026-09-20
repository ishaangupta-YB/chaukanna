"""The guardian nudge: who it goes to, what it may say, and how it fails."""

from __future__ import annotations

import pytest
from conftest import DRILL_ID, HOUSEHOLD_ID, FakeDdb, FakeSes, household_item

from lifecycle_service import notify


def send(display_name: str = "Amma") -> str:
    return notify.try_send_due_email(drill_id=DRILL_ID, household_id=HOUSEHOLD_ID, display_name=display_name)


def test_goes_to_the_guardian_address_on_the_household_row(ddb: FakeDdb, ses: FakeSes) -> None:
    assert send() == "sent"
    assert ses.sent[0]["Destination"]["ToAddresses"] == ["guardian@example.com"]
    assert ses.sent[0]["FromEmailAddress"] == "no-reply@example.com"


def test_body_names_the_member_and_links_to_the_app(ddb: FakeDdb, ses: FakeSes) -> None:
    send(display_name="Nanaji")
    body = ses.sent[0]["Content"]["Simple"]["Body"]["Text"]["Data"]
    assert "Nanaji" in body
    assert "https://example.com/app" in body


def test_body_never_carries_the_drill_id(ddb: FakeDdb, ses: FakeSes) -> None:
    send()
    simple = ses.sent[0]["Content"]["Simple"]
    assert DRILL_ID not in simple["Body"]["Text"]["Data"]
    assert DRILL_ID not in simple["Subject"]["Data"]


def test_no_sender_configured_skips(ddb: FakeDdb, ses: FakeSes, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENDER_EMAIL", "   ")
    assert send() == "no_sender"
    assert ses.sent == []


def test_household_without_an_owner_email_skips(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.put(household_item(owner_email=None))
    assert send() == "no_owner_email"
    assert ses.sent == []


def test_missing_household_row_skips(ddb: FakeDdb, ses: FakeSes) -> None:
    ddb.items.pop((f"HH#{HOUSEHOLD_ID}", "META"))
    assert send() == "no_owner_email"


def test_an_ses_error_is_swallowed(ddb: FakeDdb, ses: FakeSes) -> None:
    ses.error = RuntimeError("throttled")
    assert send() == "failed"


def test_send_due_email_itself_does_raise(ddb: FakeDdb, ses: FakeSes) -> None:
    """The bare send is honest about failing; only `try_send_due_email` swallows it."""
    ses.error = RuntimeError("throttled")
    with pytest.raises(RuntimeError):
        notify.send_due_email(drill_id=DRILL_ID, household_id=HOUSEHOLD_ID, display_name="Amma")

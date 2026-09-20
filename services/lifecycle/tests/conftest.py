"""Hand written fakes for DynamoDB and SES.

No moto, no network, no credentials: the ring Lambda's logic is a handful of conditional writes
and a clock, and a fake that raises the one error that matters (ConditionalCheckFailedException)
tests them faster and more honestly than a mock service would.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lifecycle_service import aws

HOUSEHOLD_ID = "a1b2c3d4"
MEMBER_ID = "b2c3d4e5"
DRILL_ID = "c3d4e5f6"
SCHEDULED_AT = "2026-09-20T05:30:00.000Z"

#: A Monday, 12:00 IST: inside the default window (Mon-Fri, 11:00-18:00 Asia/Kolkata).
INSIDE = datetime(2026, 9, 21, 6, 30, tzinfo=UTC)


def conditional_check_failed() -> ClientError:
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "the condition failed"}},
        "UpdateItem",
    )


class FakeDdb:
    """Just enough DynamoDB: key lookups, a prefix query, and a conditional state transition."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.updates: list[dict[str, Any]] = []
        self.puts: list[dict[str, Any]] = []
        self.fail_next_condition = False

    def put(self, item: dict[str, Any]) -> None:
        self.items[(item["pk"]["S"], item["sk"]["S"])] = item

    # --- the boto3 surface the code actually calls ---------------------------------------

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        key = (kwargs["Key"]["pk"]["S"], kwargs["Key"]["sk"]["S"])
        item = self.items.get(key)
        return {"Item": item} if item else {}

    def query(self, **kwargs: Any) -> dict[str, Any]:
        values = kwargs["ExpressionAttributeValues"]
        pk, prefix = values[":pk"]["S"], values[":prefix"]["S"]
        matches = [item for (ipk, isk), item in self.items.items() if ipk == pk and isk.startswith(prefix)]
        matches.sort(key=lambda item: item["sk"]["S"], reverse=not kwargs.get("ScanIndexForward", True))
        return {"Items": matches[: kwargs.get("Limit", len(matches))]}

    def put_item(self, **kwargs: Any) -> dict[str, Any]:
        self.puts.append(kwargs["Item"])
        self.put(kwargs["Item"])
        return {}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        key = (kwargs["Key"]["pk"]["S"], kwargs["Key"]["sk"]["S"])
        item = self.items.get(key)
        values = kwargs["ExpressionAttributeValues"]
        expected = values.get(":scheduled", {}).get("S")
        if self.fail_next_condition or item is None or (expected and item["state"]["S"] != expected):
            self.fail_next_condition = False
            raise conditional_check_failed()
        self.updates.append(kwargs)
        new_state = values.get(":cancelled") or values.get(":due")
        if new_state:
            item["state"] = new_state
        return {}


class FakeSes:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.sent: list[dict[str, Any]] = []

    def send_email(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise self.error
        self.sent.append(kwargs)
        return {"MessageId": "fake"}


def drill_item(state: str = "scheduled", **extra: Any) -> dict[str, Any]:
    return {
        "pk": {"S": f"MEMBER#{MEMBER_ID}"},
        "sk": {"S": f"DRILL#{SCHEDULED_AT}#{DRILL_ID}"},
        "entity": {"S": "Drill"},
        "drillId": {"S": DRILL_ID},
        "memberId": {"S": MEMBER_ID},
        "householdId": {"S": HOUSEHOLD_ID},
        "state": {"S": state},
        "scheduledAt": {"S": SCHEDULED_AT},
        **extra,
    }


def member_item(status: str = "active") -> dict[str, Any]:
    return {
        "pk": {"S": f"HH#{HOUSEHOLD_ID}"},
        "sk": {"S": f"MEMBER#{MEMBER_ID}"},
        "entity": {"S": "Member"},
        "memberId": {"S": MEMBER_ID},
        "householdId": {"S": HOUSEHOLD_ID},
        "displayName": {"S": "Amma"},
        "status": {"S": status},
    }


def consent_item(revoked: bool = False) -> dict[str, Any]:
    item = {
        "pk": {"S": f"MEMBER#{MEMBER_ID}"},
        "sk": {"S": "CONSENT#2026-09-01T10:00:00.000Z"},
        "entity": {"S": "Consent"},
        "memberId": {"S": MEMBER_ID},
    }
    if revoked:
        item["revokedAt"] = {"S": "2026-09-19T10:00:00.000Z"}
    return item


def household_item(owner_email: str | None = "guardian@example.com") -> dict[str, Any]:
    item = {
        "pk": {"S": f"HH#{HOUSEHOLD_ID}"},
        "sk": {"S": "META"},
        "entity": {"S": "Household"},
        "householdId": {"S": HOUSEHOLD_ID},
    }
    if owner_email:
        item["ownerEmail"] = {"S": owner_email}
    return item


def window_item(days: list[int], start: str, end: str, tz: str = "Asia/Kolkata") -> dict[str, Any]:
    return {
        "pk": {"S": f"MEMBER#{MEMBER_ID}"},
        "sk": {"S": "WINDOW#current"},
        "entity": {"S": "Window"},
        "window": {
            "M": {
                "days": {"L": [{"N": str(day)} for day in days]},
                "start": {"S": start},
                "end": {"S": end},
                "tz": {"S": tz},
            }
        },
    }


@pytest.fixture
def ses() -> FakeSes:
    return FakeSes()


@pytest.fixture
def ddb(monkeypatch: pytest.MonkeyPatch, ses: FakeSes) -> FakeDdb:
    """A table holding a ready to ring drill, with the clients pointed at fakes."""
    fake = FakeDdb()
    for item in (drill_item(), member_item(), consent_item(), household_item()):
        fake.put(item)

    clients: dict[str, Any] = {"dynamodb": fake, "sesv2": ses}
    monkeypatch.setattr(aws, "client", lambda service: clients[service])
    monkeypatch.setenv("TABLE_NAME", "chaukanna-test")
    monkeypatch.setenv("AWS_REGION", "ap-south-1")
    monkeypatch.setenv("SENDER_EMAIL", "no-reply@example.com")
    monkeypatch.setenv("APP_URL", "https://example.com")
    return fake

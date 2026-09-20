"""The ring Lambda: the target of a one time EventBridge Scheduler schedule.

Scheduler fires at the drill's scheduled minute with `{"drillId": ..., "memberId": ...}`. This
handler is the last gate before a phone rings in an elderly person's hand, so it re-checks
everything the scheduler knew at schedule time and may no longer know:

- is the drill still `scheduled`, or did someone cancel it a second ago
- is the member still `active`
- is there a consent row, and is it still un-revoked
- is now inside the member's quiet hours window

Any "no" cancels the drill rather than ringing it, and the reason is written into `endSource` so
the app can say why. Only a clean "yes" moves the row to `due`.

Two things this handler will not do:

- It will not raise for an expected outcome. A raise makes Scheduler retry, and retrying a
  cancelled drill just rings it again later. A missing row, a cancelled drill and a refusal are
  all returns, not exceptions.
- It will not write `ttl` on a drill row. `dueExpiresAt` is a plain attribute the app compares
  against; the table's TTL attribute is `ttl`, and writing it here would delete the drill.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError

from .aws import ddb, table_name
from .clock import utc_now_iso
from .keys import (
    CONSENT_PREFIX,
    DRILL_PREFIX,
    lifecycle_event_keys,
    member_keys,
    member_pk,
    state_gsi1pk,
    window_keys,
)
from .log import configure_logging, event
from .notify import try_send_due_email
from .window import DEFAULT_WINDOW, is_inside

#: How many recent drills to look through for the one Scheduler named. There is no index on
#: drillId, and a member has a handful of drills, so a newest first page covers it.
DRILL_SCAN_LIMIT = 50
#: Lifecycle event rows are audit, not content: ids and labels only, thirty days.
EVENT_TTL_DAYS = 30

REASON_PAUSED = "paused"
REASON_NOT_CONSENTED = "not_consented"
REASON_OUTSIDE_WINDOW = "outside_window"

configure_logging()


class RingEventError(ValueError):
    """The Scheduler target sent something this function cannot act on."""


def parse_ring_event(payload: dict) -> tuple[str, str]:
    """Exactly what the Scheduler target sends: two ids and nothing else.

    Hand-written rather than a pydantic model, which is the house rule for a boundary, because
    the deployment shape decides this one: the asset is the source tree, `pip` never runs against
    it, and the Lambda runtime ships boto3 but not pydantic. A dependency that only fails at cold
    start, in production, is worse than twelve lines of explicit validation.
    """
    if not isinstance(payload, dict):
        raise RingEventError("payload must be an object")
    values: list[str] = []
    for field in ("drillId", "memberId"):
        value = payload.get(field)
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            raise RingEventError(f"{field} must be a string of 1 to 64 characters")
        values.append(value)
    return values[0], values[1]


def due_minutes() -> int:
    return int(os.environ.get("DRILL_DUE_MINUTES", "30"))


def clock_now() -> datetime:
    """The single clock reading for a ring. One function so a test can decide what time it is
    without reaching into `datetime`."""
    return datetime.now(UTC)


def _s(item: dict[str, Any], name: str) -> str | None:
    return item.get(name, {}).get("S")


def find_drill(member_id: str, drill_id: str) -> dict[str, Any] | None:
    """The drill row, found by scanning the member's recent drills.

    The sort key is `DRILL#<scheduledAt>#<drillId>`, so there is no way to get a drill by id
    alone and no index that offers one. Newest first, one page, consistent: a drill that was just
    written by the web app must be visible to the schedule it created.
    """
    out = ddb().query(
        TableName=table_name(),
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={":pk": {"S": member_pk(member_id)}, ":prefix": {"S": DRILL_PREFIX}},
        ScanIndexForward=False,
        Limit=DRILL_SCAN_LIMIT,
        ConsistentRead=True,
    )
    for item in out.get("Items", []):
        if _s(item, "drillId") == drill_id:
            return item
    return None


def member_row(household_id: str, member_id: str) -> dict[str, Any] | None:
    out = ddb().get_item(
        TableName=table_name(),
        Key={k: {"S": v} for k, v in member_keys(household_id, member_id).items()},
        ConsistentRead=True,
    )
    return out.get("Item") or None


def has_live_consent(member_id: str) -> bool:
    """The newest consent row must exist and must not carry `revokedAt`. Revocation is a write to
    the consent row, so its absence is the whole check."""
    out = ddb().query(
        TableName=table_name(),
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={":pk": {"S": member_pk(member_id)}, ":prefix": {"S": CONSENT_PREFIX}},
        ScanIndexForward=False,
        Limit=1,
        ConsistentRead=True,
    )
    items = out.get("Items", [])
    if not items:
        return False
    return "revokedAt" not in items[0]


def load_window(member_id: str) -> dict[str, Any]:
    """The member's stored window, or the product default when they never set one."""
    out = ddb().get_item(
        TableName=table_name(),
        Key={k: {"S": v} for k, v in window_keys(member_id).items()},
        ConsistentRead=True,
    )
    item = out.get("Item")
    stored = (item or {}).get("window", {}).get("M")
    if not stored:
        return DEFAULT_WINDOW
    return {
        "days": [int(day["N"]) for day in stored.get("days", {}).get("L", [])] or list(DEFAULT_WINDOW["days"]),
        "start": stored.get("start", {}).get("S") or DEFAULT_WINDOW["start"],
        "end": stored.get("end", {}).get("S") or DEFAULT_WINDOW["end"],
        "tz": stored.get("tz", {}).get("S") or DEFAULT_WINDOW["tz"],
    }


def write_lifecycle_event(
    *,
    drill: dict[str, Any],
    name: str,
    at: str,
    detail: dict[str, str | int] | None = None,
) -> None:
    """An audit row under the drill's own partition. `ttl` here is intentional: event rows expire,
    drill rows never do."""
    drill_id = _s(drill, "drillId") or ""
    expires = int((clock_now() + timedelta(days=EVENT_TTL_DAYS)).timestamp())
    detail_map: dict[str, Any] = {
        key: ({"N": str(value)} if isinstance(value, int) and not isinstance(value, bool) else {"S": str(value)})
        for key, value in (detail or {}).items()
    }
    ddb().put_item(
        TableName=table_name(),
        Item={
            **{k: {"S": v} for k, v in lifecycle_event_keys(drill_id, at, name).items()},
            "entity": {"S": "DrillEvent"},
            "drillId": {"S": drill_id},
            "memberId": {"S": _s(drill, "memberId") or ""},
            "householdId": {"S": _s(drill, "householdId") or ""},
            "name": {"S": name},
            "at": {"S": at},
            "actor": {"S": "scheduler"},
            "detail": {"M": detail_map},
            "ttl": {"N": str(expires)},
        },
    )


def cancel_drill(drill: dict[str, Any], reason: str) -> dict[str, str]:
    """A refusal is a cancellation, not a silent skip: the row has to stop saying `scheduled` or
    the app will show a drill that will never ring."""
    drill_id = _s(drill, "drillId") or ""
    now = utc_now_iso()
    try:
        ddb().update_item(
            TableName=table_name(),
            Key={"pk": {"S": drill["pk"]["S"]}, "sk": {"S": drill["sk"]["S"]}},
            UpdateExpression=(
                "SET #state = :cancelled, gsi1pk = :gsi1pk, updatedAt = :now, endedAt = :now, "
                "endSource = :source REMOVE sessionJti, sessionExpiresAt"
            ),
            ConditionExpression="attribute_exists(pk) AND #state = :scheduled",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":cancelled": {"S": "cancelled"},
                ":gsi1pk": {"S": state_gsi1pk("cancelled")},
                ":scheduled": {"S": "scheduled"},
                ":now": {"S": now},
                ":source": {"S": f"ring:{reason}"},
            },
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            # Someone else moved the row in the same instant. Their write stands.
            event("ring.cancel_lost_race", drill_id, reason=reason)
            return {"status": "not_scheduled"}
        raise
    write_lifecycle_event(drill=drill, name="drill.cancelled", at=now, detail={"reason": reason})
    event("ring.cancelled", drill_id, reason=reason)
    return {"status": "cancelled", "reason": reason}


def mark_due(drill: dict[str, Any]) -> dict[str, str] | None:
    """`scheduled` to `due`, conditionally. Returns None when the condition failed, which means a
    cancellation landed first and wins."""
    drill_id = _s(drill, "drillId") or ""
    now = utc_now_iso()
    expiry = int((clock_now() + timedelta(minutes=due_minutes())).timestamp())
    try:
        ddb().update_item(
            TableName=table_name(),
            Key={"pk": {"S": drill["pk"]["S"]}, "sk": {"S": drill["sk"]["S"]}},
            UpdateExpression=(
                "SET #state = :due, gsi1pk = :gsi1due, dueAt = :now, dueExpiresAt = :expiry, updatedAt = :now"
            ),
            ConditionExpression="attribute_exists(pk) AND #state = :scheduled",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":due": {"S": "due"},
                ":gsi1due": {"S": state_gsi1pk("due")},
                ":scheduled": {"S": "scheduled"},
                ":now": {"S": now},
                # A plain attribute. NOT the table's `ttl`: writing that would delete the drill.
                ":expiry": {"N": str(expiry)},
            },
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            event("ring.lost_race", drill_id)
            return None
        raise
    write_lifecycle_event(drill=drill, name="drill.due", at=now, detail={"dueExpiresAt": expiry})
    return {"status": "due", "drillId": drill_id}


def refusal_reason(drill: dict[str, Any], member: dict[str, Any] | None) -> str | None:
    """None when the drill may ring. Otherwise the reason it may not."""
    member_id = _s(drill, "memberId") or ""

    status = _s(member, "status") if member else None
    if status != "active":
        return REASON_PAUSED if status == "paused" else REASON_NOT_CONSENTED

    if not has_live_consent(member_id):
        return REASON_NOT_CONSENTED

    if not is_inside(load_window(member_id), clock_now()):
        return REASON_OUTSIDE_WINDOW

    return None


def handler(event_payload: dict, context: object) -> dict:
    """Scheduler's target. Every path returns a dict; none of them raise for an expected outcome."""
    del context
    drill_id, member_id = parse_ring_event(event_payload)

    drill = find_drill(member_id, drill_id)
    if drill is None:
        # The row is gone (expired invite cleanup, a hand edit, the wrong member id). Retrying
        # will not conjure it, so the schedule's work is done.
        event("ring.drill_missing", drill_id, level=logging.WARNING, memberId=member_id)
        return {"status": "gone"}

    state = _s(drill, "state") or "unknown"
    if state != "scheduled":
        # The ordinary case for a drill cancelled a second before its schedule fired. Not an error.
        event("ring.not_scheduled", drill_id, state=state)
        return {"status": "not_scheduled", "state": state}

    household_id = _s(drill, "householdId") or ""
    member = member_row(household_id, member_id)
    reason = refusal_reason(drill, member)
    if reason is not None:
        return cancel_drill(drill, reason)

    rung = mark_due(drill)
    if rung is None:
        return {"status": "not_scheduled"}

    display_name = _s(member or {}, "displayName") or "Your family member"
    email_status = try_send_due_email(drill_id=drill_id, household_id=household_id, display_name=display_name)

    event("ring.due", drill_id, memberId=member_id, email=email_status)
    return {"status": "due", "drillId": drill_id}

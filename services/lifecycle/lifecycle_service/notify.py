"""The guardian nudge.

One email, to one address: the guardian's, taken from the household row's `ownerEmail`, which is
the Google address they signed in with and which Google has already verified. There is
deliberately no learner email anywhere in this product. The learner has no account, no password
and no inbox to check (PRD: "The learner never needs a password, an email client, or an app
store"); they are told about the drill in the app, by the guardian, or not at all.

The email is a nudge, not the product. It carries the member's display name and a link to the
app, and nothing else: no drill id, no transcript, no scenario, no red flags. Anything a guardian
should read about a drill they read behind their own login.

Sending is best effort by design. Until someone verifies an SES identity, `SENDER_EMAIL` is
unset and every ring skips the email with one log line. A ring is not allowed to fail because a
nudge did not go out; in-app polling is the primary path.
"""

from __future__ import annotations

import logging
import os

from .aws import ddb, sesv2, table_name
from .keys import household_keys
from .log import event

SUBJECT = "Practice call ready"


def body_text(display_name: str, app_url: str) -> str:
    return (
        f"{display_name} has a practice scam call waiting, and it stays open for the next half hour.\n\n"
        f"{app_url.rstrip('/')}/app\n"
    )


def owner_email(household_id: str) -> str | None:
    """The guardian's address off the household row, or None when the row predates it."""
    out = ddb().get_item(
        TableName=table_name(),
        Key={k: {"S": v} for k, v in household_keys(household_id).items()},
        ConsistentRead=True,
        ProjectionExpression="ownerEmail",
    )
    value = out.get("Item", {}).get("ownerEmail", {}).get("S")
    return value or None


def send_due_email(*, drill_id: str, household_id: str, display_name: str) -> str:
    """Returns a short status for the caller's log line. Never raises: the caller is mid-ring and
    the drill is already `due`."""
    sender = os.environ.get("SENDER_EMAIL", "").strip()
    if not sender:
        event("ring.email_skipped", drill_id, reason="no_sender")
        return "no_sender"

    recipient = owner_email(household_id)
    if not recipient:
        event("ring.email_skipped", drill_id, reason="no_owner_email")
        return "no_owner_email"

    app_url = os.environ.get("APP_URL", "").strip() or "https://chaukanna.app"
    sesv2().send_email(
        FromEmailAddress=sender,
        Destination={"ToAddresses": [recipient]},
        Content={
            "Simple": {
                "Subject": {"Data": SUBJECT, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": body_text(display_name, app_url), "Charset": "UTF-8"}},
            }
        },
    )
    event("ring.email_sent", drill_id)
    return "sent"


def try_send_due_email(*, drill_id: str, household_id: str, display_name: str) -> str:
    """`send_due_email` with the failure swallowed. Logged at warning, and the address itself is
    never in the log line."""
    try:
        return send_due_email(drill_id=drill_id, household_id=household_id, display_name=display_name)
    except Exception as error:  # noqa: BLE001 - a nudge must never fail a ring
        event("ring.email_failed", drill_id, level=logging.WARNING, errorName=type(error).__name__)
        return "failed"

"""The last task: write the SCORE row, move the drill out of `ended`, log the event.

One entry point, three shapes, because the state machine catches every task failure to the same
place:

1. **Success.** `$.score` and `$.debrief` are both present -> `scored`, with audio.
2. **Pre debrief failure** (redact, judge or score). No `$.score` -> `score_failed`. The learner
   is shown the generic debrief; never a guessed number.
3. **Debrief failure.** `$.score` is present and `$.failure` names the debrief task -> still
   `scored`, with no audio key. A real score is not thrown away because text to speech failed.

So the rule is simply: a score present means `scored`. The drill transition is a conditional
update naming the state it expects (`ended`), the Phase 4 rule, so a replayed execution cannot
score a drill twice or resurrect a cancelled one.
"""

from __future__ import annotations

import logging
from typing import Any

from botocore.exceptions import ClientError

from .log import event, utc_now_iso

SCORED = "scored"
SCORE_FAILED = "score_failed"
EXPECTED_STATE = "ended"


class FinishError(Exception):
    """The drill row was not in the state this transition expects."""


def score_keys(drill_id: str) -> dict[str, str]:
    return {"pk": f"DRILL#{drill_id}", "sk": "SCORE"}


def drill_keys(member_id: str, scheduled_at: str, drill_id: str) -> dict[str, str]:
    return {"pk": f"MEMBER#{member_id}", "sk": f"DRILL#{scheduled_at}#{drill_id}"}


def lifecycle_event_keys(drill_id: str, at: str, name: str) -> dict[str, str]:
    """Same format as `services/lifecycle/lifecycle_service/keys.py`: an ISO timestamp can never
    collide with the agent's zero padded `EVT#000004` sequence."""
    return {"pk": f"DRILL#{drill_id}", "sk": f"EVT#{at}#{name}"}


def _s(value: Any) -> dict[str, str] | None:
    """A DynamoDB string attribute, or `None` when there is nothing to say.

    Blank values are omitted rather than written as `{"S": ""}`, because an empty string is not
    the same claim as an absent one. The web app parses this row strictly, so a written `""`
    would force it to special case every optional field — and a blank `scheduledAt` or
    `language` is not merely empty, it fails validation and takes the learner's whole debrief
    screen down with it. Say nothing rather than saying "".
    """
    text = "" if value is None else str(value)
    return {"S": text} if text else None


def _entries(group: dict[str, Any] | None) -> dict[str, Any]:
    """`{id: {fired, evidence}}` as a DynamoDB map. Evidence follows the same rule as `_s`."""
    return {
        "M": {
            entry_id: {
                "M": {
                    "fired": {"BOOL": bool(entry.get("fired"))},
                    **({"evidence": evidence} if (evidence := _s(entry.get("evidence"))) else {}),
                }
            }
            for entry_id, entry in (group or {}).items()
        }
    }


def build_score_item(event_body: dict[str, Any], *, status: str, now: str) -> dict[str, Any]:
    judgement = event_body.get("judgement") or {}
    score = event_body.get("score") or {}
    debrief = event_body.get("debrief") or {}
    redaction = event_body.get("redaction") or {}
    failure = event_body.get("failure") or {}
    drill_id = str(event_body["drillId"])

    optional = {
        "memberId": _s(event_body.get("memberId")),
        "householdId": _s(event_body.get("householdId")),
        "scheduledAt": _s(event_body.get("scheduledAt")),
        "language": _s(event_body.get("language")),
        "turningPoint": _s(judgement.get("turningPoint")),
        "debriefText": _s(debrief.get("text")),
        "rubricVersion": _s(score.get("rubricVersion")),
        "judgePromptVersion": _s(judgement.get("promptVersion")),
        "debriefPromptVersion": _s(debrief.get("promptVersion")),
        "judgeModelId": _s(judgement.get("modelId")),
        "debriefModelId": _s(debrief.get("modelId")),
        "guardrailId": _s(event_body.get("guardrailId")),
        "guardrailVersion": _s(event_body.get("guardrailVersion")),
        # The key to the redacted transcript. Kept for an operator tracing a score back to what
        # produced it; the web app deliberately does not declare it, so it is stripped on read
        # and can never reach a page or a browser.
        "redactedKey": _s(redaction.get("redactedKey")),
    }
    item: dict[str, Any] = {
        **{key: {"S": value} for key, value in score_keys(drill_id).items()},
        "entity": {"S": "Score"},
        "drillId": {"S": drill_id},
        "status": {"S": status},
        "flags": _entries(judgement.get("flags")),
        "credits": _entries(judgement.get("credits")),
        **{name: value for name, value in optional.items() if value is not None},
        "createdAt": {"S": now},
        # No ttl, deliberately: PRD 8.6 keeps scores while audio and transcripts expire.
    }
    if status == SCORED:
        item["score"] = {"N": str(int(score["score"]))}
        item["band"] = {"S": str(score["band"])}
    if debrief.get("audioKey"):
        item["debriefAudioKey"] = {"S": str(debrief["audioKey"])}
        if voice := _s(debrief.get("voiceId")):
            item["debriefVoiceId"] = voice
    if failure:
        item["failureReason"] = {"S": f"{failure.get('task', 'unknown')}: {failure.get('reason') or ''!s}"[:400]}
    return item


def _transition(ddb: Any, table: str, event_body: dict[str, Any], *, status: str, now: str) -> None:
    drill_id = str(event_body["drillId"])
    keys = drill_keys(
        str(event_body.get("memberId") or ""),
        str(event_body.get("scheduledAt") or ""),
        drill_id,
    )
    try:
        ddb.update_item(
            TableName=table,
            Key={key: {"S": value} for key, value in keys.items()},
            UpdateExpression="SET #state = :next, gsi1pk = :gsi1pk, scoredAt = :now, updatedAt = :now",
            ConditionExpression="attribute_exists(pk) AND #state = :expected",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":next": {"S": status},
                ":gsi1pk": {"S": f"STATE#{status}"},
                ":expected": {"S": EXPECTED_STATE},
                ":now": {"S": now},
            },
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise FinishError(f"drill {drill_id} was not in state {EXPECTED_STATE}") from error
        raise


def _write_event(ddb: Any, table: str, event_body: dict[str, Any], *, status: str, now: str) -> None:
    drill_id = str(event_body["drillId"])
    name = f"drill.{status}"
    score = event_body.get("score") or {}
    item: dict[str, Any] = {
        **{key: {"S": value} for key, value in lifecycle_event_keys(drill_id, now, name).items()},
        "entity": {"S": "DrillEvent"},
        "drillId": {"S": drill_id},
        "ts": {"S": now},
        "type": {"S": name},
        "source": {"S": "scoring"},
    }
    if status == SCORED and (band := _s(score.get("band"))):
        item["band"] = band
    ddb.put_item(TableName=table, Item=item)


def run(event_body: dict[str, Any], *, ddb: Any, table: str, now: str | None = None) -> dict[str, Any]:
    """Returns `{"status": "scored"|"score_failed"}`."""
    drill_id = str(event_body["drillId"])
    now = now or utc_now_iso()
    score = event_body.get("score") or {}
    status = SCORED if score.get("score") is not None and score.get("band") else SCORE_FAILED
    failure = event_body.get("failure") or {}

    ddb.put_item(TableName=table, Item=build_score_item(event_body, status=status, now=now))
    _transition(ddb, table, event_body, status=status, now=now)
    _write_event(ddb, table, event_body, status=status, now=now)
    event(
        "drill_finished",
        drill_id,
        status=status,
        band=score.get("band"),
        failedTask=failure.get("task"),
        hasAudio=bool((event_body.get("debrief") or {}).get("audioKey")),
        level=logging.WARNING if failure else logging.INFO,
    )
    return {"status": status}

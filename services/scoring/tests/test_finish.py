"""finish's three entry shapes: success, a pre debrief failure, and a debrief only failure."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import DRILL_ID, HOUSEHOLD_ID, MEMBER_ID, SCHEDULED_AT, FakeDdb, drill_item

from scoring_service.finish import SCORE_FAILED, SCORED, FinishError, run

TABLE = "chaukanna-test"


def base(**extra: Any) -> dict[str, Any]:
    return {
        "drillId": DRILL_ID,
        "memberId": MEMBER_ID,
        "householdId": HOUSEHOLD_ID,
        "scheduledAt": SCHEDULED_AT,
        "language": "hi-IN",
        "guardrailId": "gr-test",
        "guardrailVersion": "DRAFT",
        "redaction": {"redactedKey": f"drill/redacted/{DRILL_ID}.json"},
        "judgement": {
            "flags": {"stayed_on_call": {"fired": True, "evidence": "haan ji"}},
            "credits": {"named_helpline": {"fired": False, "evidence": ""}},
            "turningPoint": "Yeh matter cyber cell ke paas hai.",
            "promptVersion": "score.judge.v2",
            "modelId": "judge-model",
        },
        **extra,
    }


def success() -> dict[str, Any]:
    return base(
        score={"score": 25, "band": "at_risk", "rubricVersion": "prd.v1"},
        debrief={
            "text": "Aapne achha kiya.",
            "audioKey": f"debrief/{DRILL_ID}.mp3",
            "voiceId": "Kajal",
            "promptVersion": "debrief.writer.v1",
            "modelId": "debrief-model",
        },
    )


def score_row(ddb: FakeDdb) -> dict[str, Any]:
    return next(item for item in ddb.puts if item["sk"]["S"] == "SCORE")


def event_row(ddb: FakeDdb) -> dict[str, Any]:
    return next(item for item in ddb.puts if item["sk"]["S"].startswith("EVT#"))


# --- 1. success ------------------------------------------------------------------------------


def test_success_writes_the_score_row(ddb: FakeDdb) -> None:
    assert run(success(), ddb=ddb, table=TABLE) == {"status": SCORED}
    row = score_row(ddb)
    assert row["pk"]["S"] == f"DRILL#{DRILL_ID}"
    assert row["entity"]["S"] == "Score"
    assert row["status"]["S"] == SCORED
    assert row["score"]["N"] == "25"
    assert row["band"]["S"] == "at_risk"
    assert row["flags"]["M"]["stayed_on_call"]["M"]["fired"]["BOOL"] is True
    assert row["turningPoint"]["S"].startswith("Yeh matter")
    assert row["debriefAudioKey"]["S"] == f"debrief/{DRILL_ID}.mp3"
    assert row["debriefVoiceId"]["S"] == "Kajal"
    assert row["rubricVersion"]["S"] == "prd.v1"
    assert row["judgePromptVersion"]["S"] == "score.judge.v2"
    assert row["debriefPromptVersion"]["S"] == "debrief.writer.v1"
    assert row["guardrailId"]["S"] == "gr-test"
    assert "failureReason" not in row


def test_the_score_row_has_no_ttl(ddb: FakeDdb) -> None:
    """PRD 8.6: audio expires, transcripts expire, scores are kept."""
    run(success(), ddb=ddb, table=TABLE)
    assert "ttl" not in score_row(ddb)


def test_success_transitions_the_drill_conditionally(ddb: FakeDdb) -> None:
    run(success(), ddb=ddb, table=TABLE)
    update = ddb.updates[0]
    assert update["Key"]["sk"]["S"] == f"DRILL#{SCHEDULED_AT}#{DRILL_ID}"
    assert update["ExpressionAttributeValues"][":expected"]["S"] == "ended"
    assert update["ExpressionAttributeValues"][":next"]["S"] == SCORED
    assert update["ExpressionAttributeValues"][":gsi1pk"]["S"] == "STATE#scored"
    assert "#state = :expected" in update["ConditionExpression"]


def test_success_writes_a_lifecycle_event(ddb: FakeDdb) -> None:
    run(success(), ddb=ddb, table=TABLE)
    row = event_row(ddb)
    assert row["type"]["S"] == "drill.scored"
    assert row["band"]["S"] == "at_risk"
    assert row["sk"]["S"].startswith("EVT#20"), "an ISO event key cannot collide with EVT#000004"


# --- 2. a pre debrief failure ----------------------------------------------------------------


def test_a_judge_failure_is_score_failed(ddb: FakeDdb) -> None:
    body = base(failure={"task": "judge", "reason": "JudgeUnparseable"})
    assert run(body, ddb=ddb, table=TABLE) == {"status": SCORE_FAILED}
    row = score_row(ddb)
    assert row["status"]["S"] == SCORE_FAILED
    assert "score" not in row and "band" not in row, "never show a guessed number"
    assert row["failureReason"]["S"].startswith("judge: ")
    assert ddb.updates[0]["ExpressionAttributeValues"][":next"]["S"] == SCORE_FAILED
    assert event_row(ddb)["type"]["S"] == "drill.score_failed"


def test_a_redaction_failure_is_score_failed(ddb: FakeDdb) -> None:
    body = {
        "drillId": DRILL_ID,
        "memberId": MEMBER_ID,
        "scheduledAt": SCHEDULED_AT,
        "failure": {"task": "redact", "reason": "RedactionError"},
    }
    assert run(body, ddb=ddb, table=TABLE) == {"status": SCORE_FAILED}
    row = score_row(ddb)
    assert row["flags"]["M"] == {}
    # A field the pipeline never produced is absent, not `{"S": ""}`. The web app parses this row
    # strictly, and a blank `scheduledAt` or `language` fails validation and takes the learner's
    # whole debrief screen down with it, so "say nothing" has to mean writing nothing.
    for absent in ("debriefText", "turningPoint", "language", "debriefAudioKey", "band", "score"):
        assert absent not in row, f"{absent} should be omitted, not blank"
    assert row["scheduledAt"]["S"] == SCHEDULED_AT


# --- 3. a debrief only failure ---------------------------------------------------------------


def test_a_debrief_failure_keeps_the_score(ddb: FakeDdb) -> None:
    body = base(
        score={"score": 25, "band": "at_risk", "rubricVersion": "prd.v1"},
        failure={"task": "debrief", "reason": "polly threw"},
    )
    assert run(body, ddb=ddb, table=TABLE) == {"status": SCORED}
    row = score_row(ddb)
    assert row["status"]["S"] == SCORED
    assert row["score"]["N"] == "25"
    assert "debriefAudioKey" not in row, "no audio, but the band survives"
    assert row["failureReason"]["S"].startswith("debrief: ")
    assert ddb.updates[0]["ExpressionAttributeValues"][":gsi1pk"]["S"] == "STATE#scored"


# --- the conditional update ------------------------------------------------------------------


def test_a_drill_that_is_not_ended_refuses_the_transition(ddb: FakeDdb) -> None:
    ddb.put(drill_item(state="cancelled"))
    with pytest.raises(FinishError):
        run(success(), ddb=ddb, table=TABLE)


def test_a_second_execution_cannot_score_the_same_drill_twice(ddb: FakeDdb) -> None:
    run(success(), ddb=ddb, table=TABLE)
    with pytest.raises(FinishError):
        run(success(), ddb=ddb, table=TABLE)


def test_a_missing_drill_id_is_a_key_error(ddb: FakeDdb) -> None:
    with pytest.raises(KeyError):
        run({"memberId": MEMBER_ID}, ddb=ddb, table=TABLE)

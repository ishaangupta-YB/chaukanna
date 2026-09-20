"""What a finished drill writes, pinned with botocore's own stubber.

The stubber validates every request against the real DynamoDB and S3 service models, so a
malformed key, a bad expression parameter or a wrong type fails here rather than on the first
learner's call. What it cannot check is meaning, so the assertions below read the requests back.
"""

from __future__ import annotations

import io
import json
import logging
import wave

import pytest
from botocore.exceptions import EndpointConnectionError
from botocore.stub import Stubber

from chaukanna_agent.audio import SAMPLE_RATE, silence
from chaukanna_agent.session import DrillRecord, DrillSession
from chaukanna_agent.store import (
    DrillClaimError,
    DrillStore,
    audio_key,
    pcm_to_wav,
    scoring_execution_name,
    transcript_key,
    worth_scoring,
)

DRILL_ID = "d1e2f3a4b5c6"
MEMBER_ID = "abcdef012345"
HOUSEHOLD_ID = "012345abcdef"
SCHEDULED_AT = "2026-09-20T11:30:00.000Z"


@pytest.fixture
def store() -> DrillStore:
    return DrillStore(region="ap-south-1", table_name="chaukanna-test", bucket="bucket-test")


@pytest.fixture
def record() -> DrillRecord:
    session = DrillSession(
        drill_id=DRILL_ID,
        scenario_id="digital_arrest_v1",
        scenario_version=1,
        language="hi-IN",
        voice="arjun",
        prompt_versions={"persona": "drill.persona.v1"},
        max_seconds=360,
    )
    session.advance_stage("S1")
    session.record_red_flag("accepted_authority", "हाँ जी इंस्पेक्टर साहब")
    session.add_caller_text("मैं कूरियर सेवा से बोल रहा हूँ")
    session.add_learner_text("कौन बोल रहा है")
    session.end("completed", source="model")
    return session.to_record()


# ---- audio -------------------------------------------------------------------------------------


def test_wav_header_matches_the_pipeline() -> None:
    """A sample rate mismatch here produces audio that exists and sounds wrong, which is the
    slowest bug in this whole project to notice."""
    with wave.open(io.BytesIO(pcm_to_wav(silence(0.5))), "rb") as out:
        assert out.getframerate() == SAMPLE_RATE
        assert out.getnchannels() == 1
        assert out.getsampwidth() == 2
        assert out.getnframes() == SAMPLE_RATE // 2


def test_keys_land_under_the_prefixes_their_lifetimes_are_set_on() -> None:
    """Audio expires in 7 days and transcripts in 30, and S3 lifecycle rules are per prefix."""
    assert audio_key(DRILL_ID).startswith("drill/audio/")
    assert transcript_key(DRILL_ID).startswith("drill/transcript/")


# ---- before the call ---------------------------------------------------------------------------


def test_an_active_member_passes(store: DrillStore) -> None:
    with Stubber(store._ddb) as ddb:
        ddb.add_response("get_item", {"Item": {"status": {"S": "active"}}})
        store.assert_member_active(HOUSEHOLD_ID, MEMBER_ID)


@pytest.mark.parametrize("item", [{"Item": {"status": {"S": "paused"}}}, {"Item": {"status": {"S": "revoked"}}}, {}])
def test_anything_but_active_refuses_the_call(store: DrillStore, item: dict[str, object]) -> None:
    with Stubber(store._ddb) as ddb:
        ddb.add_response("get_item", item)
        with pytest.raises(DrillClaimError) as raised:
            store.assert_member_active(HOUSEHOLD_ID, MEMBER_ID)
    assert raised.value.code == "not_consented"


def test_claim_is_valid_against_the_service_model(store: DrillStore) -> None:
    with Stubber(store._ddb) as ddb:
        ddb.add_response("update_item", {})
        store.claim(member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, drill_id=DRILL_ID, jti="jti-123456")
        ddb.assert_no_pending_responses()


def test_claim_addresses_the_right_row_and_only_succeeds_once(store: DrillStore) -> None:
    """Three things have to hold for the write to land: the row exists, it is still waiting for a
    session, and it is waiting for *this* token. Drop any one and a leaked token buys a call."""
    seen: dict[str, object] = {}

    def capture(**kwargs: object) -> dict[str, object]:
        seen.update(kwargs)
        return {}

    store._ddb.update_item = capture  # type: ignore[method-assign]
    store.claim(member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, drill_id=DRILL_ID, jti="jti-123456")

    assert seen["Key"] == {"pk": {"S": f"MEMBER#{MEMBER_ID}"}, "sk": {"S": f"DRILL#{SCHEDULED_AT}#{DRILL_ID}"}}
    assert seen["ConditionExpression"] == "attribute_exists(pk) AND #state = :pending AND sessionJti = :jti"
    values = seen["ExpressionAttributeValues"]
    assert values[":pending"] == {"S": "session_pending"}  # type: ignore[index]
    assert values[":jti"] == {"S": "jti-123456"}  # type: ignore[index]
    # The claim also consumes the token, so a replay has nothing left to match on.
    assert "REMOVE sessionJti" in str(seen["UpdateExpression"])


def test_a_lost_claim_becomes_drill_unavailable(store: DrillStore) -> None:
    """Two browsers, one token. The one that loses the conditional write gets no call."""
    with Stubber(store._ddb) as ddb:
        ddb.add_client_error("update_item", service_error_code="ConditionalCheckFailedException", http_status_code=400)
        with pytest.raises(DrillClaimError) as raised:
            store.claim(member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, drill_id=DRILL_ID, jti="jti-123456")
    assert raised.value.code == "drill_unavailable"


def test_other_dynamodb_errors_are_not_swallowed(store: DrillStore) -> None:
    with Stubber(store._ddb) as ddb:
        ddb.add_client_error("update_item", service_error_code="ProvisionedThroughputExceededException")
        with pytest.raises(Exception) as raised:
            store.claim(member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, drill_id=DRILL_ID, jti="jti-123456")
    assert not isinstance(raised.value, DrillClaimError)


# ---- after the call ----------------------------------------------------------------------------


def test_finish_writes_audio_transcript_events_and_the_row(store: DrillStore, record: DrillRecord) -> None:
    with Stubber(store._s3) as s3, Stubber(store._ddb) as ddb:
        s3.add_response("put_object", {})
        s3.add_response("put_object", {})
        ddb.add_response("batch_write_item", {"UnprocessedItems": {}})
        ddb.add_response("update_item", {})
        store.finish(record, member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, caller_pcm=silence(0.2))
        s3.assert_no_pending_responses()
        ddb.assert_no_pending_responses()


def test_a_call_with_no_caller_audio_still_persists(store: DrillStore, record: DrillRecord) -> None:
    """The model never connected, or the learner hung up in the first second. The drill still ends
    in the table rather than sitting `in_progress` forever."""
    with Stubber(store._s3) as s3, Stubber(store._ddb) as ddb:
        s3.add_response("put_object", {})  # transcript only
        ddb.add_response("batch_write_item", {"UnprocessedItems": {}})
        ddb.add_response("update_item", {})
        store.finish(record, member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, caller_pcm=b"")
        s3.assert_no_pending_responses()


def test_the_drill_row_carries_flag_ids_but_never_a_quote(store: DrillStore, record: DrillRecord) -> None:
    """A guardian may read a band, never a transcript (PRD F7 AC2). The quote stays in S3."""
    assert record.redFlags[0].quote  # the record itself keeps it
    seen: dict[str, object] = {}

    def capture(**kwargs: object) -> dict[str, object]:
        seen.update(kwargs)
        return {}

    store._ddb.update_item = capture  # type: ignore[method-assign]
    store._update_drill(record, member_id=MEMBER_ID, scheduled_at=SCHEDULED_AT, artifacts={})
    body = json.dumps(seen, default=str, ensure_ascii=False)
    assert "accepted_authority" in body
    assert "इंस्पेक्टर" not in body


def test_events_are_batched_with_a_ttl(store: DrillStore, record: DrillRecord) -> None:
    batches: list[dict[str, object]] = []

    def capture(**kwargs: object) -> dict[str, object]:
        batches.append(kwargs)
        return {"UnprocessedItems": {}}

    store._ddb.batch_write_item = capture  # type: ignore[method-assign]
    store._put_events(record)
    items = [r["PutRequest"]["Item"] for batch in batches for r in batch["RequestItems"]["chaukanna-test"]]  # type: ignore[index]
    assert len(items) == len(record.events)
    assert all(item["pk"]["S"] == f"DRILL#{DRILL_ID}" for item in items)
    assert all(int(item["ttl"]["N"]) > 0 for item in items)
    assert [item["sk"]["S"] for item in items] == sorted(item["sk"]["S"] for item in items), "sort keys must order"


# ---- handing the drill to scoring ----------------------------------------------------------------

SCORING_ARN = "arn:aws:states:ap-south-1:123456789012:stateMachine:chaukanna-scoring"


@pytest.fixture
def scoring_store() -> DrillStore:
    return DrillStore(
        region="ap-south-1",
        table_name="chaukanna-test",
        bucket="bucket-test",
        scoring_state_machine_arn=SCORING_ARN,
    )


@pytest.fixture
def logged(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, object]]]:
    """Captures the structured lines `store` emits, so an outcome can be asserted by name."""
    lines: list[tuple[str, dict[str, object]]] = []

    def capture(name: str, drill_id: str, level: int = 0, **fields: object) -> None:
        lines.append((name, {"drillId": drill_id, "level": level, **fields}))

    monkeypatch.setattr("chaukanna_agent.store.event", capture)
    return lines


def start(store: DrillStore, record: DrillRecord) -> str | None:
    return store.start_scoring(
        record,
        member_id=MEMBER_ID,
        scheduled_at=SCHEDULED_AT,
        household_id=HOUSEHOLD_ID,
        transcript_key=transcript_key(record.drillId),
    )


def make_record(end_reason: str, *, learner_said: str | None = None) -> DrillRecord:
    session = DrillSession(
        drill_id=DRILL_ID,
        scenario_id="digital_arrest_v1",
        scenario_version=1,
        language="hi-IN",
        voice="arjun",
        prompt_versions={"persona": "drill.persona.v1", "kickoff": "drill.kickoff.v1"},
        max_seconds=360,
    )
    session.add_caller_text("मैं कूरियर सेवा से बोल रहा हूँ")
    if learner_said is not None:
        session.add_learner_text(learner_said)
    session.end(end_reason, source="test")  # type: ignore[arg-type]
    return session.to_record()


def test_the_step_functions_client_is_built_for_the_data_region(scoring_store: DrillStore) -> None:
    """The state machine lives beside the table, not beside the model. Reading AWS_REGION inside
    AgentCore would point this at ap-northeast-1 and fail only on a real learner's call."""
    assert scoring_store._sfn is not None
    assert scoring_store._sfn.meta.region_name == "ap-south-1"
    assert scoring_store._sfn.meta.region_name == scoring_store._ddb.meta.region_name


def test_no_state_machine_means_one_log_line_and_no_call(
    store: DrillStore, record: DrillRecord, logged: list[tuple[str, dict[str, object]]]
) -> None:
    """A local drill and a dev container have nothing behind them and must still run the call."""
    assert store._sfn is None
    assert start(store, record) is None
    assert [name for name, _ in logged] == ["drill_scoring_not_configured"]


def test_the_execution_input_matches_the_phase_5_contract(scoring_store: DrillStore, record: DrillRecord) -> None:
    """Field for field. The state machine reads this object and nothing else about the drill."""
    seen: dict[str, object] = {}

    def capture(**kwargs: object) -> dict[str, object]:
        seen.update(kwargs)
        return {"executionArn": "arn:aws:states:ap-south-1:1:execution:chaukanna-scoring:drill-x"}

    scoring_store._sfn.start_execution = capture  # type: ignore[union-attr]
    start(scoring_store, record)

    assert seen["stateMachineArn"] == SCORING_ARN
    assert json.loads(str(seen["input"])) == {
        "drillId": DRILL_ID,
        "memberId": MEMBER_ID,
        "householdId": HOUSEHOLD_ID,
        "scheduledAt": SCHEDULED_AT,
        "language": "hi-IN",
        "transcriptKey": f"drill/transcript/{DRILL_ID}.json",
        "endReason": "completed",
        "finalStage": "S1",
        "scenarioId": "digital_arrest_v1",
        "scenarioVersion": 1,
        "promptVersions": {"persona": "drill.persona.v1"},
    }


def test_the_execution_is_named_after_the_drill(scoring_store: DrillStore, record: DrillRecord) -> None:
    """The name is the whole idempotency story: a second start for the same drill is refused by
    Step Functions rather than scoring the same call twice."""
    seen: dict[str, object] = {}

    def capture(**kwargs: object) -> dict[str, object]:
        seen.update(kwargs)
        return {"executionArn": "arn:aws:states:ap-south-1:1:execution:chaukanna-scoring:x"}

    scoring_store._sfn.start_execution = capture  # type: ignore[union-attr]
    start(scoring_store, record)
    assert seen["name"] == f"drill-{DRILL_ID}"
    assert seen["name"] == scoring_execution_name(DRILL_ID)


def test_the_request_is_valid_against_the_step_functions_service_model(
    scoring_store: DrillStore, record: DrillRecord
) -> None:
    """The stubber checks the shape the real API would; the assertions above check the meaning."""
    with Stubber(scoring_store._sfn) as sfn:  # type: ignore[arg-type]
        sfn.add_response(
            "start_execution",
            {"executionArn": "arn:aws:states:ap-south-1:1:execution:chaukanna-scoring:x", "startDate": "2026-09-20"},
        )
        assert start(scoring_store, record) is not None
        sfn.assert_no_pending_responses()


def test_an_already_running_execution_is_a_normal_outcome(
    scoring_store: DrillStore, record: DrillRecord, logged: list[tuple[str, dict[str, object]]]
) -> None:
    """A reconnect or a replayed finish must not look like a failure: the drill is already being
    scored, which is exactly what we wanted."""
    with Stubber(scoring_store._sfn) as sfn:  # type: ignore[arg-type]
        sfn.add_client_error("start_execution", service_error_code="ExecutionAlreadyExists", http_status_code=400)
        assert start(scoring_store, record) is None
    names = [name for name, _ in logged]
    assert names == ["drill_scoring_already_started"]
    assert all(fields["level"] == 0 for _, fields in logged), "not a warning; the drill is fine"


def test_any_other_failure_is_logged_and_never_raised(
    scoring_store: DrillStore, record: DrillRecord, logged: list[tuple[str, dict[str, object]]]
) -> None:
    """An unscored drill is degraded, not broken. The learner has already been told goodbye."""
    with Stubber(scoring_store._sfn) as sfn:  # type: ignore[arg-type]
        sfn.add_client_error("start_execution", service_error_code="AccessDeniedException", http_status_code=403)
        assert start(scoring_store, record) is None
    assert [name for name, _ in logged] == ["drill_scoring_start_failed"]
    assert logged[0][1]["level"] == logging.WARNING
    assert logged[0][1]["drillId"] == DRILL_ID


def test_a_non_client_error_is_swallowed_too(
    scoring_store: DrillStore, record: DrillRecord, logged: list[tuple[str, dict[str, object]]]
) -> None:
    def explode(**_kwargs: object) -> dict[str, object]:
        raise EndpointConnectionError(endpoint_url="https://states.ap-south-1.amazonaws.com/")

    scoring_store._sfn.start_execution = explode  # type: ignore[union-attr]
    assert start(scoring_store, record) is None
    assert [name for name, _ in logged] == ["drill_scoring_start_failed"]


# ---- which endings are worth scoring -------------------------------------------------------------


def test_an_immediate_hangup_is_scored_even_with_no_learner_turn() -> None:
    """The rubric's largest credit is `disconnected_early`. A learner who hangs up at once did the
    best possible thing, and skipping them would deny a debrief to exactly the right behaviour."""
    assert worth_scoring(make_record("hangup"))


@pytest.mark.parametrize("reason", ["completed", "safe_word", "is_this_real", "distress", "tripwire", "timeout"])
def test_every_real_ending_is_scored(reason: str) -> None:
    assert worth_scoring(make_record(reason))


def test_a_drill_that_broke_before_the_learner_spoke_is_not_scored() -> None:
    """The socket died during the handshake or the model never connected. There is no behaviour to
    judge, and a band invented from an empty transcript is worse than no band."""
    assert not worth_scoring(make_record("error"))


def test_a_drill_that_broke_after_the_learner_spoke_is_still_scored() -> None:
    """A dropped socket halfway through is a partial transcript, not an empty one."""
    assert worth_scoring(make_record("error", learner_said="कौन बोल रहा है"))


def test_a_drill_not_worth_scoring_starts_nothing(
    scoring_store: DrillStore, logged: list[tuple[str, dict[str, object]]]
) -> None:
    def explode(**_kwargs: object) -> dict[str, object]:
        raise AssertionError("start_execution must not be called for an empty drill")

    scoring_store._sfn.start_execution = explode  # type: ignore[union-attr]
    assert start(scoring_store, make_record("error")) is None
    assert [name for name, _ in logged] == ["drill_scoring_skipped"]

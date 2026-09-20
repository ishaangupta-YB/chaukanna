"""The fixture converter, over all ten fixtures, and the DrillRecord parser."""

from __future__ import annotations

import json

import pytest
from conftest import FakeS3, fixture_names, load_fixture

from scoring_service.transcript import (
    STAGES,
    TranscriptError,
    from_fixture,
    from_record,
    load_transcript,
)

FIXTURES = fixture_names()


def test_there_are_ten_fixtures() -> None:
    assert len(FIXTURES) == 10


@pytest.mark.parametrize("name", FIXTURES)
def test_every_fixture_converts(name: str) -> None:
    transcript = from_fixture(load_fixture(name))
    assert transcript.lines, f"{name} produced no transcript lines"
    assert all(line.role in ("caller", "learner") for line in transcript.lines)
    assert [line.seq for line in transcript.lines] == list(range(1, len(transcript.lines) + 1))
    assert all(line.stage in STAGES for line in transcript.lines)
    assert all(line.text.strip() for line in transcript.lines)


@pytest.mark.parametrize("name", FIXTURES)
def test_replayed_stage_walk_matches_the_fixtures_own_expectation(name: str) -> None:
    """The fixtures assert a `finalStage` that already accounts for the refusals the session
    makes (no skipping, no going back). If this drifts, the converter is not replaying what the
    agent would have done."""
    fixture = load_fixture(name)
    assert from_fixture(fixture).finalStage == fixture["expect"]["finalStage"]


@pytest.mark.parametrize("name", FIXTURES)
def test_red_flags_match_the_fixtures_own_expectation(name: str) -> None:
    fixture = load_fixture(name)
    recorded = sorted({flag.id for flag in from_fixture(fixture).redFlags})
    assert recorded == sorted(set(fixture["expect"]["redFlags"]))


@pytest.mark.parametrize("name", FIXTURES)
def test_end_reason_matches_the_fixtures_own_expectation(name: str) -> None:
    fixture = load_fixture(name)
    assert from_fixture(fixture).endReason == fixture["expect"]["endReason"]


def test_a_refused_stage_skip_does_not_advance() -> None:
    """compliant asks for S4 while at S2, then S3. The skip is refused, the step is not."""
    transcript = from_fixture(load_fixture("compliant"))
    assert transcript.finalStage == "S5"


def test_rendered_carries_role_and_stage() -> None:
    rendered = from_fixture(load_fixture("polite_refusal")).rendered()
    assert rendered.startswith("[S0] caller: ")
    assert "[S0] learner: " in rendered


def test_from_record_parses_a_drill_record_dump() -> None:
    record = {
        "drillId": "d1",
        "language": "hi-IN",
        "scenarioId": "digital_arrest_v1",
        "scenarioVersion": 1,
        "endReason": "completed",
        "finalStage": "S5",
        "durationSeconds": 42.5,
        "redFlags": [{"id": "stayed_on_call", "quote": "haan ji", "stage": "S1", "seq": 2}],
        "transcript": [
            {"seq": 1, "t": 0.5, "role": "caller", "stage": "S0", "text": "Namaste"},
            {"seq": 2, "t": 1.5, "role": "learner", "stage": "S0", "text": "haan ji"},
            {"seq": 3, "t": 2.5, "role": "caller", "stage": "S1", "text": "   "},
        ],
    }
    transcript = from_record(record)
    assert len(transcript.lines) == 2, "an empty turn carries no evidence and is dropped"
    assert transcript.redFlags[0].id == "stayed_on_call"
    assert transcript.durationSeconds == 42.5


def test_from_record_rejects_a_bad_role() -> None:
    with pytest.raises(TranscriptError):
        from_record({"drillId": "d1", "transcript": [{"role": "narrator", "text": "hi"}]})


def test_from_record_rejects_a_missing_transcript() -> None:
    with pytest.raises(TranscriptError):
        from_record({"drillId": "d1"})


def test_load_transcript_round_trips_through_s3() -> None:
    original = from_fixture(load_fixture("compliant"))
    key = "drill/transcript/x.json"
    s3 = FakeS3({key: json.dumps(original.to_dict(), ensure_ascii=False).encode("utf-8")})
    assert load_transcript(s3, "bucket", key).to_dict() == original.to_dict()


def test_load_transcript_rejects_a_non_json_object() -> None:
    s3 = FakeS3({"k": b"not json"})
    with pytest.raises(TranscriptError):
        load_transcript(s3, "bucket", "k")

"""Redaction keeps the line structure, and a guardrail failure never returns raw text."""

from __future__ import annotations

import json

import pytest
from conftest import FakeBedrock, FakeS3, load_fixture

from scoring_service.redact import (
    BLOCKED_PLACEHOLDER,
    RedactionError,
    redact_transcript,
    redacted_key,
    write_redacted,
)
from scoring_service.transcript import from_fixture

SECRET = "mera number 987654321012 hai"


def transcript():
    return from_fixture(load_fixture("digit_sharer"))


def redact(bedrock):
    return redact_transcript(transcript(), bedrock=bedrock, guardrail_id="gr", guardrail_version="DRAFT")


def test_every_line_is_sent_to_the_guardrail() -> None:
    bedrock = FakeBedrock()
    result = redact(bedrock)
    assert len(bedrock.calls) == len(transcript().lines)
    assert result.lines == len(transcript().lines)
    assert result.maskedLines == 0
    assert result.guardrailAction == "NONE"


def test_role_stage_and_seq_survive_masking() -> None:
    original = transcript()
    needle = original.lines[1].text
    bedrock = FakeBedrock(masks={needle: "{PHONE}"})
    result = redact(bedrock)
    assert result.maskedLines == 1
    assert result.guardrailAction == "GUARDRAIL_INTERVENED"
    for before, after in zip(original.lines, result.transcript.lines, strict=True):
        assert (before.seq, before.role, before.stage, before.t) == (after.seq, after.role, after.stage, after.t)
    assert result.transcript.lines[1].text == "{PHONE}"


def test_an_intervention_with_no_output_becomes_a_placeholder() -> None:
    class BlockingGuardrail(FakeBedrock):
        def apply_guardrail(self, **kwargs):
            return {"action": "GUARDRAIL_INTERVENED", "outputs": []}

    result = redact(BlockingGuardrail())
    assert result.maskedLines == result.lines
    assert {line.text for line in result.transcript.lines} == {BLOCKED_PLACEHOLDER}


def test_a_guardrail_failure_propagates_and_returns_nothing() -> None:
    bedrock = FakeBedrock(error=RuntimeError("throttled"))
    with pytest.raises(RedactionError):
        redact(bedrock)


def test_a_guardrail_failure_mid_transcript_still_raises() -> None:
    original = transcript()

    class FailsOnTheThirdLine(FakeBedrock):
        def apply_guardrail(self, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 3:
                raise RuntimeError("service unavailable")
            return {"action": "NONE", "outputs": []}

    with pytest.raises(RedactionError):
        redact(FailsOnTheThirdLine())
    assert len(original.lines) > 3, "the fixture must be long enough for this to be mid transcript"


def test_write_redacted_uses_the_pinned_prefix() -> None:
    s3 = FakeS3()
    result = redact(FakeBedrock())
    key = write_redacted(s3, "bucket", result.transcript)
    assert key == redacted_key(result.transcript.drillId)
    assert key.startswith("drill/redacted/") and key.endswith(".json")
    written = json.loads(s3.objects[key].decode("utf-8"))
    assert len(written["transcript"]) == result.lines
    assert s3.puts[0]["ContentType"] == "application/json"

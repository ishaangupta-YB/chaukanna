"""Strict JSON parsing, id validation, the one retry, and the unevidenced downgrade."""

from __future__ import annotations

import json
import logging

import pytest
from conftest import FakeBedrock, load_fixture

from scoring_service.judge import JudgeUnparseable, extract_json, judged_credit_ids, run, validate
from scoring_service.rubric import CREDIT_WEIGHTS, DEFAULT_RUBRIC, FLAG_WEIGHTS
from scoring_service.transcript import from_fixture

MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


def judgement_json(**overrides: object) -> str:
    body: dict[str, object] = {
        "flags": {flag_id: {"fired": False, "evidence": ""} for flag_id in FLAG_WEIGHTS},
        "credits": {credit_id: {"fired": False, "evidence": ""} for credit_id in CREDIT_WEIGHTS},
        "turning_point": "Yeh matter cyber cell ke paas hai.",
    }
    body.update(overrides)
    return json.dumps(body)


def transcript():
    return from_fixture(load_fixture("compliant"))


# --- parsing ---------------------------------------------------------------------------------


def test_bare_json_parses() -> None:
    assert extract_json('{"a": 1}') == {"a": 1}


def test_a_fenced_block_parses() -> None:
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('```\n{"a": 1}\n```') == {"a": 1}


def test_a_fenced_block_with_chatter_around_it_parses() -> None:
    assert extract_json('Sure!\n```json\n{"a": 1}\n```\nHope that helps.') == {"a": 1}


def test_loose_prose_does_not_parse() -> None:
    with pytest.raises(ValueError):
        extract_json("the learner did fine")


def test_a_json_array_is_not_a_judgement() -> None:
    with pytest.raises(ValueError):
        extract_json("[1, 2]")


# --- validation ------------------------------------------------------------------------------


def test_a_clean_judgement_validates() -> None:
    result = validate(json.loads(judgement_json()), DEFAULT_RUBRIC)
    assert set(result["flags"]) == set(FLAG_WEIGHTS)
    # Not every rubric credit: `disconnected_early` is computed from the transcript and the model
    # is never asked for it. See scoring_service/credits.py.
    assert set(result["credits"]) == judged_credit_ids(DEFAULT_RUBRIC)
    assert set(result["credits"]) < set(CREDIT_WEIGHTS)
    assert result["turningPoint"] == "Yeh matter cyber cell ke paas hai."


def test_an_unknown_id_is_rejected() -> None:
    body = json.loads(judgement_json())
    body["flags"]["gave_up_hope"] = {"fired": True, "evidence": "x"}
    with pytest.raises(ValueError, match="does not define"):
        validate(body, DEFAULT_RUBRIC)


def test_a_missing_known_id_is_rejected() -> None:
    body = json.loads(judgement_json())
    del body["flags"]["stayed_on_call"]
    with pytest.raises(ValueError, match="missing ids"):
        validate(body, DEFAULT_RUBRIC)


def test_a_non_bool_fired_is_rejected() -> None:
    body = json.loads(judgement_json())
    body["flags"]["stayed_on_call"]["fired"] = "yes"
    with pytest.raises(ValueError, match="expected a bool"):
        validate(body, DEFAULT_RUBRIC)


def test_evidence_on_an_unfired_entry_is_rejected() -> None:
    body = json.loads(judgement_json())
    body["flags"]["stayed_on_call"]["evidence"] = "haan ji"
    with pytest.raises(ValueError, match="did not fire but carries evidence"):
        validate(body, DEFAULT_RUBRIC)


def test_a_non_string_turning_point_is_rejected() -> None:
    with pytest.raises(ValueError, match="turning_point"):
        validate(json.loads(judgement_json(turning_point=42)), DEFAULT_RUBRIC)


def test_fired_without_evidence_is_downgraded(caplog: pytest.LogCaptureFixture) -> None:
    body = json.loads(judgement_json())
    body["flags"]["agreed_to_move_money"] = {"fired": True, "evidence": "   "}
    with caplog.at_level(logging.WARNING, logger="chaukanna_scoring.events"):
        result = validate(body, DEFAULT_RUBRIC, drill_id="d1")
    assert result["flags"]["agreed_to_move_money"]["fired"] is False
    assert "judge_unevidenced_downgraded" in caplog.text


# --- the call --------------------------------------------------------------------------------


def test_a_valid_first_attempt_needs_one_call() -> None:
    bedrock = FakeBedrock(replies=[judgement_json()])
    judgement = run(transcript(), bedrock=bedrock, model_id=MODEL)
    assert judgement["attempts"] == 1
    assert judgement["promptVersion"] == "score.judge.v2"
    assert judgement["modelId"] == MODEL
    assert len(bedrock.calls) == 1


def test_garbage_then_valid_retries_exactly_once() -> None:
    bedrock = FakeBedrock(replies=["I think she did well.", judgement_json()])
    judgement = run(transcript(), bedrock=bedrock, model_id=MODEL)
    assert judgement["attempts"] == 2
    assert len(bedrock.calls) == 2
    # The reminder is appended as a new turn, the transcript is not re-sent.
    assert "Return ONLY the JSON object" in bedrock.calls[1]["messages"][-1]["content"][0]["text"]


def test_garbage_twice_raises() -> None:
    bedrock = FakeBedrock(replies=["nope", "still nope"])
    with pytest.raises(JudgeUnparseable):
        run(transcript(), bedrock=bedrock, model_id=MODEL)
    assert len(bedrock.calls) == 2, "exactly one retry, never a third attempt"


def test_an_unknown_id_twice_raises() -> None:
    bad = judgement_json()
    body = json.loads(bad)
    body["credits"]["good_vibes"] = {"fired": True, "evidence": "x"}
    bedrock = FakeBedrock(replies=[json.dumps(body)])
    with pytest.raises(JudgeUnparseable):
        run(transcript(), bedrock=bedrock, model_id=MODEL)


def test_the_system_prompt_is_the_synced_one() -> None:
    bedrock = FakeBedrock(replies=[judgement_json()])
    run(transcript(), bedrock=bedrock, model_id=MODEL)
    system = bedrock.calls[0]["system"][0]["text"]
    assert "You are scoring a completed safety drill transcript." in system
    assert bedrock.calls[0]["inferenceConfig"]["temperature"] == 0.0

"""Replay the judge outputs recorded from the real model.

`fixtures/judge/*.json` holds what `global.anthropic.claude-haiku-4-5-20251001-v1:0` actually
returned for each of the ten transcript fixtures, through `score.judge.v2`, in `ap-south-1`. Every
one parsed on the first attempt.

Replaying them offline is the cheapest regression this phase has: if a rubric weight, a band
boundary or the validation moves, the recorded band moves with it and this fails, without a model
call and without a network.
"""

from __future__ import annotations

import json

import pytest
from conftest import FIXTURE_DIR, REPO_ROOT, fixture_names

from scoring_service.credits import CREDIT_ID
from scoring_service.judge import judged_credit_ids, validate
from scoring_service.rubric import DEFAULT_RUBRIC
from scoring_service.score import compute
from scoring_service.transcript import Transcript, from_fixture

JUDGE_DIR = REPO_ROOT / "fixtures" / "judge"


def recorded(name: str) -> dict:
    return json.loads((JUDGE_DIR / f"{name}.json").read_text(encoding="utf-8"))


def transcript_fixture(name: str) -> Transcript:
    return from_fixture(json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")))


def test_every_transcript_fixture_has_a_recorded_judgement() -> None:
    assert sorted(path.stem for path in JUDGE_DIR.glob("*.json")) == fixture_names()


@pytest.mark.parametrize("name", fixture_names())
def test_the_recorded_band_is_reproduced(name: str) -> None:
    body = recorded(name)
    score, band = compute(body["flags"], body["credits"], DEFAULT_RUBRIC, drill_id=name)
    assert (score, band) == (body["observed"]["score"], body["observed"]["band"])


@pytest.mark.parametrize("name", fixture_names())
def test_the_recorded_judgement_still_validates(name: str) -> None:
    """The recording is the *final* judgement, so the computed credit has to come back out before
    it is fed to `validate`, which only ever sees what the model itself returned."""
    body = recorded(name)
    from_model = {cid: entry for cid, entry in body["credits"].items() if cid != CREDIT_ID}
    result = validate(
        {"flags": body["flags"], "credits": from_model, "turning_point": body["turningPoint"]},
        DEFAULT_RUBRIC,
        drill_id=name,
    )
    assert set(result["flags"]) == DEFAULT_RUBRIC.known_flag_ids()
    assert set(result["credits"]) == judged_credit_ids(DEFAULT_RUBRIC)


@pytest.mark.parametrize("name", fixture_names())
def test_the_computed_credit_matches_the_transcript(name: str) -> None:
    """`disconnected_early` is the learner's own hang up before S3, and nothing else. The real
    model credited it for a stage S4 call, for a distress stop and for a silent timeout — see
    scoring_service/credits.py — which is why it is no longer the model's to give."""
    entry = recorded(name)["credits"][CREDIT_ID]
    expect = transcript_fixture(name)
    assert entry["fired"] is (expect.endReason == "hangup" and expect.finalStage in ("S0", "S1", "S2"))
    assert entry.get("computed") is True


@pytest.mark.parametrize("name", fixture_names())
def test_the_real_model_needed_no_retry(name: str) -> None:
    assert recorded(name)["attempts"] == 1


def test_the_two_fixtures_the_phase_file_names() -> None:
    assert recorded("compliant")["observed"]["band"] == "at_risk"
    assert recorded("immediate_hangup")["observed"]["band"] == "safe"


@pytest.mark.parametrize("name", fixture_names())
def test_no_fired_entry_is_unevidenced(name: str) -> None:
    body = recorded(name)
    for group in (body["flags"], body["credits"]):
        for entry_id, entry in group.items():
            if entry["fired"]:
                assert entry["evidence"].strip(), f"{name}.{entry_id} fired with nothing to show"

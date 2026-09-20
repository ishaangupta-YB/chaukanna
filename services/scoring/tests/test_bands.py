"""The ten fixtures, scored.

The phase file's Verify section: "Run all ten fixtures. The compliant one must land in `at_risk`,
the immediate hangup in `safe`. If those two are wrong, the rubric is wrong."

The judgement here is derived from what each fixture already asserts (its own `expect.redFlags`,
its end reason and the stage it ended at, plus the learner's own words for the two credits that
are things the learner said). No model is involved, so a failure here is a rubric or converter
failure and nothing else.
"""

from __future__ import annotations

import pytest
from conftest import fixture_names, load_fixture

from scoring_service.rubric import DEFAULT_RUBRIC
from scoring_service.score import compute
from scoring_service.stub_judge import judgement_for
from scoring_service.transcript import from_fixture

FIXTURES = fixture_names()

#: Recorded from this rubric so a weight change shows up here as a diff, not as a silent reshuffle.
EXPECTED_BANDS = {
    "code_switcher": "wobbly",
    "compliant": "at_risk",
    "digit_sharer": "at_risk",
    "distressed": "wobbly",
    "immediate_hangup": "safe",
    "polite_refusal": "safe",
    "safe_word_s1": "safe",
    "safe_word_s4": "at_risk",
    "silence": "wobbly",
    "timeout": "at_risk",
}


def band_for(name: str) -> tuple[int, str]:
    transcript = from_fixture(load_fixture(name))
    judgement = judgement_for(transcript)
    return compute(judgement["flags"], judgement["credits"], DEFAULT_RUBRIC, drill_id=transcript.drillId)


# --- the two the phase file names ------------------------------------------------------------


def test_compliant_lands_at_risk() -> None:
    score, band = band_for("compliant")
    assert band == "at_risk", f"compliant scored {score}; if this is wrong, the rubric is wrong"


def test_immediate_hangup_lands_safe() -> None:
    score, band = band_for("immediate_hangup")
    assert band == "safe", f"immediate_hangup scored {score}; if this is wrong, the rubric is wrong"


# --- all ten ---------------------------------------------------------------------------------


def test_every_fixture_is_covered() -> None:
    assert sorted(EXPECTED_BANDS) == FIXTURES


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_bands(name: str) -> None:
    score, band = band_for(name)
    assert band == EXPECTED_BANDS[name], f"{name} scored {score} -> {band}"
    assert 0 <= score <= 100


@pytest.mark.parametrize("name", FIXTURES)
def test_hanging_up_never_scores_worse_than_staying(name: str) -> None:
    """A sanity property rather than a number: the credits can only help."""
    transcript = from_fixture(load_fixture(name))
    judgement = judgement_for(transcript)
    with_credits, _ = compute(judgement["flags"], judgement["credits"])
    without_credits, _ = compute(judgement["flags"], {})
    assert with_credits >= without_credits


def test_the_helpline_credit_is_earned_by_naming_1930() -> None:
    judgement = judgement_for(from_fixture(load_fixture("code_switcher")))
    assert judgement["credits"]["named_helpline"]["fired"] is True
    assert "1930" in judgement["credits"]["named_helpline"]["evidence"]


def test_a_call_that_ran_to_the_end_earns_no_disconnect_credit() -> None:
    judgement = judgement_for(from_fixture(load_fixture("compliant")))
    assert judgement["credits"]["disconnected_early"]["fired"] is False

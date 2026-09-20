"""The same fixture must produce the same band across five runs.

The phase file: "If it does not, the rubric or the prompt is too loose." The judge is stubbed with
a fixed reply, so what this actually pins is everything downstream of the model: the fixture
converter, the validation, the arithmetic and the banding. Nothing in that chain is allowed to
depend on dict ordering, a timestamp, or a set iteration order.
"""

from __future__ import annotations

import json

import pytest
from conftest import FakeBedrock, fixture_names, load_fixture

from scoring_service.judge import run as judge_run
from scoring_service.rubric import CREDIT_WEIGHTS, FLAG_WEIGHTS
from scoring_service.score import run as score_run
from scoring_service.stub_judge import judgement_for
from scoring_service.transcript import from_fixture

RUNS = 5
MODEL = "stub-model"

FIXED_REPLY = json.dumps(
    {
        "flags": {
            flag_id: {"fired": flag_id in ("stayed_on_call", "accepted_secrecy"), "evidence": "theek hai"}
            if flag_id in ("stayed_on_call", "accepted_secrecy")
            else {"fired": False, "evidence": ""}
            for flag_id in FLAG_WEIGHTS
        },
        "credits": {credit_id: {"fired": False, "evidence": ""} for credit_id in CREDIT_WEIGHTS},
        "turning_point": "Yeh matter cyber cell ke paas hai.",
    }
)


@pytest.mark.parametrize("name", fixture_names())
def test_a_stubbed_judge_gives_the_same_band_five_times(name: str) -> None:
    results = []
    for _ in range(RUNS):
        transcript = from_fixture(load_fixture(name))
        judgement = judge_run(transcript, bedrock=FakeBedrock(replies=[FIXED_REPLY]), model_id=MODEL)
        results.append(score_run(judgement, drill_id=transcript.drillId))
    assert results == [results[0]] * RUNS


@pytest.mark.parametrize("name", fixture_names())
def test_the_derived_judgement_is_stable(name: str) -> None:
    """The converter and the fixture derivation are pure too: same bytes in, same JSON out."""
    outputs = {
        json.dumps(judgement_for(from_fixture(load_fixture(name))), sort_keys=True, ensure_ascii=False)
        for _ in range(RUNS)
    }
    assert len(outputs) == 1


def test_the_transcript_conversion_is_byte_identical_across_runs() -> None:
    fixture = load_fixture("compliant")
    dumps = {json.dumps(from_fixture(fixture).to_dict(), ensure_ascii=False) for _ in range(RUNS)}
    assert len(dumps) == 1

"""`compute` exhaustively: clamping at both ends, every band boundary, unknown ids ignored."""

from __future__ import annotations

import itertools
import logging

import pytest

from scoring_service.rubric import CREDIT_WEIGHTS, DEFAULT_RUBRIC, FLAG_WEIGHTS
from scoring_service.score import compute, run


def fired(*ids: str) -> dict[str, dict[str, object]]:
    return {entry_id: {"fired": True, "evidence": "quote"} for entry_id in ids}


def not_fired(*ids: str) -> dict[str, dict[str, object]]:
    return {entry_id: {"fired": False, "evidence": ""} for entry_id in ids}


def test_nothing_fires_is_the_starting_score() -> None:
    assert compute({}, {}) == (50, "wobbly")


def test_every_flag_subtracts_its_weight() -> None:
    for flag_id, weight in FLAG_WEIGHTS.items():
        score, _ = compute(fired(flag_id), {})
        assert score == 50 - weight, flag_id


def test_every_credit_adds_its_weight() -> None:
    for credit_id, weight in CREDIT_WEIGHTS.items():
        score, _ = compute({}, fired(credit_id))
        assert score == 50 + weight, credit_id


def test_unfired_entries_do_nothing() -> None:
    assert compute(not_fired(*FLAG_WEIGHTS), not_fired(*CREDIT_WEIGHTS)) == (50, "wobbly")


def test_clamps_at_zero() -> None:
    assert compute(fired(*FLAG_WEIGHTS), {}) == (0, "at_risk")


def test_clamps_at_one_hundred() -> None:
    assert compute({}, fired(*CREDIT_WEIGHTS)) == (100, "safe")


def test_clamping_is_not_a_wrap_around() -> None:
    """Every reachable combination stays inside 0..100 and inside a band."""
    for flag_count in range(len(FLAG_WEIGHTS) + 1):
        for flags in itertools.combinations(FLAG_WEIGHTS, flag_count):
            score, band = compute(fired(*flags), fired(*CREDIT_WEIGHTS))
            assert 0 <= score <= 100
            assert band in DEFAULT_RUBRIC.bands


@pytest.mark.parametrize(
    ("score", "band"),
    [(0, "at_risk"), (39, "at_risk"), (40, "wobbly"), (69, "wobbly"), (70, "safe"), (100, "safe")],
)
def test_band_boundaries(score: int, band: str) -> None:
    assert DEFAULT_RUBRIC.band(score) == band


def test_39_and_40_are_on_opposite_sides() -> None:
    # 50 - 10 = 40 (wobbly) but 50 - 10 - 1 more point would be at_risk: the boundary is real.
    assert compute(fired("accepted_authority"), {}) == (40, "wobbly")
    assert compute(fired("accepted_authority"), {})[0] - 1 == 39
    assert DEFAULT_RUBRIC.band(39) == "at_risk"


def test_69_and_70_are_on_opposite_sides() -> None:
    assert compute({}, fired("named_helpline", "independent_verify")) == (90, "safe")
    assert DEFAULT_RUBRIC.band(69) == "wobbly"
    assert DEFAULT_RUBRIC.band(70) == "safe"


def test_unknown_ids_are_ignored_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="chaukanna_scoring.events"):
        score, band = compute(fired("invented_flag"), fired("invented_credit"), drill_id="d1")
    assert (score, band) == (50, "wobbly")
    assert "score_unknown_flag" in caplog.text
    assert "score_unknown_credit" in caplog.text


def test_malformed_entries_do_not_crash() -> None:
    assert compute({"stayed_on_call": "yes"}, {"named_helpline": None}) == (50, "wobbly")


def test_run_returns_the_patch() -> None:
    patch = run({"flags": fired("stayed_on_call"), "credits": {}}, drill_id="d1")
    assert patch == {"score": 25, "band": "at_risk", "rubricVersion": "prd.v1"}


def test_run_rejects_a_non_object_group() -> None:
    with pytest.raises(TypeError):
        run({"flags": [], "credits": {}}, drill_id="d1")

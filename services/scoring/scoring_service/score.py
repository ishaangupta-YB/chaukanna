"""The score itself: a pure function, no model, no IO.

Models classify, code counts. The judge returns which flags and credits fired and quotes the
learner; the arithmetic that turns that into a number a family will read happens here, where it is
deterministic and unit tested, and nowhere else.
"""

from __future__ import annotations

import logging

from .log import event
from .rubric import DEFAULT_RUBRIC, MAX_SCORE, MIN_SCORE, STARTING_SCORE, Rubric


def _fired(entry: object) -> bool:
    return bool(entry.get("fired")) if isinstance(entry, dict) else False


def compute(
    flags: dict[str, object],
    credits: dict[str, object],
    rubric: Rubric = DEFAULT_RUBRIC,
    *,
    drill_id: str = "",
) -> tuple[int, str]:
    """Start at 50, credits add, flags subtract, clamp 0..100, then band it.

    An id the rubric does not know is ignored and logged. The judge is validated before it gets
    here, so an unknown id means the rubric changed under a replay, not that a model is loose.
    """
    score = STARTING_SCORE
    for credit_id, credit in credits.items():
        if not _fired(credit):
            continue
        weight = rubric.credit_weight(credit_id)
        if weight is None:
            event("score_unknown_credit", drill_id, level=logging.WARNING, creditId=credit_id)
            continue
        score += weight
    for flag_id, flag in flags.items():
        if not _fired(flag):
            continue
        weight = rubric.flag_weight(flag_id)
        if weight is None:
            event("score_unknown_flag", drill_id, level=logging.WARNING, flagId=flag_id)
            continue
        score -= weight
    score = max(MIN_SCORE, min(MAX_SCORE, score))
    return score, rubric.band(score)


def run(judgement: dict[str, object], *, drill_id: str, rubric: Rubric = DEFAULT_RUBRIC) -> dict[str, object]:
    """The `$.score` patch: `{"score", "band", "rubricVersion"}`."""
    flags = judgement.get("flags", {})
    credits = judgement.get("credits", {})
    if not isinstance(flags, dict) or not isinstance(credits, dict):
        raise TypeError("judgement.flags and judgement.credits must both be objects")
    score, band = compute(flags, credits, rubric, drill_id=drill_id)
    event("drill_scored", drill_id, score=score, band=band, rubricVersion=rubric.version)
    return {"score": score, "band": band, "rubricVersion": rubric.version}

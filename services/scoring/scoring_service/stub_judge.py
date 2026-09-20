"""A judgement derived from a fixture, for local runs and tests. Never used in a real drill.

The pipeline's shape has to be testable, and the CLI has to run on a laptop with no credentials,
so this reproduces what a good judge would return for a fixture from what the fixture already
asserts: the red flags the agent recorded, the stage the call ended at, and the learner's own
words. It is not a judge and it is not a fallback: `handlers.judge_handler` never imports it.
"""

from __future__ import annotations

from typing import Any

from .rubric import DEFAULT_RUBRIC, Rubric
from .transcript import STAGES, Transcript

#: `disconnected_early` is about the learner ending the call before stage S3. Hanging up mid
#: sentence is a perfectly good reason to end one, and a reason the transcript records without a
#: quote, so the credit is judged on the end reason and the stage, not on words.
LEARNER_ENDED = {"hangup", "safe_word", "distress", "is_this_real"}
ISOLATION_STAGE = STAGES.index("S3")

HELPLINE_MARKERS = ("1930", "cybercrime.gov.in")
#: Deliberately narrow. "mere bete ko bulao" ("call my son") in `distressed` is a frightened
#: person asking for help, not someone saying they will go and check independently, and a credit
#: that fires on the word "bete" would score fear as competence.
VERIFY_MARKERS = (
    "call my",
    "call back",
    "callback",
    "phone my",
    "call karungi",
    "call karunga",
    "baat karungi",
    "baat karunga",
    "khud call",
    "verify kar",
    "bank ja",
)


def _learner_lines(transcript: Transcript) -> list[str]:
    return [line.text for line in transcript.lines if line.role == "learner"]


def _first_match(lines: list[str], markers: tuple[str, ...]) -> str:
    for text in lines:
        lowered = text.lower()
        if any(marker in lowered for marker in markers):
            return text
    return ""


def _turning_point(transcript: Transcript) -> str:
    """The caller sentence after which the learner should have hung up: the handoff to the
    "cyber cell", or the last thing the caller said if the call never got that far."""
    caller_lines = [line for line in transcript.lines if line.role == "caller"]
    if not caller_lines:
        return ""
    for line in caller_lines:
        if line.stage in ("S1", "S2"):
            return line.text
    return caller_lines[-1].text


def judgement_for(transcript: Transcript, rubric: Rubric = DEFAULT_RUBRIC) -> dict[str, Any]:
    """The `$.judgement` shape, derived rather than inferred by a model."""
    recorded = {flag.id: flag.quote for flag in transcript.redFlags}
    learner = _learner_lines(transcript)
    last_learner = learner[-1] if learner else ""

    flags = {
        flag_id: {"fired": flag_id in recorded, "evidence": recorded.get(flag_id, "")}
        for flag_id in sorted(rubric.known_flag_ids())
    }

    ended_early = transcript.endReason in LEARNER_ENDED and STAGES.index(transcript.finalStage) < ISOLATION_STAGE
    helpline = _first_match(learner, HELPLINE_MARKERS)
    verify = _first_match(learner, VERIFY_MARKERS)
    credits = {
        "disconnected_early": {"fired": ended_early, "evidence": last_learner if ended_early else ""},
        "independent_verify": {"fired": bool(verify), "evidence": verify},
        "named_helpline": {"fired": bool(helpline), "evidence": helpline},
    }

    return {
        "flags": flags,
        "credits": credits,
        "turningPoint": _turning_point(transcript),
        "attempts": 0,
        "promptVersion": "stub",
        "modelId": "stub",
    }

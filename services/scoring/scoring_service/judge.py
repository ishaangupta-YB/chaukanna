"""`score.judge.v2` through `bedrock-runtime.converse`, parsed strictly.

The judge classifies; it never computes a score (`score.py` does that). Everything here is about
making sure what comes back is a shape the rubric can count:

- The JSON must parse. A fenced ```json block is tolerated because models emit one habitually;
  nothing looser is. A parse or validation failure retries **once** with a "return only JSON"
  reminder, and then the drill is `score_failed`. A guessed score is worse than no score.
- Ids are checked against the rubric. An id the rubric does not know is rejected rather than
  ignored, because at judge time it means the model invented a category, and a missing known id
  means it silently dropped one.
- The prompt says "If you cannot quote the learner, it did not fire". That is enforced here, in
  code: a `fired: true` with no evidence becomes `fired: false`. A model's claim about the learner
  that it cannot quote must not cost the learner points.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .credits import CREDIT_ID, disconnected_early
from .log import event
from .prompts import JUDGE_PROMPT, judge_system
from .rubric import DEFAULT_RUBRIC, Rubric
from .transcript import Transcript

MAX_TOKENS = 2000
TEMPERATURE = 0.0
MAX_ATTEMPTS = 2

RETRY_REMINDER = (
    "Your previous reply could not be parsed. Return ONLY the JSON object described above, "
    "with no prose, no explanation and no markdown fence."
)

_FENCE = re.compile(r"```(?:json)?\s*(?P<body>\{.*\})\s*```", re.DOTALL)


class JudgeUnparseable(Exception):
    """Two attempts, still not a judgement the rubric can count. The drill is `score_failed`."""


def extract_json(raw: str) -> dict[str, Any]:
    """Strict: the whole reply, or exactly one fenced block containing the whole object."""
    text = raw.strip()
    fence = _FENCE.search(text)
    if fence:
        text = fence.group("body").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"reply is not JSON: {error.msg}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"reply is a {type(parsed).__name__}, expected an object")  # noqa: TRY004
    return parsed


def _validate_group(raw: Any, known: set[str], label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ValueError(f"{label} is {type(raw).__name__}, expected an object")  # noqa: TRY004
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ValueError(f"{label} contains ids the rubric does not define: {unknown}")
    missing = sorted(known - set(raw))
    if missing:
        raise ValueError(f"{label} is missing ids: {missing}")
    out: dict[str, dict[str, Any]] = {}
    for entry_id, entry in raw.items():
        if not isinstance(entry, dict) or "fired" not in entry:
            raise ValueError(f"{label}.{entry_id} must be an object with a `fired` field")
        fired = entry["fired"]
        if not isinstance(fired, bool):
            raise ValueError(f"{label}.{entry_id}.fired is {type(fired).__name__}, expected a bool")  # noqa: TRY004
        evidence = entry.get("evidence", "")
        if not isinstance(evidence, str):
            raise ValueError(f"{label}.{entry_id}.evidence is {type(evidence).__name__}, expected a string")  # noqa: TRY004
        evidence = evidence.strip()
        if not fired and evidence:
            raise ValueError(f"{label}.{entry_id} did not fire but carries evidence")
        out[entry_id] = {"fired": fired, "evidence": evidence}
    return out


def judged_credit_ids(rubric: Rubric) -> set[str]:
    """The credits the model is asked about: everything except the ones code computes."""
    return rubric.known_credit_ids() - {CREDIT_ID}


def validate(parsed: dict[str, Any], rubric: Rubric, *, drill_id: str = "") -> dict[str, Any]:
    flags = _validate_group(parsed.get("flags"), rubric.known_flag_ids(), "flags")
    # A model that reports `disconnected_early` anyway has ignored the prompt, not invented a
    # category, so it is dropped with a log line rather than failing the whole judgement.
    raw_credits = parsed.get("credits")
    if isinstance(raw_credits, dict) and CREDIT_ID in raw_credits:
        event("judge_returned_computed_credit", drill_id, level=logging.WARNING, id=CREDIT_ID)
        raw_credits = {key: value for key, value in raw_credits.items() if key != CREDIT_ID}
    credits = _validate_group(raw_credits, judged_credit_ids(rubric), "credits")
    turning_point = parsed.get("turning_point", "")
    if not isinstance(turning_point, str):
        raise ValueError(f"turning_point is {type(turning_point).__name__}, expected a string")  # noqa: TRY004

    for label, group in (("flag", flags), ("credit", credits)):
        for entry_id, entry in group.items():
            if entry["fired"] and not entry["evidence"]:
                # "If you cannot quote the learner, it did not fire."
                event("judge_unevidenced_downgraded", drill_id, level=logging.WARNING, kind=label, id=entry_id)
                entry["fired"] = False
    return {"flags": flags, "credits": credits, "turningPoint": turning_point.strip()}


def build_user_message(transcript: Transcript) -> str:
    return (
        f"Language: {transcript.language}\n"
        f"The call ended at stage {transcript.finalStage} with reason {transcript.endReason}.\n\n"
        "TRANSCRIPT\n"
        f"{transcript.rendered()}"
    )


def _converse(bedrock: Any, *, model_id: str, system: str, turns: list[dict[str, Any]]) -> str:
    response = bedrock.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=turns,
        inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
    )
    content = response["output"]["message"]["content"]
    return "".join(block.get("text", "") for block in content if isinstance(block, dict))


def run(
    transcript: Transcript,
    *,
    bedrock: Any,
    model_id: str,
    rubric: Rubric = DEFAULT_RUBRIC,
) -> dict[str, Any]:
    """The `$.judgement` patch. Raises `JudgeUnparseable` after two failed attempts."""
    drill_id = transcript.drillId
    system = judge_system()
    turns: list[dict[str, Any]] = [{"role": "user", "content": [{"text": build_user_message(transcript)}]}]
    last_error = ""

    for attempt in range(1, MAX_ATTEMPTS + 1):
        raw = _converse(bedrock, model_id=model_id, system=system, turns=turns)
        try:
            judgement = validate(extract_json(raw), rubric, drill_id=drill_id)
        except ValueError as error:
            last_error = str(error)
            event("judge_unparseable_attempt", drill_id, level=logging.WARNING, attempt=attempt, reason=last_error)
            if attempt == MAX_ATTEMPTS:
                break
            turns = turns + [
                {"role": "assistant", "content": [{"text": raw}]},
                {"role": "user", "content": [{"text": RETRY_REMINDER}]},
            ]
            continue
        # The one credit the model is never asked about, decided from the transcript. See
        # credits.py for why it is not the model's to give.
        judgement["credits"][CREDIT_ID] = disconnected_early(transcript)
        judgement.update({"attempts": attempt, "promptVersion": JUDGE_PROMPT, "modelId": model_id})
        event(
            "drill_judged",
            drill_id,
            attempts=attempt,
            firedFlags=sorted(fid for fid, f in judgement["flags"].items() if f["fired"]),
            firedCredits=sorted(cid for cid, c in judgement["credits"].items() if c["fired"]),
        )
        return judgement

    raise JudgeUnparseable(f"judge returned no usable JSON in {MAX_ATTEMPTS} attempts: {last_error}")

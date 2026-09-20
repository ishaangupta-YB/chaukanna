"""The five Lambda entry points. Thin on purpose.

Each one validates the fields it needs, builds the clients from the environment, calls a function
in a module, and returns the patch the state machine merges under its `ResultPath`. No business
logic lives here, so `cli.py` runs the identical code path against a fixture without pretending to
be Lambda.

Handler names, pinned by the contract: `scoring_service.handlers.<x>_handler`.
"""

from __future__ import annotations

from typing import Any

from . import aws, config, debrief, judge, redact, score
from .finish import run as finish_run
from .log import configure_logging
from .transcript import Transcript, load_transcript

configure_logging()


def _require(event: dict[str, Any], *names: str) -> list[str]:
    missing = [name for name in names if not event.get(name)]
    if missing:
        raise ValueError(f"execution input is missing {missing}")
    return [str(event[name]) for name in names]


def _load_redacted(event: dict[str, Any]) -> Transcript:
    redaction = event.get("redaction") or {}
    key = redaction.get("redactedKey")
    if not key:
        raise ValueError("execution input is missing redaction.redactedKey")
    return load_transcript(aws.s3(), config.artifacts_bucket(), str(key))


def redact_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    _require(event, "drillId", "transcriptKey")
    bucket = config.artifacts_bucket()
    transcript = load_transcript(aws.s3(), bucket, str(event["transcriptKey"]))
    result = redact.redact_transcript(
        transcript,
        bedrock=aws.bedrock(),
        guardrail_id=config.guardrail_id(),
        guardrail_version=config.guardrail_version(),
    )
    key = redact.write_redacted(aws.s3(), bucket, result.transcript)
    return result.patch(key)


def judge_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    _require(event, "drillId")
    return judge.run(_load_redacted(event), bedrock=aws.bedrock(), model_id=config.judge_model_id())


def score_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    (drill_id,) = _require(event, "drillId")
    judgement = event.get("judgement")
    if not isinstance(judgement, dict):
        raise ValueError("execution input is missing judgement")  # noqa: TRY004 - one refusal type for every bad input
    return score.run(judgement, drill_id=drill_id)


def debrief_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    _require(event, "drillId")
    judgement = event.get("judgement") or {}
    scored = event.get("score") or {}
    if not scored.get("band"):
        raise ValueError("execution input is missing score.band")
    transcript = _load_redacted(event)
    model_id = config.debrief_model_id()
    voice_id = config.debrief_voice_id()
    text = debrief.write_text(transcript, judgement, scored, bedrock=aws.bedrock(), model_id=model_id)
    audio = debrief.synthesize(aws.polly(), text, language=transcript.language, voice_id=voice_id)
    key = debrief.write_audio(aws.s3(), config.artifacts_bucket(), transcript.drillId, audio)
    return debrief.patch(text, audio_key_value=key, language=transcript.language, voice_id=voice_id, model_id=model_id)


def finish_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    _require(event, "drillId", "memberId", "scheduledAt")
    return finish_run(event, ddb=aws.ddb(), table=config.table_name())

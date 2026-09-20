"""Bedrock Guardrails over the transcript, before the first durable write of this pipeline.

Two rules this module exists to keep:

- **Line by line, not one blob.** Every line keeps its `seq`, `role` and `stage`, so the judge can
  still tell who said what and the score row's quotes still line up with the redacted text the
  learner is shown. A single blob would also lose the mapping the moment the guardrail rewrote a
  span.
- **Failure means failure.** If `apply_guardrail` raises, this raises. There is no path here that
  returns text the guardrail has not seen. The transcript already went through the agent's own
  tripwire, but "already redacted once" is not a reason to skip the check that decides whether a
  quote is safe to store and show.

Note for whoever configures the guardrail: Bedrock's PII entity enum has no India specific
entities, so Aadhaar and PAN must be caught with `regexesConfig`, not `piiEntitiesConfig`.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from .log import event
from .transcript import Transcript, TranscriptLine

REDACTED_PREFIX = "drill/redacted/"

#: What a line becomes when the guardrail blocked it outright and returned nothing to keep.
BLOCKED_PLACEHOLDER = "[redacted]"


class RedactionError(Exception):
    """The guardrail could not be applied. The execution fails; nothing is written."""


def redacted_key(drill_id: str) -> str:
    return f"{REDACTED_PREFIX}{drill_id}.json"


@dataclass(frozen=True)
class RedactionResult:
    transcript: Transcript
    lines: int
    maskedLines: int
    guardrailAction: str

    def patch(self, redacted_key_value: str) -> dict[str, Any]:
        return {
            "redactedKey": redacted_key_value,
            "lines": self.lines,
            "maskedLines": self.maskedLines,
            "guardrailAction": self.guardrailAction,
        }


def _apply(bedrock: Any, text: str, *, guardrail_id: str, guardrail_version: str) -> tuple[str, bool]:
    """One line through `apply_guardrail`. Returns (text, was_masked)."""
    try:
        response = bedrock.apply_guardrail(
            guardrailIdentifier=guardrail_id,
            guardrailVersion=guardrail_version,
            source="OUTPUT",
            content=[{"text": {"text": text}}],
        )
    except Exception as error:
        raise RedactionError(f"apply_guardrail failed: {type(error).__name__}") from error

    action = response.get("action", "NONE")
    if action != "GUARDRAIL_INTERVENED":
        return text, False
    outputs = response.get("outputs") or []
    masked = str(outputs[0].get("text", "")) if outputs and isinstance(outputs[0], dict) else ""
    # An intervention with nothing to keep means the guardrail refused the line. Returning the
    # original here would be exactly the fall through this module exists to prevent.
    return (masked or BLOCKED_PLACEHOLDER), True


def redact_transcript(
    transcript: Transcript,
    *,
    bedrock: Any,
    guardrail_id: str,
    guardrail_version: str,
) -> RedactionResult:
    lines: list[TranscriptLine] = []
    masked_count = 0
    for line in transcript.lines:
        text, masked = _apply(bedrock, line.text, guardrail_id=guardrail_id, guardrail_version=guardrail_version)
        masked_count += int(masked)
        lines.append(
            TranscriptLine(seq=line.seq, t=line.t, role=line.role, stage=line.stage, text=text) if masked else line
        )
    action = "GUARDRAIL_INTERVENED" if masked_count else "NONE"
    event(
        "drill_redacted",
        transcript.drillId,
        lines=len(lines),
        maskedLines=masked_count,
        guardrailAction=action,
        level=logging.WARNING if masked_count else logging.INFO,
    )
    return RedactionResult(
        transcript=transcript.with_lines(lines),
        lines=len(lines),
        maskedLines=masked_count,
        guardrailAction=action,
    )


def write_redacted(s3: Any, bucket: str, transcript: Transcript) -> str:
    key = redacted_key(transcript.drillId)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(transcript.to_dict(), ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
        Metadata={"drillid": transcript.drillId, "contains": "guardrail-redacted"},
    )
    return key

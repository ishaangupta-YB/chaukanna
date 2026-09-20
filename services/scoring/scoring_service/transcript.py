"""The transcript the agent writes, read back without pydantic.

`apps/agent/chaukanna_agent/session.py` builds a `DrillRecord` with pydantic and
`store.py` writes `model_dump_json()` to `drill/transcript/<drillId>.json`. This package cannot
import pydantic (`lambda.Code.fromAsset` installs nothing and the Python 3.12 runtime ships boto3
and nothing else), so the same shape is parsed by hand here. If `DrillRecord` changes, this
changes with it: `tests/test_transcript.py` is the only thing holding the two together.

`from_fixture` converts a fixture *script* (`fixtures/transcripts/*.json`, a list of caller and
learner turns with tool calls) into the same object, so the CLI can run the whole pipeline against
the ten fixtures before a single real drill exists.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

STAGES = ("S0", "S1", "S2", "S3", "S4", "S5")
LAST_STAGE = STAGES[-1]


class TranscriptError(Exception):
    """The object in S3 is not a transcript this code can read."""


@dataclass(frozen=True)
class TranscriptLine:
    seq: int
    t: float
    role: str  # "caller" | "learner"
    stage: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, "t": self.t, "role": self.role, "stage": self.stage, "text": self.text}


@dataclass(frozen=True)
class RedFlag:
    id: str
    quote: str
    stage: str
    seq: int

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "quote": self.quote, "stage": self.stage, "seq": self.seq}


@dataclass(frozen=True)
class Transcript:
    drillId: str
    language: str
    scenarioId: str
    scenarioVersion: int
    endReason: str
    finalStage: str
    durationSeconds: float
    lines: list[TranscriptLine] = field(default_factory=list)
    redFlags: list[RedFlag] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "drillId": self.drillId,
            "language": self.language,
            "scenarioId": self.scenarioId,
            "scenarioVersion": self.scenarioVersion,
            "endReason": self.endReason,
            "finalStage": self.finalStage,
            "durationSeconds": self.durationSeconds,
            "redFlags": [flag.to_dict() for flag in self.redFlags],
            "transcript": [line.to_dict() for line in self.lines],
        }

    def with_lines(self, lines: list[TranscriptLine]) -> Transcript:
        return Transcript(
            drillId=self.drillId,
            language=self.language,
            scenarioId=self.scenarioId,
            scenarioVersion=self.scenarioVersion,
            endReason=self.endReason,
            finalStage=self.finalStage,
            durationSeconds=self.durationSeconds,
            lines=lines,
            redFlags=self.redFlags,
        )

    def rendered(self) -> str:
        """What the judge and the debrief writer actually read. Stage labels are included because
        `disconnected_early` is defined by the stage the call ended in, not by the words."""
        return "\n".join(f"[{line.stage}] {line.role}: {line.text}" for line in self.lines)


def _require(record: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> Any:
    if key not in record:
        raise TranscriptError(f"transcript is missing {key}")
    value = record[key]
    if not isinstance(value, kind):
        raise TranscriptError(f"transcript field {key} is {type(value).__name__}, expected {kind}")
    return value


def from_record(record: dict[str, Any]) -> Transcript:
    """Parse a `DrillRecord` dump. Hand validation, deliberately: see the module docstring."""
    if not isinstance(record, dict):
        raise TranscriptError(f"transcript is {type(record).__name__}, expected an object")
    raw_lines = _require(record, "transcript", list)
    lines: list[TranscriptLine] = []
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            raise TranscriptError(f"transcript line {index} is not an object")
        role = str(raw.get("role", ""))
        if role not in ("caller", "learner"):
            raise TranscriptError(f"transcript line {index} has role {role!r}")
        text = str(raw.get("text", ""))
        if not text.strip():
            continue  # an empty turn carries no evidence and the guardrail rejects empty content
        lines.append(
            TranscriptLine(
                seq=int(raw.get("seq", index)),
                t=float(raw.get("t", 0.0)),
                role=role,
                stage=str(raw.get("stage", "S0")),
                text=text,
            )
        )
    flags = [
        RedFlag(
            id=str(raw.get("id", "")),
            quote=str(raw.get("quote", "")),
            stage=str(raw.get("stage", "S0")),
            seq=int(raw.get("seq", 0)),
        )
        for raw in record.get("redFlags") or []
        if isinstance(raw, dict)
    ]
    return Transcript(
        drillId=str(_require(record, "drillId", str)),
        language=str(record.get("language") or "hi-IN"),
        scenarioId=str(record.get("scenarioId") or ""),
        scenarioVersion=int(record.get("scenarioVersion") or 0),
        endReason=str(record.get("endReason") or "unknown"),
        finalStage=str(record.get("finalStage") or "S0"),
        durationSeconds=float(record.get("durationSeconds") or 0.0),
        lines=lines,
        redFlags=flags,
    )


def load_transcript(s3: Any, bucket: str, key: str) -> Transcript:
    """Read `drill/transcript/<drillId>.json` out of S3 and parse it."""
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    try:
        record = json.loads(body)
    except json.JSONDecodeError as error:
        raise TranscriptError(f"s3://{bucket}/{key} is not valid JSON") from error
    return from_record(record)


# --- fixtures -------------------------------------------------------------------------------


def _advance(current: str, requested: str) -> str:
    """The session refuses a skip and refuses a step backwards (`session.advance_stage`). A
    fixture that asks for one is asserting that the refusal happens, so mirror it here or the
    replayed stage walk will not match the fixture's own `expect.finalStage`."""
    if requested not in STAGES:
        return current
    if STAGES.index(requested) != STAGES.index(current) + 1:
        return current
    return requested


def from_fixture(fixture: dict[str, Any], *, drill_id: str | None = None) -> Transcript:
    """Convert a fixture script into the transcript shape the pipeline reads.

    Steps are `{"caller": text, "tools": [...]}`, `{"learner": text}`, `{"hangup": true}`,
    `{"pause": seconds}` or `{"model_timeout": true}`. Stage comes from the `advance_stage` tool
    calls, red flags from the `record_red_flag` calls.
    """
    steps = _require(fixture, "steps", list)
    name = str(fixture.get("name") or "fixture")
    stage = STAGES[0]
    seq = 0
    t = 0.0
    lines: list[TranscriptLine] = []
    flags: list[RedFlag] = []
    end_reason = str((fixture.get("expect") or {}).get("endReason") or "")

    for step in steps:
        if not isinstance(step, dict):
            raise TranscriptError(f"fixture {name} has a step that is not an object")
        if step.get("pause"):
            t += float(step["pause"])
            continue
        if step.get("model_timeout"):
            continue
        if step.get("hangup"):
            end_reason = end_reason or "hangup"
            continue
        for tool in step.get("tools") or []:
            tool_name = tool.get("name")
            tool_input = tool.get("input") or {}
            if tool_name == "advance_stage":
                stage = _advance(stage, str(tool_input.get("stage", "")))
            elif tool_name == "record_red_flag":
                flags.append(
                    RedFlag(
                        id=str(tool_input.get("flag_id", "")),
                        quote=str(tool_input.get("quote", "")),
                        stage=stage,
                        seq=seq,
                    )
                )
            elif tool_name == "end_drill":
                end_reason = end_reason or str(tool_input.get("reason", "completed"))
        for role in ("caller", "learner"):
            raw_text = step.get(role)
            # A list is one utterance the fixture streams in partials, so the tripwire can fire
            # mid turn (`digit_sharer`). The transcript sees the whole turn.
            if isinstance(raw_text, list):
                raw_text = " ".join(str(part) for part in raw_text)
            text = raw_text
            if isinstance(text, str) and text.strip():
                seq += 1
                t += 1.0
                lines.append(TranscriptLine(seq=seq, t=t, role=role, stage=stage, text=text))

    return Transcript(
        drillId=drill_id or f"fixture-{name}",
        language=str(fixture.get("language") or "hi-IN"),
        scenarioId=str(fixture.get("scenario") or ""),
        scenarioVersion=1,
        endReason=end_reason or "completed",
        finalStage=stage,
        durationSeconds=t,
        lines=lines,
        redFlags=flags,
    )

"""Drill session state. Every limit lives here or in the runner, never in the prompt.

The session is the only thing tools mutate. It performs no I/O besides structured log lines;
persistence happens once, in the runner, when the session ends.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

from .log import event
from .tripwire import REDACTED, redact, trips

STAGES = ("S0", "S1", "S2", "S3", "S4", "S5")
Stage = Literal["S0", "S1", "S2", "S3", "S4", "S5"]

RED_FLAGS = ("stayed_on_call", "accepted_secrecy", "shared_identifier", "agreed_to_move_money", "accepted_authority")

EndReason = Literal[
    "completed",  # the caller reached the end of S5
    "safe_word",
    "is_this_real",
    "distress",
    "tripwire",
    "timeout",  # SESSION_MAX_SECONDS reached
    "hangup",  # the learner ended the call, a pass on the disconnect criterion
    "model_ended",  # end_drill with a reason outside the persona's vocabulary
    "error",
]
# Every ending except the learner's own hang up, or a crash, reveals the practice out loud.
SPEAKS_BREAK_CHARACTER: frozenset[str] = frozenset(
    {"completed", "safe_word", "is_this_real", "distress", "tripwire", "timeout", "model_ended"}
)

Role = Literal["caller", "learner"]


class DrillEvent(BaseModel):
    seq: int
    ts: str
    t: float  # seconds since the session started
    type: str
    stage: Stage
    payload: dict[str, Any] = {}


class TranscriptLine(BaseModel):
    seq: int
    t: float
    role: Role
    stage: Stage
    text: str


class RedFlag(BaseModel):
    id: str
    quote: str
    stage: Stage
    seq: int


class DrillRecord(BaseModel):
    """What a finished drill hands to persistence, and later to scoring."""

    drillId: str
    scenarioId: str
    scenarioVersion: int
    language: str
    voice: str
    promptVersions: dict[str, str]
    startedAt: str
    endedAt: str | None
    durationSeconds: float
    endReason: EndReason | None
    endSource: str | None
    finalStage: Stage
    maxSeconds: int
    redFlags: list[RedFlag]
    transcript: list[TranscriptLine]
    events: list[DrillEvent]


class DrillSession:
    def __init__(
        self,
        *,
        drill_id: str,
        scenario_id: str,
        scenario_version: int,
        language: str,
        voice: str,
        prompt_versions: dict[str, str],
        max_seconds: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.drill_id = drill_id
        self.scenario_id = scenario_id
        self.scenario_version = scenario_version
        self.language = language
        self.voice = voice
        self.prompt_versions = dict(prompt_versions)
        self.max_seconds = max_seconds
        self._clock = clock
        self._t0 = clock()
        self.started_at = datetime.now(UTC).isoformat()
        self.ended_at: str | None = None

        self.stage: Stage = "S0"
        self.red_flags: list[RedFlag] = []
        self.events: list[DrillEvent] = []
        self.transcript: list[TranscriptLine] = []
        self.end_reason: EndReason | None = None
        self.end_source: str | None = None
        self.ended = asyncio.Event()
        self._seq = 0
        self.log("session_started", language=language, scenario=scenario_id, maxSeconds=max_seconds)

    # ---- clock ------------------------------------------------------------------------------

    def elapsed(self) -> float:
        return round(self._clock() - self._t0, 3)

    def remaining(self) -> float:
        return max(0.0, self.max_seconds - self.elapsed())

    # ---- event log --------------------------------------------------------------------------

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def log(self, type_: str, level: int = logging.INFO, **payload: Any) -> DrillEvent:
        entry = DrillEvent(
            seq=self._next_seq(),
            ts=datetime.now(UTC).isoformat(),
            t=self.elapsed(),
            type=type_,
            stage=self.stage,
            payload=payload,
        )
        self.events.append(entry)
        event(type_, self.drill_id, level=level, seq=entry.seq, stage=entry.stage, **payload)
        return entry

    # ---- tools (the only mutations the model can request) ------------------------------------

    def advance_stage(self, to: str) -> str:
        """One stage forward at a time, never back, never past S5. Refusals are logged."""
        if self.ended.is_set():
            return "The call has ended."
        current = STAGES.index(self.stage)
        if current == len(STAGES) - 1:
            self.log("stage_refused", requested=to, reason="past_final_stage")
            return "Refused. S5 is the last stage. When S5 is finished, call end_drill."
        expected = STAGES[current + 1]
        if to != expected:
            self.log("stage_refused", requested=to, reason="not_next_stage", expected=expected)
            return f"Refused. You are in {self.stage}. The only allowed next stage is {expected}."
        previous = self.stage
        self.stage = expected  # type: ignore[assignment]
        self.log("stage_advanced", previous=previous)
        return f"Now in {self.stage}."

    def record_red_flag(self, flag_id: str, quote: str) -> str:
        if self.ended.is_set():
            return "The call has ended."
        if flag_id not in RED_FLAGS:
            self.log("red_flag_refused", flag=flag_id)
            return f"Unknown flag. Use one of: {', '.join(RED_FLAGS)}."
        if trips(quote):
            # The model is repeating a number the learner said. That is a disclosure: stop now.
            self.log("red_flag_quote_dropped", flag=flag_id)
            self.end("tripwire", source="red_flag_quote")
            return "Recorded."
        entry = self.log("red_flag", flag=flag_id)
        self.red_flags.append(RedFlag(id=flag_id, quote=quote[:300], stage=self.stage, seq=entry.seq))
        return "Recorded."

    def model_tripwire(self, kind: str) -> str:
        self.end("tripwire", source="model", kind=kind[:40])
        return "Tripwire recorded. The call is ending."

    def model_end(self, reason: str) -> str:
        mapped: EndReason = reason if reason in ("safe_word", "completed") else "model_ended"  # type: ignore[assignment]
        self.end(mapped, source="model", requested=reason[:40])
        return "The call is ending."

    # ---- transport ---------------------------------------------------------------------------

    def transport_tripwire(self, kind: str) -> None:
        """Fired by the runner on a user fragment. The fragment itself is never stored."""
        self.end("tripwire", source="transport", kind=kind)

    def add_learner_text(self, text: str) -> None:
        """A complete learner turn. Checked again as a whole; a tripping turn is dropped whole."""
        if self.ended.is_set() and self.end_reason == "tripwire":
            return
        stored = redact(text)
        if stored == REDACTED:
            self.log("learner_turn_dropped", reason="tripwire")
            self.end("tripwire", source="transport", kind="complete_turn")
            return
        self._append_line("learner", stored)

    def add_caller_text(self, text: str) -> None:
        stored = redact(text)
        if stored == REDACTED:
            # The caller must never speak a number run; log it so the persona can be fixed.
            self.log("caller_turn_redacted", level=logging.WARNING)
        self._append_line("caller", stored)

    def _append_line(self, role: Role, text: str) -> None:
        if not text.strip():
            return
        seq = self._next_seq()
        self.transcript.append(TranscriptLine(seq=seq, t=self.elapsed(), role=role, stage=self.stage, text=text))

    # ---- ending ------------------------------------------------------------------------------

    def end(self, reason: EndReason, source: str, **payload: Any) -> bool:
        """Idempotent. The first reason wins; later ones are logged and ignored."""
        if self.ended.is_set():
            if reason != self.end_reason:
                self.log("end_ignored", reason=reason, source=source)
            return False
        self.end_reason = reason
        self.end_source = source
        self.ended_at = datetime.now(UTC).isoformat()
        self.log("session_ended", reason=reason, source=source, **payload)
        self.ended.set()
        return True

    def to_record(self) -> DrillRecord:
        return DrillRecord(
            drillId=self.drill_id,
            scenarioId=self.scenario_id,
            scenarioVersion=self.scenario_version,
            language=self.language,
            voice=self.voice,
            promptVersions=self.prompt_versions,
            startedAt=self.started_at,
            endedAt=self.ended_at,
            durationSeconds=self.elapsed(),
            endReason=self.end_reason,
            endSource=self.end_source,
            finalStage=self.stage,
            maxSeconds=self.max_seconds,
            redFlags=list(self.red_flags),
            transcript=list(self.transcript),
            events=list(self.events),
        )

    def state_note(self) -> str:
        """Carried into the system prompt when the model connection is replaced mid call."""
        flags = ", ".join(sorted({f.id for f in self.red_flags})) or "none"
        return (
            "\n\nCALL STATE, the connection was renewed mid call and the person did not notice. "
            f"You are in stage {self.stage}. Red flags recorded so far: {flags}. "
            "Continue from exactly where the conversation left off. Do not greet again."
        )

"""Builds the drill agent and runs one call end to end. Transport agnostic: the local terminal
(Phase 2) and the WebSocket server (Phase 3) differ only in the AudioSource and AudioSink.

Order of authority, highest first:
1. The transport tripwire and stop phrases, run here on every user fragment before storage
2. The session cap timer
3. The model's own tools (tripwire, end_drill), which can only end the call, never extend it
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
from collections.abc import Callable

import boto3
from strands.experimental.bidi import (
    BidiAgent,
    BidiAudioStreamEvent,
    BidiConnectionRestartEvent,
    BidiConnectionWarningEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
    ToolUseStreamEvent,
)
from strands.experimental.bidi.hooks import BidiBeforeConnectionRestartEvent
from strands.experimental.bidi.models import BidiModel

from .audio import NOVA_AUDIO_CONFIG, AudioSink, AudioSource, BreakAudio, pump_source
from .config import AgentSettings
from .prompts import render_persona
from .safety import StopPhrases
from .scenario import Language, Scenario
from .session import SPEAKS_BREAK_CHARACTER, DrillRecord, DrillSession
from .tools import build_tools
from .tripwire import Tripwire, redact

AGENT_STOP_TIMEOUT_SECONDS = 5.0
# The broad `except Exception` blocks below are deliberate (BLE001): at the call boundary any
# failure must end the session and still persist the record, never leave a hung call.

Caption = Callable[[str, str], None]  # (role, already redacted text)


def build_model(settings: AgentSettings, voice: str) -> BidiModel:
    from strands.experimental.bidi.models import BedrockNovaSonicModel

    return BedrockNovaSonicModel(
        boto_session=boto3.Session(region_name=settings.voice_region),
        model_id=settings.sonic_model_id,
        voice=voice,
        audio=NOVA_AUDIO_CONFIG,  # type: ignore[arg-type]
        connection={"restart_after_s": settings.model_restart_after_seconds},
    )


def build_agent(
    settings: AgentSettings,
    scenario: Scenario,
    language: Language,
    session: DrillSession,
    model: BidiModel | None = None,
) -> BidiAgent:
    persona = render_persona(language, scenario, settings.safe_word)
    agent = BidiAgent(
        model=model or build_model(settings, scenario.voices[language]),
        system_prompt=persona,
        tools=build_tools(session),  # type: ignore[arg-type]
        name="chaukanna-drill",
    )

    async def carry_state(event: BidiBeforeConnectionRestartEvent) -> None:
        # The replacement connection gets the persona plus where the call is, so the learner
        # does not hear the caller start over.
        event.agent.system_prompt = persona + session.state_note()
        session.log("model_reconnecting", reason=event.reason)

    agent.add_hook(carry_state, BidiBeforeConnectionRestartEvent)
    return agent


class DrillRunner:
    def __init__(
        self,
        *,
        session: DrillSession,
        agent: BidiAgent,
        source: AudioSource,
        sink: AudioSink,
        stop_phrases: StopPhrases,
        break_audio: BreakAudio | None,
        kickoff_text: str,
        persist: Callable[[DrillRecord], None],
        on_caption: Caption | None = None,
    ) -> None:
        self.session = session
        self.agent = agent
        self.source = source
        self.sink = sink
        self.stop_phrases = stop_phrases
        self.break_audio = break_audio
        self.kickoff_text = kickoff_text
        self.persist = persist
        self.on_caption = on_caption
        self._tripwire = Tripwire()
        self._user_turn: list[str] = []  # in memory only, never persisted
        self._first_audio_logged = False
        self._usage: dict[str, int] = {}
        self._stopped = asyncio.Event()

    def hangup(self) -> None:
        """The learner ended the call."""
        self.session.end("hangup", source="learner")

    async def learner_text(self, text: str) -> None:
        """A typed learner turn (rehearsals and tests). Same transport checks as speech, and it is
        sent to the model only if those checks let the call continue."""
        self._on_user_fragment(text)
        self._user_turn.clear()
        if self.session.ended.is_set():
            return
        self.session.add_learner_text(text)
        if not self.session.ended.is_set():
            await self.agent.send(text)

    async def run(self) -> DrillRecord:
        session = self.session
        await self.sink.start()
        await self.source.start()
        tasks: list[asyncio.Task[None]] = []
        try:
            await self.agent.start()
            session.log("model_connected")
            tasks.append(asyncio.create_task(self._pump()))
            tasks.append(asyncio.create_task(self._consume()))
            tasks.append(asyncio.create_task(self._cap()))
            await self.agent.send(self.kickoff_text)
            session.log("kickoff_sent")
            await session.ended.wait()
        except Exception as error:  # noqa: BLE001
            session.log("drill_error", level=logging.ERROR, errorName=type(error).__name__)
            session.end("error", source="runner")
        finally:
            await self._teardown(tasks)
        record = session.to_record()
        self.persist(record)
        return record

    async def _pump(self) -> None:
        try:
            await pump_source(self.agent, self.source, self._stopped)
        except Exception as error:  # noqa: BLE001
            if not self._stopped.is_set():
                self.session.log("audio_input_error", level=logging.ERROR, errorName=type(error).__name__)
                self.session.end("error", source="audio_input")

    async def _cap(self) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.session.ended.wait(), timeout=self.session.remaining())
            return
        self.session.end("timeout", source="timer")

    async def _consume(self) -> None:
        try:
            async for event in self.agent.receive():
                self._handle(event)
                if self.session.ended.is_set():
                    return
        except Exception as error:  # noqa: BLE001
            if not self.session.ended.is_set():
                self.session.log("model_error", level=logging.ERROR, errorName=type(error).__name__)
                self.session.end("error", source="model")
            return
        if not self.session.ended.is_set():
            self.session.end("error", source="model_stream_closed")

    def _handle(self, event: BidiOutputEvent | object) -> None:
        session = self.session
        if isinstance(event, BidiAudioStreamEvent):
            if session.ended.is_set():
                return
            if not self._first_audio_logged:
                self._first_audio_logged = True
                session.log("first_caller_audio")
            self.sink.play(base64.b64decode(event.audio))
        elif isinstance(event, BidiInterruptionEvent):
            self.sink.clear()
            session.log("barge_in")
        elif isinstance(event, BidiTranscriptStreamEvent):
            if event.role == "user":
                self._on_user_fragment(event.delta)
            elif self.on_caption and not session.ended.is_set():
                self.on_caption("caller", redact(event.delta))
        elif isinstance(event, BidiTranscriptCompleteEvent):
            if event.role == "user":
                self._user_turn.clear()
                session.add_learner_text(event.transcript)
            else:
                session.add_caller_text(event.transcript)
        elif isinstance(event, ToolUseStreamEvent):
            session.log("tool_call", tool=str(event["current_tool_use"].get("name", "")))
        elif isinstance(event, BidiConnectionRestartEvent):
            session.log("model_reconnected", reason=event.reason, turnInterrupted=event.turn_interrupted)
        elif isinstance(event, BidiConnectionWarningEvent):
            session.log("model_reconnect_soon", secondsLeft=event.time_left_s)
        elif isinstance(event, BidiUsageEvent):
            self._usage = {"inputTokens": event.input_tokens, "outputTokens": event.output_tokens}

    def _on_user_fragment(self, delta: str) -> None:
        """The transport tripwire. Runs before the fragment goes anywhere else."""
        session = self.session
        if session.ended.is_set():
            return
        trip = self._tripwire.check(delta)
        if trip is not None:
            session.transport_tripwire(trip.kind)
            return
        self._user_turn.append(delta)
        stop = self.stop_phrases.check(" ".join(self._user_turn))
        if stop is not None:
            session.end(stop.kind, source="transport")
            return
        if self.on_caption:
            self.on_caption("learner", delta)

    async def _teardown(self, tasks: list[asyncio.Task[None]]) -> None:
        session = self.session
        self._stopped.set()
        self.sink.clear()  # cut the caller mid sentence
        speak = self.break_audio is not None and session.end_reason in SPEAKS_BREAK_CHARACTER

        async def stop_agent() -> None:
            try:
                await asyncio.wait_for(self.agent.stop(), timeout=AGENT_STOP_TIMEOUT_SECONDS)
            except Exception as error:  # noqa: BLE001
                session.log("model_stop_error", level=logging.WARNING, errorName=type(error).__name__)

        async def break_character() -> None:
            if speak and self.break_audio is not None:
                session.log("break_character_played")
                self.sink.play(self.break_audio.pcm)
                await self.sink.drain()

        await asyncio.gather(stop_agent(), break_character())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.source.stop()
        await self.sink.stop()
        if self._usage:
            session.log("model_usage", **self._usage)

"""The drill as a server: the same call as `chaukanna_agent.local`, driven by a browser.

AgentCore Runtime routes a WebSocket to `/ws` on port 8080 and health checks `/ping`; both come
from `BedrockAgentCoreApp`. Each connection gets its own microVM, so this process serves exactly
one drill and state can live in locals.

Run it locally:

    DATA_REGION=ap-south-1 TABLE_NAME=chaukanna ARTIFACTS_BUCKET=... VOICE_REGION=ap-northeast-1 \
      AWS_PROFILE=chaukanna uv run python -m chaukanna_agent.server

The order of authority from `drill.py` is unchanged and this file adds nothing to it. What it adds
is what has to be true *before* the caller says a word:

1. the token is signed by us, is unexpired, and says which drill this is
2. the member is still consented, checked now and not only when the token was minted
3. the drill is claimed, once, by a conditional write

Only then does the model connect.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from bedrock_agentcore import BedrockAgentCoreApp

from . import wire
from .audio import CallerRecorder, load_break_audio
from .config import ServerSettings
from .drill import DrillRunner, build_agent
from .log import configure_logging, event
from .prompts import PROMPT_VERSIONS, break_character_text, render_kickoff
from .safety import StopPhrases
from .scenario import Scenario, load_scenario
from .session import DrillSession
from .session_token import DrillSessionClaims, InvalidToken, signing_key, verify
from .store import DrillClaimError, DrillStore, transcript_key
from .transport import BrowserTransport, TransportClosed, read_hello

app = BedrockAgentCoreApp()

# Built once per process. One microVM serves one drill, so "per process" is "per call", but a
# retried connection should not pay for the secret or the scenario file twice.
_settings: ServerSettings | None = None
_store: DrillStore | None = None
_scenario: Scenario | None = None


def settings() -> ServerSettings:
    global _settings
    if _settings is None:
        _settings = ServerSettings.from_env()
    return _settings


def store() -> DrillStore:
    global _store
    if _store is None:
        current = settings()
        _store = DrillStore(
            region=current.data_region,
            table_name=current.table_name,
            bucket=current.artifacts_bucket,
            scoring_state_machine_arn=current.scoring_state_machine_arn,
        )
    return _store


def scenario() -> Scenario:
    global _scenario
    if _scenario is None:
        _scenario = load_scenario(settings().scenario_id)
    return _scenario


@app.websocket
async def drill_socket(websocket: Any, context: Any) -> None:
    await websocket.accept()
    claims: DrillSessionClaims | None = None
    try:
        claims = await _admit(websocket)
    except _Rejected as rejection:
        await _reject(websocket, rejection.code)
        return
    except TransportClosed:
        event("drill_socket_abandoned", "unknown", level=logging.WARNING)
        return

    event("drill_socket_admitted", claims.drill_id, session=getattr(context, "session_id", None))
    try:
        await _run_drill(websocket, claims)
    except Exception as error:  # noqa: BLE001 - the call is over either way; free the drill row
        event("drill_socket_failed", claims.drill_id, level=logging.ERROR, errorName=type(error).__name__)
        await asyncio.to_thread(
            store().release,
            member_id=claims.member_id,
            scheduled_at=claims.scheduled_at,
            drill_id=claims.drill_id,
            reason="server_error",
        )
        await _reject(websocket, "internal")


class _Rejected(Exception):
    def __init__(self, code: wire.ErrorCode) -> None:
        super().__init__(code)
        self.code: wire.ErrorCode = code


async def _admit(websocket: Any) -> DrillSessionClaims:
    """Everything that must be true before the model is allowed to connect."""
    try:
        hello = await read_hello(websocket)
    except ValueError as error:
        raise _Rejected("bad_hello") from error

    try:
        key = await asyncio.to_thread(signing_key, settings().data_region)
    except Exception as error:
        # Not the learner's fault, and not something to report as a bad token: say so plainly and
        # close, rather than letting the handler die and the browser see a bare 1011.
        event("drill_signing_key_unavailable", "unknown", level=logging.ERROR, errorName=type(error).__name__)
        raise _Rejected("internal") from error

    try:
        claims = verify(hello.token, key)
    except InvalidToken as error:
        event("drill_token_rejected", "unknown", level=logging.WARNING)
        raise _Rejected("invalid_token") from error

    current = store()
    try:
        await asyncio.to_thread(current.assert_member_active, claims.household_id, claims.member_id)
        await asyncio.to_thread(
            current.claim,
            member_id=claims.member_id,
            scheduled_at=claims.scheduled_at,
            drill_id=claims.drill_id,
            jti=claims.jti,
        )
    except DrillClaimError as error:
        event("drill_claim_refused", claims.drill_id, level=logging.WARNING, code=error.code)
        raise _Rejected(error.code) from error  # type: ignore[arg-type]
    return claims


async def _reject(websocket: Any, code: wire.ErrorCode) -> None:
    with contextlib.suppress(Exception):
        await websocket.send_json(wire.error(code))
    with contextlib.suppress(Exception):
        await websocket.close(code=wire.CLOSE_POLICY)


async def _run_drill(websocket: Any, claims: DrillSessionClaims) -> None:
    current = settings()
    agent_settings = current.agent.model_copy(update={"session_max_seconds": claims.max_seconds})
    call = scenario()
    language = claims.language

    session = DrillSession(
        drill_id=claims.drill_id,
        scenario_id=call.id,
        scenario_version=call.version,
        language=language,
        voice=call.voices[language],  # type: ignore[index]
        prompt_versions=PROMPT_VERSIONS,
        max_seconds=agent_settings.session_max_seconds,
    )
    break_audio = _break_audio(session, language, allow_missing=current.allow_missing_break_audio)

    runner: DrillRunner | None = None

    def on_hangup() -> None:
        if runner is not None:
            runner.hangup()

    def on_closed() -> None:
        # A dropped socket is a failed drill, never a hang up: the rubric credits hanging up.
        if not session.ended.is_set():
            session.end("error", source="transport_closed")

    transport = BrowserTransport(websocket, drill_id=claims.drill_id, on_hangup=on_hangup, on_closed=on_closed)
    sink = CallerRecorder(transport.sink, max_seconds=agent_settings.session_max_seconds + 30)

    def caption(role: str, text: str) -> None:
        transport.sink.send_control(wire.caption(role, text))

    runner = DrillRunner(
        session=session,
        agent=build_agent(agent_settings, call, language, session),  # type: ignore[arg-type]
        source=transport.source,
        sink=sink,
        stop_phrases=StopPhrases(agent_settings.safe_word, agent_settings.safe_word_spellings),
        break_audio=break_audio,
        kickoff_text=render_kickoff(language),  # type: ignore[arg-type]
        # Persistence is deliberately not done here. It happens once the browser has been told the
        # call is over, so nobody is left staring at a live screen while S3 is written.
        persist=lambda _record: None,
        on_caption=caption,
    )

    transport.sink.send_control(
        wire.ready(
            claims.drill_id,
            max_seconds=agent_settings.session_max_seconds,
            safe_word=agent_settings.safe_word,
            language=language,
        )
    )
    transport.start_reading()
    record = await runner.run()

    with contextlib.suppress(Exception):
        await websocket.send_json(wire.ended(record.endReason, record.finalStage, record.durationSeconds))
    await transport.stop()

    await asyncio.to_thread(
        store().finish,
        record,
        member_id=claims.member_id,
        scheduled_at=claims.scheduled_at,
        caller_pcm=sink.caller_pcm,
    )
    # Scoring starts last, on purpose: after the browser has been told the call is over, so no
    # learner waits on the pipeline, and after `finish` returned, so the transcript object the
    # execution is about to be handed the key to actually exists. `start_scoring` never raises;
    # a drill that could not be handed over is unscored, which the debrief screen handles.
    try:
        await asyncio.to_thread(
            store().start_scoring,
            record,
            member_id=claims.member_id,
            scheduled_at=claims.scheduled_at,
            household_id=claims.household_id,
            transcript_key=transcript_key(record.drillId),
        )
    except Exception as error:  # noqa: BLE001 - the store already swallows; this is the backstop
        # Nothing after a finished drill may become a learner-facing error or a `release` of a row
        # that is already `ended`. Log it and close the socket the way a good call closes.
        event("drill_scoring_start_failed", claims.drill_id, level=logging.WARNING, errorName=type(error).__name__)
    with contextlib.suppress(Exception):
        await websocket.close(code=wire.CLOSE_NORMAL)


def _break_audio(session: DrillSession, language: str, *, allow_missing: bool) -> Any:
    try:
        return load_break_audio(language, break_character_text(language))  # type: ignore[arg-type]
    except (FileNotFoundError, RuntimeError) as error:
        if not allow_missing:
            raise
        session.log("break_character_audio_missing", level=logging.WARNING, errorName=type(error).__name__)
        return None


def main() -> None:
    configure_logging()
    current = settings()  # fail at startup on a missing variable, not on the first learner's call
    try:
        # Warm the secret so a wrong execution role shows up in the deploy logs rather than as a
        # learner's call that will not connect. A failure here is logged, not fatal: the container
        # still answers /ping, and the operator sees exactly one line saying why calls will fail.
        signing_key(current.data_region)
    except Exception as error:  # noqa: BLE001
        event("drill_signing_key_unavailable", "startup", level=logging.ERROR, errorName=type(error).__name__)
    app.run()


if __name__ == "__main__":
    main()

"""Rehearse the persona against the real Nova 2 Sonic session with typed learner turns.

    AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1 uv run python scripts/rehearse.py --script compliant_then_safe_word

No microphone needed. Each learner line goes through the same transport tripwire and stop phrases as
speech. Use it to check stage escalation and tool calls before a voice run; it is not a substitute
for the voice run the Phase 2 gate asks for.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import uuid
from pathlib import Path

from chaukanna_agent.audio import AudioSink, AudioSource, silence
from chaukanna_agent.config import AgentSettings
from chaukanna_agent.drill import DrillRunner, build_agent
from chaukanna_agent.log import configure_logging
from chaukanna_agent.prompts import PROMPT_VERSIONS, render_kickoff
from chaukanna_agent.safety import StopPhrases
from chaukanna_agent.scenario import load_scenario
from chaukanna_agent.session import DrillRecord, DrillSession

SCRIPTS = {
    # Goes along with the caller, then says the safe word once the fear stage has landed.
    "compliant_then_safe_word": [
        "Haan ji, main Kamla bol rahi hoon.",
        "Theek hai, main line par hoon.",
        "Achha, case? Main kya karoon?",
        "Theek hai, main kisi ko nahi bataungi.",
        "Roko.",
    ],
    # Goes along until the identifier stage, then reads out a number.
    "digit_sharer": [
        "Haan ji, main Kamla bol rahi hoon.",
        "Theek hai, main line par hoon.",
        "Ji, main sahyog karungi.",
        "Theek hai, kisi ko nahi bataungi.",
        "Haan likhiye, nau aath saat chhe paanch chaar teen do.",
    ],
}
RUNS = Path(__file__).resolve().parents[1] / "runs"
TURN_WAIT_SECONDS = 25
log = logging.getLogger("rehearse")


class Silence(AudioSource):
    async def read(self) -> bytes:
        await asyncio.sleep(0.032)
        return silence(0.032)


class Discard(AudioSink):
    def play(self, pcm: bytes) -> None:
        return None

    def clear(self) -> None:
        return None

    async def drain(self) -> None:
        return None


async def caller_turns(session: DrillSession, count: int) -> None:
    """Wait until the caller has finished `count` turns, or the call ended."""
    while not session.ended.is_set():
        if sum(1 for line in session.transcript if line.role == "caller") >= count:
            await asyncio.sleep(0.8)
            return
        await asyncio.sleep(0.1)


async def main(script_name: str) -> int:
    settings = AgentSettings.from_env()
    scenario = load_scenario("digital_arrest_v1")
    language = "hi-IN"
    session = DrillSession(
        drill_id=f"rehearse-{uuid.uuid4().hex[:10]}",
        scenario_id=scenario.id,
        scenario_version=scenario.version,
        language=language,
        voice=scenario.voices[language],
        prompt_versions=PROMPT_VERSIONS,
        max_seconds=settings.session_max_seconds,
    )
    records: list[DrillRecord] = []
    runner = DrillRunner(
        session=session,
        agent=build_agent(settings, scenario, language, session),
        source=Silence(),
        sink=Discard(),
        stop_phrases=StopPhrases(settings.safe_word),
        break_audio=None,
        kickoff_text=render_kickoff(language),
        persist=records.append,
    )

    async def learner() -> None:
        for turn, line in enumerate(SCRIPTS[script_name], start=1):
            try:
                await asyncio.wait_for(caller_turns(session, turn), TURN_WAIT_SECONDS)
            except TimeoutError:
                log.warning("caller did not finish turn %d in time", turn)
            if session.ended.is_set():
                return
            await runner.learner_text(line)
        await asyncio.sleep(TURN_WAIT_SECONDS)
        runner.hangup()

    task = asyncio.create_task(learner())
    record = await runner.run()
    task.cancel()
    RUNS.mkdir(exist_ok=True)
    out = RUNS / f"{record.drillId}.json"
    out.write_text(record.model_dump_json(indent=2), encoding="utf-8")
    for line in record.transcript:
        log.info("[%s] %-7s %s", line.stage, line.role, line.text)
    stages = [e.stage for e in record.events if e.type == "stage_advanced"]
    flags = [f.id for f in record.redFlags]
    log.info(
        "end=%s source=%s final=%s stages=%s flags=%s saved=%s",
        record.endReason,
        record.endSource,
        record.finalStage,
        stages,
        flags,
        out.name,
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", choices=sorted(SCRIPTS), default="compliant_then_safe_word")
    configure_logging(logging.WARNING)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(asyncio.run(main(parser.parse_args().script)))

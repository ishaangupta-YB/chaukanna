"""Replays every fixture in fixtures/transcripts through the real runner and BidiAgent loop.

The fixtures are the contract (docs/AGENT_PROMPTS.md section 8): the tripwire fires in every digit
case, the safe word works at every stage, no stage is skipped, nothing past S5, no number is ever
stored, the caller never breaks a hard limit, and the break character script plays whenever the
call did not end with the learner hanging up.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from chaukanna_agent.audio import AudioSink, AudioSource, BreakAudio, silence
from chaukanna_agent.config import AgentSettings
from chaukanna_agent.drill import DrillRunner, build_agent
from chaukanna_agent.prompts import PROMPT_VERSIONS, render_kickoff
from chaukanna_agent.safety import StopPhrases, caller_violations
from chaukanna_agent.scenario import load_scenario
from chaukanna_agent.session import SPEAKS_BREAK_CHARACTER, STAGES, DrillRecord, DrillSession
from chaukanna_agent.tripwire import trips
from tests.conftest import FIXTURES
from tests.scripted_model import ScriptedModel

FIXTURE_FILES = sorted((FIXTURES / "transcripts").glob("*.json"))
BREAK_PCM = silence(0.02)
REQUIRED_FIXTURES = {
    "immediate_hangup",
    "polite_refusal",
    "compliant",
    "digit_sharer",
    "distressed",
    "silence",
    "code_switcher",
    "safe_word_s1",
    "safe_word_s4",
    "timeout",
}


class SilentSource(AudioSource):
    async def read(self) -> bytes:
        await asyncio.sleep(0.01)
        return silence(0.032)


class RecordingSink(AudioSink):
    def __init__(self, session: DrillSession) -> None:
        self.session = session
        self.model_chunks_after_end = 0
        self.model_chunks = 0
        self.break_played = False

    def play(self, pcm: bytes) -> None:
        if pcm is BREAK_PCM:
            self.break_played = True
            return
        self.model_chunks += 1
        if self.session.ended.is_set():
            self.model_chunks_after_end += 1

    def clear(self) -> None:
        return None

    async def drain(self) -> None:
        return None


async def replay(fixture: dict[str, Any]) -> tuple[DrillRecord, RecordingSink, ScriptedModel]:
    # Short caps keep the timeout fixtures fast; the session enforces whatever cap it is given.
    settings = AgentSettings(voice_region="test-region")
    scenario = load_scenario(fixture["scenario"])
    language = fixture["language"]
    session = DrillSession(
        drill_id=f"fixture-{fixture['name']}",
        scenario_id=scenario.id,
        scenario_version=scenario.version,
        language=language,
        voice=scenario.voices[language],
        prompt_versions=PROMPT_VERSIONS,
        max_seconds=fixture["maxSeconds"],
    )
    model = ScriptedModel(fixture["steps"], hangup=lambda: session.end("hangup", source="learner"))
    agent = build_agent(settings, scenario, language, session, model=model)
    sink = RecordingSink(session)
    persisted: list[DrillRecord] = []
    runner = DrillRunner(
        session=session,
        agent=agent,
        source=SilentSource(),
        sink=sink,
        stop_phrases=StopPhrases(settings.safe_word),
        break_audio=BreakAudio(pcm=BREAK_PCM, text_sha256="test", voice="test"),
        kickoff_text=render_kickoff(language),
        persist=persisted.append,
    )
    record = await asyncio.wait_for(runner.run(), timeout=fixture["maxSeconds"] + 10)
    assert persisted == [record], "the record is persisted exactly once"
    return record, sink, model


def test_all_required_fixtures_exist() -> None:
    assert REQUIRED_FIXTURES <= {p.stem for p in FIXTURE_FILES}


@pytest.mark.parametrize("path", FIXTURE_FILES, ids=[p.stem for p in FIXTURE_FILES])
def test_fixture(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    expect = fixture["expect"]
    record, sink, model = asyncio.run(replay(fixture))
    dumped = record.model_dump_json()

    # the ending
    assert record.endReason == expect["endReason"], [e.type for e in record.events]
    assert record.finalStage == expect["finalStage"]
    assert sorted(f.id for f in record.redFlags) == sorted(expect["redFlags"])
    assert record.durationSeconds <= fixture["maxSeconds"] + 1

    # break character plays unless the learner hung up, and the caller is cut the moment it ends
    assert sink.break_played is expect["breakCharacter"]
    assert sink.break_played is (record.endReason in SPEAKS_BREAK_CHARACTER)
    assert sink.model_chunks_after_end == 0

    # stages: one step at a time, in order, never past S5
    advanced = [e for e in record.events if e.type == "stage_advanced"]
    assert [e.stage for e in advanced] == list(STAGES[1 : len(advanced) + 1])
    refused = [e for e in record.events if e.type == "stage_refused"]
    assert len(refused) == expect.get("refusedStages", 0)

    # nothing stored may trip, and fixture-specific leaks must be absent
    for line in record.transcript:
        assert not trips(line.text), line
    for flag in record.redFlags:
        assert not trips(flag.quote), flag
    for needle in expect.get("mustNotContain", []):
        assert needle not in dumped
    for needle in expect.get("mustContain", []):
        assert needle in dumped

    # the caller never breaks a hard limit
    for line in record.transcript:
        if line.role == "caller":
            assert caller_violations(line.text) == [], line.text
    assert not [e for e in record.events if e.type == "caller_limit_violation"]

    # the log is ordered and the session ended exactly once
    seqs = [e.seq for e in record.events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert [e.type for e in record.events].count("session_ended") == 1
    assert set(model.tool_names) == {"advance_stage", "record_red_flag", "tripwire", "end_drill"}

    # reconnects keep the call where it was
    reconnects = [e for e in record.events if e.type == "model_reconnected"]
    assert len(reconnects) == expect.get("reconnects", 0)
    if reconnects:
        assert len(model.system_prompts) == 1 + len(reconnects)
        assert "stage S2" in model.system_prompts[-1] and "stayed_on_call" in model.system_prompts[-1]

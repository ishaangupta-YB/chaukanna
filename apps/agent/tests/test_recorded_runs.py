"""Invariants for real recorded drills in fixtures/recorded (see the README there)."""

import json
from pathlib import Path

import pytest

from chaukanna_agent.safety import caller_violations
from chaukanna_agent.session import STAGES, DrillRecord
from chaukanna_agent.tripwire import trips
from tests.conftest import FIXTURES

RECORDED = sorted((FIXTURES / "recorded").glob("*.json"))


@pytest.mark.skipif(not RECORDED, reason="no recorded drills yet")
@pytest.mark.parametrize("path", RECORDED, ids=[p.stem for p in RECORDED])
def test_recorded_run(path: Path) -> None:
    record = DrillRecord.model_validate(json.loads(path.read_text(encoding="utf-8")))
    assert record.endReason is not None
    assert [e.type for e in record.events].count("session_ended") == 1
    advanced = [e.stage for e in record.events if e.type == "stage_advanced"]
    assert advanced == list(STAGES[1 : len(advanced) + 1])
    for line in record.transcript:
        assert not trips(line.text), line.seq
        if line.role == "caller":
            assert caller_violations(line.text) == [], line.seq
    for flag in record.redFlags:
        assert not trips(flag.quote)
    # A caller turn that broke a hard limit is stored redacted, so the event is the evidence.
    assert not [e for e in record.events if e.type == "caller_limit_violation"], "the persona broke a hard limit"

"""The tripwire contract. A failure here blocks the deploy (see deploy-agent.yml)."""

import json

import pytest

from chaukanna_agent.tripwire import REDACTED, RUN_CARRY_SECONDS, Tripwire, redact, trips
from tests.conftest import FIXTURES

UTTERANCES = [
    json.loads(line)
    for line in (FIXTURES / "utterances" / "tripwire.jsonl").read_text(encoding="utf-8").splitlines()
    if line.strip()
]


@pytest.mark.parametrize("case", UTTERANCES, ids=[c["note"] for c in UTTERANCES])
def test_utterance_fixture(case: dict) -> None:
    assert trips(case["text"]) is case["trips"], case["note"]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_run_split_across_fragments_still_trips() -> None:
    clock = FakeClock()
    wire = Tripwire(clock=clock)
    assert wire.check("mera number hai nau aath saat") is None
    clock.now += 2
    trip = wire.check("chhe paanch chaar")
    assert trip is not None and trip.kind == "digits"


def test_run_resets_after_a_pause() -> None:
    clock = FakeClock()
    wire = Tripwire(clock=clock)
    assert wire.check("nau aath saat") is None
    clock.now += RUN_CARRY_SECONDS + 1
    assert wire.check("chhe paanch chaar") is None


def test_run_resets_on_ordinary_words() -> None:
    wire = Tripwire(clock=FakeClock())
    assert wire.check("ek do teen, phir maine socha, chaar paanch chhe") is None


def test_numerals_split_mid_number_across_fragments() -> None:
    clock = FakeClock()
    wire = Tripwire(clock=clock)
    assert wire.check("98") is None
    clock.now += 0.5
    assert wire.check("7654") is not None


@pytest.mark.parametrize("kind,text", [("pan_like", "ABCDE1234F"), ("upi_like", "a.b@okicici"), ("otp", "otp 123")])
def test_trip_kinds(kind: str, text: str) -> None:
    trip = Tripwire(clock=FakeClock()).check(text)
    assert trip is not None and trip.kind == kind


def test_redact_drops_tripping_text_whole_and_keeps_the_helpline() -> None:
    assert redact("mera number 98765 43210") == REDACTED
    assert redact("main 1930 par call karungi") == "main 1930 par call karungi"

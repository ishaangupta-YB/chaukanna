"""Session limits: stage order, end reasons, and what may be stored."""

import pytest

from chaukanna_agent.safety import StopPhrases
from chaukanna_agent.session import STAGES, DrillSession
from chaukanna_agent.tripwire import REDACTED


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def make(max_seconds: int = 60, clock: Clock | None = None) -> DrillSession:
    return DrillSession(
        drill_id="test",
        scenario_id="digital_arrest_v1",
        scenario_version=1,
        language="hi-IN",
        voice="arjun",
        prompt_versions={"persona": "drill.persona.v1"},
        max_seconds=max_seconds,
        clock=clock or Clock(),
    )


def test_stages_advance_one_at_a_time_to_s5_and_stop() -> None:
    s = make()
    for stage in STAGES[1:]:
        assert s.advance_stage(stage).startswith("Now in")
    assert s.stage == "S5"
    assert s.advance_stage("S6").startswith("Refused")
    assert s.stage == "S5"


@pytest.mark.parametrize("request_", ["S2", "S0", "S5", "hello"])
def test_skipping_or_going_back_is_refused(request_: str) -> None:
    s = make()
    assert s.advance_stage(request_).startswith("Refused")
    assert s.stage == "S0"
    assert s.events[-1].type == "stage_refused"


def test_end_is_idempotent_and_first_reason_wins() -> None:
    s = make()
    assert s.end("safe_word", source="transport") is True
    assert s.end("timeout", source="timer") is False
    assert s.end_reason == "safe_word"
    assert s.ended.is_set()
    assert [e.type for e in s.events].count("session_ended") == 1


def test_tools_do_nothing_after_the_call_ended() -> None:
    s = make()
    s.end("hangup", source="learner")
    s.advance_stage("S1")
    s.record_red_flag("stayed_on_call", "haan ji")
    assert s.stage == "S0" and s.red_flags == []


def test_red_flag_quote_with_a_number_ends_the_drill_and_is_not_stored() -> None:
    s = make()
    s.record_red_flag("shared_identifier", "mera number 98765 43210")
    assert s.end_reason == "tripwire"
    assert s.red_flags == []
    assert "98765" not in s.to_record().model_dump_json()


def test_unknown_red_flag_is_refused() -> None:
    s = make()
    assert s.record_red_flag("made_up", "x").startswith("Unknown")
    assert s.red_flags == []


def test_learner_turn_with_digits_is_dropped_whole_and_trips() -> None:
    s = make()
    s.add_learner_text("haan ji")
    s.add_learner_text("mera aadhaar 1234 5678 9012 hai")
    assert [line.text for line in s.transcript] == ["haan ji"]
    assert s.end_reason == "tripwire"
    assert "1234" not in s.to_record().model_dump_json()


def test_caller_turn_with_digits_is_redacted_and_flagged() -> None:
    s = make()
    s.add_caller_text("apna number 98765 43210 confirm kijiye")
    assert s.transcript[-1].text == REDACTED
    assert s.events[-1].type == "caller_turn_redacted"


def test_model_end_maps_unknown_reasons() -> None:
    s = make()
    s.model_end("because")
    assert s.end_reason == "model_ended"


def test_remaining_counts_down_from_the_cap() -> None:
    clock = Clock()
    s = make(max_seconds=360, clock=clock)
    clock.now = 100
    assert s.remaining() == 260
    clock.now = 400
    assert s.remaining() == 0


def test_state_note_carries_stage_and_flags() -> None:
    s = make()
    s.advance_stage("S1")
    s.record_red_flag("stayed_on_call", "haan ji")
    note = s.state_note()
    assert "stage S1" in note and "stayed_on_call" in note


@pytest.mark.parametrize(
    "text,kind",
    [
        ("ROKO", "safe_word"),
        ("roko roko", "safe_word"),
        ("रोको", "safe_word"),
        ("kya yeh asli call hai?", "is_this_real"),
        ("is this real?", "is_this_real"),
        ("क्या यह असली है", "is_this_real"),
        ("mujhe dar lag raha hai", "distress"),
        ("मुझे डर लग रहा है", "distress"),
        ("seene mein dard ho raha hai", "distress"),
    ],
)
def test_stop_phrases(text: str, kind: str) -> None:
    stop = StopPhrases("ROKO").check(text)
    assert stop is not None and stop.kind == kind


@pytest.mark.parametrize("text", ["haan ji", "theek hai", "main courier ka intezaar kar rahi thi", "rok"])
def test_ordinary_speech_is_not_a_stop(text: str) -> None:
    assert StopPhrases("ROKO").check(text) is None


def test_custom_safe_word_and_spellings() -> None:
    phrases = StopPhrases("TULSI", ["तुलसी"])
    assert phrases.check("tulsi").kind == "safe_word"  # type: ignore[union-attr]
    assert phrases.check("तुलसी").kind == "safe_word"  # type: ignore[union-attr]
    assert phrases.check("roko") is None

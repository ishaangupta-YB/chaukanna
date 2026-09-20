"""The 120 word cap, the Polly language code, and the turning point handed over rather than invented."""

from __future__ import annotations

import logging

import pytest
from conftest import FakeBedrock, FakePolly, FakeS3, load_fixture

from scoring_service.debrief import (
    WORD_LIMIT,
    audio_key,
    build_user_message,
    language_code,
    patch,
    synthesize,
    truncate_to_words,
    word_count,
    write_audio,
    write_text,
)
from scoring_service.stub_judge import judgement_for
from scoring_service.transcript import from_fixture

MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SHORT = "Aapne achha kiya. Phone rakh dijiye. 1930 par call kijiye. Paisa transfer mat kijiye."


def transcript(name: str = "compliant"):
    return from_fixture(load_fixture(name))


def judgement(name: str = "compliant"):
    return judgement_for(transcript(name))


def long_text(words: int) -> str:
    return " ".join(["shabd"] * (words - 1) + ["aakhri."])


# --- the cap ---------------------------------------------------------------------------------


def test_a_short_debrief_is_returned_unchanged() -> None:
    bedrock = FakeBedrock(replies=[SHORT])
    assert write_text(transcript(), judgement(), {"band": "at_risk"}, bedrock=bedrock, model_id=MODEL) == SHORT
    assert len(bedrock.calls) == 1


def test_an_overrun_retries_once_with_a_shorter_instruction() -> None:
    bedrock = FakeBedrock(replies=[long_text(200), SHORT])
    text = write_text(transcript(), judgement(), {"band": "at_risk"}, bedrock=bedrock, model_id=MODEL)
    assert text == SHORT
    assert len(bedrock.calls) == 2
    assert "at most 120 words" in bedrock.calls[1]["messages"][-1]["content"][0]["text"]


def test_a_second_overrun_is_truncated_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    overlong = ". ".join(" ".join(["shabd"] * 40) for _ in range(5)) + "."
    bedrock = FakeBedrock(replies=[overlong, overlong])
    with caplog.at_level(logging.WARNING, logger="chaukanna_scoring.events"):
        text = write_text(transcript(), judgement(), {"band": "at_risk"}, bedrock=bedrock, model_id=MODEL)
    assert word_count(text) <= WORD_LIMIT
    assert len(bedrock.calls) == 2, "exactly one retry, then truncate"
    assert "debrief_truncated" in caplog.text


def test_truncation_keeps_whole_sentences() -> None:
    text = "Ek. Do. " + " ".join(["shabd"] * 150) + "."
    kept = truncate_to_words(text)
    assert kept == "Ek. Do."


def test_truncation_handles_a_devanagari_danda() -> None:
    text = "Aapne achha kiya। " + " ".join(["shabd"] * 150) + "।"
    assert truncate_to_words(text) == "Aapne achha kiya।"


def test_truncation_falls_back_to_a_word_cut_when_the_first_sentence_is_already_over() -> None:
    kept = truncate_to_words(" ".join(["shabd"] * 300))
    assert word_count(kept) == WORD_LIMIT


# --- Polly -----------------------------------------------------------------------------------


def test_hindi_uses_kajal_with_the_hi_in_language_code() -> None:
    """There is no hi-IN Polly voice. Kajal is en-IN with hi-IN in AdditionalLanguageCodes, so
    Hindi is that voice plus an explicit LanguageCode."""
    polly = FakePolly()
    synthesize(polly, SHORT, language="hi-IN", voice_id="Kajal")
    assert polly.calls[0]["VoiceId"] == "Kajal"
    assert polly.calls[0]["Engine"] == "neural"
    assert polly.calls[0]["LanguageCode"] == "hi-IN"
    assert polly.calls[0]["OutputFormat"] == "mp3"


def test_english_uses_the_same_voice_with_en_in() -> None:
    polly = FakePolly()
    synthesize(polly, SHORT, language="en-IN", voice_id="Kajal")
    assert polly.calls[0]["LanguageCode"] == "en-IN"


def test_an_unknown_language_reads_as_indian_english() -> None:
    assert language_code("ta-IN") == "en-IN"


def test_audio_lands_on_the_pinned_key() -> None:
    s3 = FakeS3()
    key = write_audio(s3, "bucket", "d1", b"ID3")
    assert key == audio_key("d1") == "debrief/d1.mp3"
    assert s3.puts[0]["ContentType"] == "audio/mpeg"


# --- the prompt ------------------------------------------------------------------------------


def test_the_turning_point_is_handed_over_not_invented() -> None:
    message = build_user_message(transcript(), judgement(), {"band": "at_risk"})
    assert "do not invent another" in message
    assert judgement()["turningPoint"] in message


def test_fired_flags_arrive_with_their_quotes_and_credits_by_name() -> None:
    message = build_user_message(transcript(), judgement(), {"band": "at_risk"})
    assert "agreed_to_move_money" in message
    assert "haan, main transfer kar dungi" in message
    assert "Credits that fired: none" in message


def test_the_system_prompt_is_language_rendered() -> None:
    bedrock = FakeBedrock(replies=[SHORT])
    write_text(transcript(), judgement(), {"band": "at_risk"}, bedrock=bedrock, model_id=MODEL)
    assert "hi-IN (Hindi)" in bedrock.calls[0]["system"][0]["text"]


def test_patch_shape() -> None:
    result = patch(SHORT, audio_key_value="debrief/d1.mp3", language="hi-IN", voice_id="Kajal", model_id=MODEL)
    assert result == {
        "text": SHORT,
        "audioKey": "debrief/d1.mp3",
        "words": word_count(SHORT),
        "voiceId": "Kajal",
        "languageCode": "hi-IN",
        "promptVersion": "debrief.writer.v1",
        "modelId": MODEL,
    }

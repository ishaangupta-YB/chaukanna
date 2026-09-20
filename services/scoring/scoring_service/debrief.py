"""`debrief.writer.v1` through converse, then Polly to `debrief/<drillId>.mp3`.

Two things here are deliberate.

**The 120 word cap is enforced in code.** The prompt asks for it; this counts it. An overrun
retries once with a shorter instruction and is then truncated at a sentence boundary and logged,
because a debrief that runs long is read aloud to someone who is already unsettled, and a hard cut
mid sentence is worse than a short one.

**Polly voice, and the pitfall the phase file names.** There is no `hi-IN` Polly voice:
`describe-voices --language-code hi-IN` returns `[]`. `Kajal` is the only Hindi capable neural
voice and it is listed under `en-IN` with `hi-IN` in `AdditionalLanguageCodes`. So Hindi is
`VoiceId=Kajal, Engine=neural, LanguageCode=hi-IN` and English is the same voice with
`LanguageCode=en-IN`. Do not "fix" this by looking for a Hindi voice id; there is not one.

The turning point is never invented here: the judge extracted it and it is handed over as text.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .log import event
from .prompts import DEBRIEF_PROMPT, debrief_system
from .transcript import Transcript

AUDIO_PREFIX = "debrief/"
WORD_LIMIT = 120
MAX_TOKENS = 600
TEMPERATURE = 0.2
SUPPORTED_LANGUAGES = ("hi-IN", "en-IN")

SHORTEN_REMINDER = (
    f"That was too long. Rewrite it in at most {WORD_LIMIT} words, keeping the same opening "
    "praise, the same quoted turning point and the same three closing rules."
)

#: Devanagari danda included: a Hindi debrief will not always end a sentence with a full stop.
_SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")


def audio_key(drill_id: str) -> str:
    return f"{AUDIO_PREFIX}{drill_id}.mp3"


def language_code(language: str) -> str:
    """The Polly `LanguageCode`. Anything unrecognised reads as Indian English rather than
    failing: a debrief in the wrong accent still teaches, silence does not."""
    return language if language in SUPPORTED_LANGUAGES else "en-IN"


def word_count(text: str) -> int:
    return len(text.split())


def truncate_to_words(text: str, limit: int = WORD_LIMIT) -> str:
    """Keep whole sentences, up to the limit. Falls back to a hard word cut only if the very
    first sentence is already over."""
    sentences = [part for part in _SENTENCE_END.split(text.strip()) if part]
    kept: list[str] = []
    used = 0
    for sentence in sentences:
        length = word_count(sentence)
        if used + length > limit:
            break
        kept.append(sentence)
        used += length
    if not kept:
        return " ".join(text.split()[:limit])
    return " ".join(kept)


def build_user_message(transcript: Transcript, judgement: dict[str, Any], score: dict[str, Any]) -> str:
    fired_flags = [
        f'- {flag_id}: "{entry["evidence"]}"'
        for flag_id, entry in sorted(judgement.get("flags", {}).items())
        if entry.get("fired")
    ]
    fired_credits = [
        credit_id for credit_id, entry in sorted(judgement.get("credits", {}).items()) if entry.get("fired")
    ]
    turning_point = judgement.get("turningPoint") or ""
    return (
        f"Band: {score.get('band')}\n"
        f'Turning point sentence (quote this, do not invent another): "{turning_point}"\n'
        f"Flags that fired:\n{chr(10).join(fired_flags) if fired_flags else '- none'}\n"
        f"Credits that fired: {', '.join(fired_credits) if fired_credits else 'none'}\n"
        f"The call ended at stage {transcript.finalStage} with reason {transcript.endReason}."
    )


def _converse(bedrock: Any, *, model_id: str, system: str, turns: list[dict[str, Any]]) -> str:
    response = bedrock.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=turns,
        inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
    )
    content = response["output"]["message"]["content"]
    return "".join(block.get("text", "") for block in content if isinstance(block, dict)).strip()


def write_text(
    transcript: Transcript,
    judgement: dict[str, Any],
    score: dict[str, Any],
    *,
    bedrock: Any,
    model_id: str,
) -> str:
    drill_id = transcript.drillId
    system = debrief_system(transcript.language)
    turns: list[dict[str, Any]] = [
        {"role": "user", "content": [{"text": build_user_message(transcript, judgement, score)}]}
    ]
    text = _converse(bedrock, model_id=model_id, system=system, turns=turns)
    if word_count(text) <= WORD_LIMIT:
        return text

    event("debrief_over_limit", drill_id, level=logging.WARNING, words=word_count(text), attempt=1)
    turns = turns + [
        {"role": "assistant", "content": [{"text": text}]},
        {"role": "user", "content": [{"text": SHORTEN_REMINDER}]},
    ]
    retried = _converse(bedrock, model_id=model_id, system=system, turns=turns)
    if word_count(retried) <= WORD_LIMIT:
        return retried

    truncated = truncate_to_words(retried)
    event(
        "debrief_truncated",
        drill_id,
        level=logging.WARNING,
        words=word_count(retried),
        keptWords=word_count(truncated),
    )
    return truncated


def synthesize(polly: Any, text: str, *, language: str, voice_id: str) -> bytes:
    response = polly.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=voice_id,
        Engine="neural",
        LanguageCode=language_code(language),
    )
    return response["AudioStream"].read()


def write_audio(s3: Any, bucket: str, drill_id: str, audio: bytes) -> str:
    key = audio_key(drill_id)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=audio,
        ContentType="audio/mpeg",
        Metadata={"drillid": drill_id, "contains": "debrief"},
    )
    return key


def patch(text: str, *, audio_key_value: str | None, language: str, voice_id: str, model_id: str) -> dict[str, Any]:
    return {
        "text": text,
        "audioKey": audio_key_value,
        "words": word_count(text),
        "voiceId": voice_id,
        "languageCode": language_code(language),
        "promptVersion": DEBRIEF_PROMPT,
        "modelId": model_id,
    }

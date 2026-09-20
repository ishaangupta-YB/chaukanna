"""Pre-render drill.break_character.v1 to audio, once per language, with the call's own voice.

    AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1 uv run python scripts/render_break_character.py

The script must be heard word for word even when the model is mid sentence, so it is never asked
of the live model. It is rendered here, checked against the model's own transcript of what it said,
and kept only on an exact match. The runner plays the file from the transport.

Nova stops a long verbatim read after about two sentences, so each sentence is rendered as its own
turn and checked on its own, then the sentences are joined with a short pause.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import sys
import unicodedata
from pathlib import Path

import boto3
from strands.experimental.bidi import (
    BidiAgent,
    BidiAudioStreamEvent,
    BidiResponseCompleteEvent,
    BidiTranscriptCompleteEvent,
)
from strands.experimental.bidi.models import BedrockNovaSonicModel

from chaukanna_agent.audio import NOVA_AUDIO_CONFIG, SAMPLE_RATE, asset_name, pcm_to_input_event, silence, text_sha256
from chaukanna_agent.config import AgentSettings
from chaukanna_agent.prompts import BREAK_CHARACTER, break_character_text, load_prompt
from chaukanna_agent.scenario import load_scenario

ASSETS = Path(__file__).resolve().parents[1] / "chaukanna_agent" / "assets"
ATTEMPTS = 3
# Nova delivers a long read as several completed blocks; the render is done once it goes quiet.
QUIET_SECONDS = 4.0
SENTENCE_PAUSE_SECONDS = 0.35
log = logging.getLogger("render")


def sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?।:])\s+", text) if part.strip()]


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


async def render_once(settings: AgentSettings, voice: str, text: str) -> tuple[bytes, str]:
    model = BedrockNovaSonicModel(
        boto_session=boto3.Session(region_name=settings.voice_region),
        model_id=settings.sonic_model_id,
        voice=voice,
        audio=NOVA_AUDIO_CONFIG,  # type: ignore[arg-type]
    )
    agent = BidiAgent(model=model, system_prompt=load_prompt("render.verbatim_reader.v1.txt"))
    audio = bytearray()
    transcript = ""

    async def keep_audio_stream_open() -> None:
        while True:
            await agent.send(pcm_to_input_event(silence(0.032)))
            await asyncio.sleep(0.032)

    await agent.start()
    pump = asyncio.create_task(keep_audio_stream_open())
    try:
        await asyncio.sleep(0.3)
        await agent.send(text)
        events = agent.receive()
        completed = False
        async with asyncio.timeout(120):
            while True:
                try:
                    event = await asyncio.wait_for(anext(events), QUIET_SECONDS if completed else 60)
                except TimeoutError:
                    break
                if isinstance(event, BidiAudioStreamEvent):
                    audio.extend(base64.b64decode(event.audio))
                elif isinstance(event, BidiTranscriptCompleteEvent) and event.role == "assistant":
                    transcript = f"{transcript} {event.transcript}".strip()
                elif isinstance(event, BidiResponseCompleteEvent) and audio:
                    completed = True
    finally:
        pump.cancel()
        await agent.stop()
    return bytes(audio), transcript


async def main() -> int:
    settings = AgentSettings.from_env()
    scenario = load_scenario("digital_arrest_v1")
    ASSETS.mkdir(exist_ok=True)
    for language in ("hi-IN", "en-IN"):
        text = break_character_text(language)
        voice = scenario.voices[language]
        pcm = bytearray()
        heard: list[str] = []
        for sentence in sentences(text):
            for attempt in range(1, ATTEMPTS + 1):
                audio, transcript = await render_once(settings, voice, sentence)
                if normalize(transcript) == normalize(sentence):
                    break
                log.warning("%s attempt %d differs: %r vs %r", language, attempt, transcript, sentence)
            else:
                log.error("%s: no word for word render of %r after %d attempts", language, sentence, ATTEMPTS)
                return 1
            if pcm:
                pcm.extend(silence(SENTENCE_PAUSE_SECONDS))
            pcm.extend(audio)
            heard.append(transcript)
        transcript = " ".join(heard)
        if normalize(transcript) != normalize(text):
            log.error("%s: joined transcript does not match the script", language)
            return 1
        pcm = bytes(pcm)
        (ASSETS / f"{asset_name(language)}.pcm").write_bytes(pcm)
        manifest = {
            "prompt": BREAK_CHARACTER,
            "language": language,
            "voice": voice,
            "model_id": settings.sonic_model_id,
            "sample_rate": SAMPLE_RATE,
            "text_sha256": text_sha256(text),
            "transcript": transcript,
            "seconds": round(len(pcm) / (SAMPLE_RATE * 2), 2),
        }
        (ASSETS / f"{asset_name(language)}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        log.info("%s: %.1f s rendered with %s", language, manifest["seconds"], voice)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("strands").setLevel(logging.WARNING)
    sys.exit(asyncio.run(main()))

"""Phase 2 task 2: prove a Nova 2 Sonic session talks in VOICE_REGION before any product code.

    VOICE_REGION=ap-northeast-1 AWS_PROFILE=chaukanna uv run python scripts/smoke_sonic.py

Sends one text turn, counts the audio that comes back, and logs the assistant transcript.
If this fails, the problem is model access in the region, not the drill code.

Nova Sonic only answers while an audio input stream is open, even for a text turn, so this
streams silence alongside the text (a real call always has the microphone open).
"""

import asyncio
import base64
import logging
import os
import sys

import boto3
from strands.experimental.bidi import (
    BidiAgent,
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiResponseCompleteEvent,
    BidiTranscriptCompleteEvent,
)
from strands.experimental.bidi.models import BedrockNovaSonicModel

log = logging.getLogger("smoke")


async def main() -> int:
    region = os.environ["VOICE_REGION"]
    model = BedrockNovaSonicModel(
        boto_session=boto3.Session(region_name=region),
        model_id=os.environ.get("SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0"),
        voice="arjun",
    )
    agent = BidiAgent(model=model, system_prompt="You are a friendly assistant. Reply in one short Hindi sentence.")
    audio_bytes = 0
    transcript = ""
    silence = base64.b64encode(bytes(1024)).decode()  # 32 ms of 16 kHz 16-bit mono

    async def pump_silence() -> None:
        while True:
            await agent.send(BidiAudioInputEvent(audio=silence, format="pcm", sample_rate=16000, channels=1))
            await asyncio.sleep(0.032)

    await agent.start()
    pump = asyncio.create_task(pump_silence())
    try:
        await asyncio.sleep(0.3)
        await agent.send("Namaste, aap kaise hain?")
        async with asyncio.timeout(30):
            async for event in agent.receive():
                if isinstance(event, BidiAudioStreamEvent):
                    audio_bytes += len(base64.b64decode(event.audio))
                elif isinstance(event, BidiTranscriptCompleteEvent) and event.role == "assistant":
                    transcript = event.transcript
                elif isinstance(event, BidiResponseCompleteEvent) and audio_bytes > 0:
                    break
    finally:
        pump.cancel()
        await agent.stop()
    log.info("region=%s audio_bytes=%d seconds=%.1f transcript=%r", region, audio_bytes, audio_bytes / 32000, transcript)
    return 0 if audio_bytes > 0 else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(asyncio.run(main()))

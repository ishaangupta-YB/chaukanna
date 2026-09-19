"""All audio handling in one module. Sample rate bugs are the usual time sink; they live here.

Formats, both directions: 16-bit signed little-endian PCM, mono, 16 kHz.
- 16 kHz input is what Nova Sonic expects for speech (audio/lpcm, sampleRateHertz 16000).
- 16 kHz output (not 24 kHz) so the pre-rendered break character audio, the model's live audio,
  and the local speaker all share one rate and never need resampling.
- 32 ms chunks (512 frames) keep latency low without flooding the event stream.

The local microphone and speaker use `sounddevice` (the optional `local` dependency group) and are
imported lazily so the server image never needs PortAudio.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
from dataclasses import dataclass
from importlib import resources
from typing import TYPE_CHECKING, Any

from strands.experimental.bidi import BidiAudioInputEvent

if TYPE_CHECKING:
    from strands.experimental.bidi import BidiAgent

SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes per sample, int16
CHUNK_FRAMES = 512  # 32 ms at 16 kHz
BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH
# The model's audio config, passed to BedrockNovaSonicModel(audio=...).
NOVA_AUDIO_CONFIG = {"input": {"sample_rate": SAMPLE_RATE}, "output": {"sample_rate": SAMPLE_RATE}}


def pcm_to_input_event(pcm: bytes) -> BidiAudioInputEvent:
    return BidiAudioInputEvent(
        audio=base64.b64encode(pcm).decode("ascii"), format="pcm", sample_rate=SAMPLE_RATE, channels=CHANNELS
    )


def silence(seconds: float) -> bytes:
    frames = int(SAMPLE_RATE * seconds)
    return bytes(frames * SAMPLE_WIDTH * CHANNELS)


# ---- pre-rendered break character audio -------------------------------------------------------


@dataclass(frozen=True)
class BreakAudio:
    pcm: bytes
    text_sha256: str
    voice: str


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def asset_name(language: str) -> str:
    return f"break_character.v1.{language}"


def load_break_audio(language: str, expected_text: str) -> BreakAudio:
    """Raises if the asset is missing or was rendered from different text than the prompt file."""
    assets = resources.files("chaukanna_agent").joinpath("assets")
    manifest: dict[str, Any] = json.loads(assets.joinpath(f"{asset_name(language)}.json").read_text(encoding="utf-8"))
    pcm = assets.joinpath(f"{asset_name(language)}.pcm").read_bytes()
    if manifest["text_sha256"] != text_sha256(expected_text):
        raise RuntimeError(f"break character audio for {language} is stale, rerun scripts/render_break_character.py")
    if manifest["sample_rate"] != SAMPLE_RATE or len(pcm) % SAMPLE_WIDTH:
        raise RuntimeError(f"break character audio for {language} has the wrong format")
    return BreakAudio(pcm=pcm, text_sha256=manifest["text_sha256"], voice=manifest["voice"])


# ---- output interface used by the runner -------------------------------------------------------


class AudioSink:
    """Where the runner sends caller audio. The local speaker and, in Phase 3, the WebSocket
    implement this."""

    async def start(self) -> None:
        return None

    def play(self, pcm: bytes) -> None:
        raise NotImplementedError

    def clear(self) -> None:
        """Drop anything queued. Used on barge-in and to cut the model mid sentence."""
        raise NotImplementedError

    async def drain(self) -> None:
        """Wait until everything queued has been played."""
        raise NotImplementedError

    async def stop(self) -> None:
        return None


class AudioSource:
    """Where learner audio comes from. `read` returns one chunk of PCM."""

    async def start(self) -> None:
        return None

    async def read(self) -> bytes:
        raise NotImplementedError

    async def stop(self) -> None:
        return None


# ---- local devices -----------------------------------------------------------------------------


class _PcmBuffer:
    """Thread safe byte buffer between the event loop and the audio device callback."""

    def __init__(self) -> None:
        self._data = bytearray()
        self._lock = threading.Lock()

    def put(self, pcm: bytes) -> None:
        with self._lock:
            self._data.extend(pcm)

    def take(self, n: int) -> bytes:
        with self._lock:
            chunk = bytes(self._data[:n])
            del self._data[:n]
        return chunk + bytes(n - len(chunk))  # pad with silence

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


class LocalSpeaker(AudioSink):
    def __init__(self) -> None:
        self._buffer = _PcmBuffer()
        self._stream: Any = None

    async def start(self) -> None:
        import sounddevice as sd

        def callback(outdata: Any, frames: int, _time: Any, _status: Any) -> None:
            outdata[:] = self._buffer.take(frames * SAMPLE_WIDTH * CHANNELS)

        self._stream = sd.RawOutputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16", blocksize=CHUNK_FRAMES, callback=callback
        )
        self._stream.start()

    def play(self, pcm: bytes) -> None:
        self._buffer.put(pcm)

    def clear(self) -> None:
        self._buffer.clear()

    def is_playing(self) -> bool:
        return len(self._buffer) > 0

    async def drain(self) -> None:
        while self.is_playing():
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.15)  # let the device flush its last block

    async def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class LocalMicrophone(AudioSource):
    """Microphone chunks. With `mute_while` set (half duplex), sends silence while the caller is
    speaking so laptop speakers do not make the model interrupt itself. Use headphones for barge-in."""

    def __init__(self, mute_while: LocalSpeaker | None = None) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
        self._stream: Any = None
        self._mute_while = mute_while

    async def start(self) -> None:
        import sounddevice as sd

        loop = asyncio.get_running_loop()

        def enqueue(pcm: bytes) -> None:
            if self._queue.full():
                self._queue.get_nowait()
            self._queue.put_nowait(pcm)

        def callback(indata: Any, _frames: int, _time: Any, _status: Any) -> None:
            loop.call_soon_threadsafe(enqueue, bytes(indata))

        self._stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16", blocksize=CHUNK_FRAMES, callback=callback
        )
        self._stream.start()

    async def read(self) -> bytes:
        pcm = await self._queue.get()
        if self._mute_while is not None and self._mute_while.is_playing():
            return bytes(len(pcm))
        return pcm

    async def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


async def pump_source(agent: BidiAgent, source: AudioSource, stopped: asyncio.Event) -> None:
    """Streams learner audio to the model until the session stops. Nova only answers while an
    audio input stream is open, so this runs for the whole call."""
    while not stopped.is_set():
        pcm = await source.read()
        if stopped.is_set():
            return
        await agent.send(pcm_to_input_event(pcm))

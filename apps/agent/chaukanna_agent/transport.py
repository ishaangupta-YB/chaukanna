"""WebSocket transport for the drill: the browser's microphone as an `AudioSource`, the browser's
speaker as an `AudioSink`.

`drill.py` does not know this file exists. The local terminal (Phase 2) and the browser (Phase 3)
differ only in which source and sink the runner is handed, which is what makes one safety core
serve both.

Two things are worth knowing before changing anything here:

1. `AudioSink.play` and `AudioSink.clear` are called **synchronously** from the runner's event
   handler, so they cannot await a send. Both push onto one queue that a single writer task
   drains, which is also what keeps a `clear` control frame correctly ordered against the audio
   frames around it.
2. When the socket dies mid call the drill ends as an `error`, never as a `hangup`. A dropped
   connection is not the learner choosing to put the phone down, and the scoring rubric credits
   that choice.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from pydantic import ValidationError

from . import wire
from .audio import BYTES_PER_SECOND, CHUNK_FRAMES, SAMPLE_RATE, SAMPLE_WIDTH, AudioSink, AudioSource, silence
from .log import event

# One chunk of learner audio. 64 ms is two of the model's 32 ms frames: still far inside the
# 64 KB frame cap and the 250 frame per second connection cap, with half as many frames in flight.
CLIENT_CHUNK_FRAMES = CHUNK_FRAMES * 2
CLIENT_CHUNK_SECONDS = CLIENT_CHUNK_FRAMES / SAMPLE_RATE
# Largest binary frame we will accept from a client, generous but bounded. A well behaved browser
# sends 2048 bytes; anything past this is a bug or an attack, and we hang up rather than buffer it.
MAX_CLIENT_FRAME_BYTES = 32 * 1024
# The learner queue holds about four seconds. Past that the connection is not keeping up and the
# oldest audio is dropped, because stale microphone audio is worse than a gap.
SOURCE_QUEUE_CHUNKS = 64
HELLO_TIMEOUT_SECONDS = 10.0
# Cap on `drain`, so a client that stopped acknowledging cannot hold the call open.
MAX_DRAIN_SECONDS = 20.0


class WebSocketLike(Protocol):
    """The slice of Starlette's WebSocket this module uses. Tests supply their own."""

    async def send_json(self, data: Any) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...
    async def receive(self) -> dict[str, Any]: ...
    async def close(self, code: int = 1000) -> None: ...


class TransportClosed(Exception):
    """The browser went away."""


async def read_hello(socket: WebSocketLike, *, timeout: float = HELLO_TIMEOUT_SECONDS) -> wire.Hello:
    """Waits for the first text frame and parses it as a hello. Anything else is a protocol error.

    Audio frames that arrive before the hello are dropped: the microphone may open a beat before
    the hello is sent, and that audio is from before the call started.
    """
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TransportClosed("no hello")
        try:
            message = await asyncio.wait_for(socket.receive(), timeout=remaining)
        except TimeoutError as error:
            raise TransportClosed("no hello") from error
        if message.get("type") == "websocket.disconnect":
            raise TransportClosed("disconnected before hello")
        if message.get("bytes") is not None:
            continue
        text = message.get("text")
        if text is None:
            continue
        try:
            return wire.Hello.model_validate_json(text)
        except ValidationError as error:
            raise ValueError("first frame was not a hello") from error


class BrowserSink(AudioSink):
    """Caller audio out to the browser, plus the control frames that go with it."""

    def __init__(self, socket: WebSocketLike) -> None:
        self._socket = socket
        self._queue: asyncio.Queue[bytes | dict[str, object] | None] = asyncio.Queue()
        self._writer: asyncio.Task[None] | None = None
        # Monotonic time by which everything handed over so far has finished playing, assuming the
        # browser plays it back to back. An estimate: the browser never reports its buffer.
        self._playout_until = 0.0
        self.closed = False

    async def start(self) -> None:
        self._writer = asyncio.create_task(self._write_loop())

    def play(self, pcm: bytes) -> None:
        if self.closed or not pcm:
            return
        self._playout_until = max(time.monotonic(), self._playout_until) + len(pcm) / BYTES_PER_SECOND
        self._queue.put_nowait(pcm)

    def clear(self) -> None:
        if self.closed:
            return
        while not self._queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
        self._playout_until = time.monotonic()
        # Tell the browser to drop what it already holds, even when our own queue was empty: most
        # of a barge-in is audio that already left this process.
        self._queue.put_nowait(wire.clear())

    async def drain(self) -> None:
        deadline = time.monotonic() + MAX_DRAIN_SECONDS
        while not self.closed and time.monotonic() < deadline:
            if self._queue.empty() and time.monotonic() >= self._playout_until:
                return
            await asyncio.sleep(0.05)

    def send_control(self, message: dict[str, object]) -> None:
        """Queues a control frame. Synchronous, because the runner emits captions from inside its
        event handler. One queue serves audio and control so `clear` stays ordered against the
        audio around it; the queue drains at network speed, not at playback speed, so a caption
        waits on bytes in flight rather than on seconds of speech."""
        if not self.closed:
            self._queue.put_nowait(message)

    async def stop(self) -> None:
        self.closed = True
        self._queue.put_nowait(None)
        if self._writer is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._writer, timeout=5.0)
            self._writer = None

    async def _write_loop(self) -> None:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            try:
                if isinstance(item, bytes):
                    await self._socket.send_bytes(item)
                else:
                    await self._socket.send_json(item)
            except Exception:  # noqa: BLE001 - the browser went away; the receive loop ends the call
                self.closed = True
                return


class BrowserSource(AudioSource):
    """Learner audio in from the browser.

    After the socket closes this keeps returning paced silence rather than raising, so the runner
    unwinds through its normal ending path instead of through an exception.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=SOURCE_QUEUE_CHUNKS)
        self.closed = False

    def feed(self, pcm: bytes) -> None:
        if self.closed or not pcm or len(pcm) % SAMPLE_WIDTH:
            return
        if self._queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()  # drop the oldest chunk, keep the live edge
        self._queue.put_nowait(pcm)

    def close(self) -> None:
        self.closed = True

    async def read(self) -> bytes:
        if self.closed and self._queue.empty():
            await asyncio.sleep(CLIENT_CHUNK_SECONDS)
            return silence(CLIENT_CHUNK_SECONDS)
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=CLIENT_CHUNK_SECONDS * 4)
        except TimeoutError:
            # The browser stalled. Nova only answers while an input stream is open, so keep it
            # open with silence rather than letting the model go quiet too.
            return silence(CLIENT_CHUNK_SECONDS)


class BrowserTransport:
    """Owns the socket: one receive loop, one sink, one source.

    `on_hangup` and `on_closed` are called from the receive loop. Both are expected to end the
    session; the runner notices through `session.ended` and tears down as usual.
    """

    def __init__(
        self,
        socket: WebSocketLike,
        *,
        drill_id: str,
        on_hangup: Callable[[], None],
        on_closed: Callable[[], None],
    ) -> None:
        self.socket = socket
        self.drill_id = drill_id
        self.sink = BrowserSink(socket)
        self.source = BrowserSource()
        self._on_hangup = on_hangup
        self._on_closed = on_closed
        self._reader: asyncio.Task[None] | None = None

    def start_reading(self) -> None:
        self._reader = asyncio.create_task(self._read_loop())

    async def stop(self) -> None:
        self.source.close()
        await self.sink.stop()
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader
            self._reader = None

    async def _read_loop(self) -> None:
        try:
            while True:
                message = await self.socket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                payload = message.get("bytes")
                if payload is not None:
                    if len(payload) > MAX_CLIENT_FRAME_BYTES:
                        break
                    self.source.feed(payload)
                    continue
                text = message.get("text")
                if text is not None and self._is_hangup(text):
                    self._on_hangup()
                    # Keep reading: the learner's audio stops mattering, but the socket stays up
                    # until the runner has finished tearing the call down.
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - every transport failure ends the call the same way
            event("drill_socket_read_failed", self.drill_id, level=logging.WARNING, errorName=type(error).__name__)
        self.source.close()
        self._on_closed()

    @staticmethod
    def _is_hangup(text: str) -> bool:
        try:
            return json.loads(text).get("type") == "hangup"
        except (ValueError, AttributeError):
            return False

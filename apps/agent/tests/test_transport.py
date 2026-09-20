"""The WebSocket transport, without a model or AWS in sight.

These tests are about the things that go wrong on a phone on mobile data: the socket dies, the
browser stalls, a frame arrives that should not have, the caller gets interrupted.
"""

from __future__ import annotations

import asyncio

import pytest

from chaukanna_agent import wire
from chaukanna_agent.audio import CallerRecorder, silence
from chaukanna_agent.transport import (
    CLIENT_CHUNK_SECONDS,
    MAX_CLIENT_FRAME_BYTES,
    SOURCE_QUEUE_CHUNKS,
    BrowserSink,
    BrowserSource,
    BrowserTransport,
    TransportClosed,
    read_hello,
)
from tests.fake_socket import FakeSocket

CHUNK = silence(CLIENT_CHUNK_SECONDS)


async def settle(times: int = 3) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


# ---- hello -------------------------------------------------------------------------------------


async def test_hello_is_parsed() -> None:
    socket = FakeSocket()
    socket.client_text({"type": "hello", "token": "x" * 40})
    hello = await read_hello(socket)
    assert hello.token == "x" * 40


async def test_audio_before_hello_is_dropped() -> None:
    """The microphone can open a beat before the hello is sent. That audio is from before the call."""
    socket = FakeSocket()
    socket.client_bytes(CHUNK)
    socket.client_bytes(CHUNK)
    socket.client_text({"type": "hello", "token": "y" * 40})
    assert (await read_hello(socket)).token == "y" * 40


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "hangup"},  # a valid frame, but not the first one
        {"type": "hello"},  # no token
        {"type": "hello", "token": "short"},
        {"token": "z" * 40},  # no type
    ],
)
async def test_a_first_frame_that_is_not_a_hello_is_a_protocol_error(payload: dict[str, object]) -> None:
    socket = FakeSocket()
    socket.client_text(payload)
    with pytest.raises(ValueError):
        await read_hello(socket)


async def test_disconnect_before_hello() -> None:
    socket = FakeSocket()
    socket.client_disconnect()
    with pytest.raises(TransportClosed):
        await read_hello(socket)


async def test_hello_times_out() -> None:
    socket = FakeSocket()
    with pytest.raises(TransportClosed):
        await read_hello(socket, timeout=0.05)


# ---- sink --------------------------------------------------------------------------------------


async def test_audio_goes_out_as_binary_and_control_as_json() -> None:
    socket = FakeSocket()
    sink = BrowserSink(socket)
    await sink.start()
    sink.send_control(wire.ready("d1", max_seconds=360, safe_word="ROKO", language="hi-IN"))
    sink.play(CHUNK)
    await settle()
    await sink.stop()
    assert socket.sent_bytes == [CHUNK]
    assert socket.sent_json[0]["type"] == "ready"
    assert socket.sent_json[0]["safeWord"] == "ROKO"


async def test_clear_drops_queued_audio_and_tells_the_browser() -> None:
    """Barge-in. Most of what the learner talked over already left this process, so the browser is
    told to drop its own buffer too."""
    socket = FakeSocket()
    sink = BrowserSink(socket)
    sink.play(CHUNK)  # queued before the writer starts, so it is still ours to drop
    sink.play(CHUNK)
    sink.clear()
    await sink.start()
    await settle()
    await sink.stop()
    assert socket.sent_bytes == []
    assert [m["type"] for m in socket.sent_json] == ["clear"]


async def test_drain_waits_for_the_estimated_playout() -> None:
    socket = FakeSocket()
    sink = BrowserSink(socket)
    await sink.start()
    sink.play(silence(0.25))
    started = asyncio.get_running_loop().time()
    await sink.drain()
    assert asyncio.get_running_loop().time() - started >= 0.2
    await sink.stop()


async def test_a_dead_socket_stops_the_writer_instead_of_spinning() -> None:
    socket = FakeSocket()
    sink = BrowserSink(socket)
    await sink.start()
    await socket.close(1006)
    sink.play(CHUNK)
    await settle(5)
    assert sink.closed
    await sink.stop()


# ---- source ------------------------------------------------------------------------------------


async def test_source_yields_what_the_browser_sent() -> None:
    source = BrowserSource()
    source.feed(CHUNK)
    assert await source.read() == CHUNK


async def test_source_drops_the_oldest_chunk_when_the_call_falls_behind() -> None:
    """Stale microphone audio is worse than a gap, so the live edge wins."""
    source = BrowserSource()
    for index in range(SOURCE_QUEUE_CHUNKS + 5):
        source.feed(bytes([index % 256, 0]) * 8)
    first = await source.read()
    assert first != bytes([0, 0]) * 8


async def test_odd_length_frames_are_ignored() -> None:
    """A half sample is a corrupt frame; feeding it on would shift every sample after it."""
    source = BrowserSource()
    source.feed(b"\x01\x02\x03")
    source.feed(CHUNK)
    assert await source.read() == CHUNK


async def test_source_returns_silence_after_the_socket_closes() -> None:
    """Nova only answers while an input stream is open, and the runner must unwind through its
    own ending path rather than through an exception out of the pump."""
    source = BrowserSource()
    source.close()
    chunk = await source.read()
    assert chunk == silence(CLIENT_CHUNK_SECONDS)
    assert set(chunk) == {0}


async def test_source_fills_a_stall_with_silence() -> None:
    source = BrowserSource()
    chunk = await asyncio.wait_for(source.read(), timeout=CLIENT_CHUNK_SECONDS * 8)
    assert set(chunk) == {0}


# ---- transport ---------------------------------------------------------------------------------


async def test_hangup_frame_reaches_the_runner() -> None:
    socket = FakeSocket()
    hung_up = asyncio.Event()
    transport = BrowserTransport(socket, drill_id="d1", on_hangup=hung_up.set, on_closed=lambda: None)
    transport.start_reading()
    socket.client_text({"type": "hangup"})
    await asyncio.wait_for(hung_up.wait(), timeout=1)
    await transport.stop()


async def test_disconnect_closes_the_source_and_reports_it() -> None:
    socket = FakeSocket()
    closed = asyncio.Event()
    transport = BrowserTransport(socket, drill_id="d1", on_hangup=lambda: None, on_closed=closed.set)
    transport.start_reading()
    socket.client_disconnect()
    await asyncio.wait_for(closed.wait(), timeout=1)
    assert transport.source.closed
    await transport.stop()


async def test_an_oversized_frame_ends_the_connection() -> None:
    socket = FakeSocket()
    closed = asyncio.Event()
    transport = BrowserTransport(socket, drill_id="d1", on_hangup=lambda: None, on_closed=closed.set)
    transport.start_reading()
    socket.client_bytes(b"\x00" * (MAX_CLIENT_FRAME_BYTES + 2))
    await asyncio.wait_for(closed.wait(), timeout=1)
    await transport.stop()


async def test_junk_text_frames_are_ignored() -> None:
    socket = FakeSocket()
    closed = asyncio.Event()
    transport = BrowserTransport(socket, drill_id="d1", on_hangup=lambda: None, on_closed=closed.set)
    transport.start_reading()
    socket.client_raw_text("not json at all")
    socket.client_text({"type": "something_else"})
    socket.client_bytes(CHUNK)
    assert await asyncio.wait_for(transport.source.read(), timeout=1) == CHUNK
    assert not closed.is_set()
    await transport.stop()


# ---- recording ---------------------------------------------------------------------------------


async def test_caller_recorder_captures_only_what_it_is_given() -> None:
    socket = FakeSocket()
    sink = BrowserSink(socket)
    recorder = CallerRecorder(sink, max_seconds=1.0)
    await recorder.start()
    recorder.play(b"\x01\x02" * 100)
    recorder.play(b"\x03\x04" * 100)
    await settle()
    await recorder.stop()
    assert recorder.caller_pcm == b"\x01\x02" * 100 + b"\x03\x04" * 100
    assert socket.sent_bytes == [b"\x01\x02" * 100, b"\x03\x04" * 100]


async def test_caller_recorder_stops_at_the_cap() -> None:
    """A runaway model must not grow the recording without bound."""
    socket = FakeSocket()
    recorder = CallerRecorder(BrowserSink(socket), max_seconds=0.1)
    await recorder.start()
    for _ in range(20):
        recorder.play(silence(0.05))
    await recorder.stop()
    assert len(recorder.caller_pcm) == int(0.1 * 16_000) * 2

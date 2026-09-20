"""The whole browser path, end to end, with a scripted model and a fake store.

This is the Phase 3 equivalent of `test_fixture_replay.py`: the same runner, the same tripwire, the
same session, but reached the way a phone reaches it. What it is here to prove is that nothing in
the safety core got weaker on the way through a socket.

Nothing here touches AWS. The model is scripted, the table and the bucket are a recorder.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest

from chaukanna_agent import server
from chaukanna_agent.audio import silence
from chaukanna_agent.config import AgentSettings, ServerSettings
from chaukanna_agent.drill import build_agent as real_build_agent
from chaukanna_agent.session import DrillRecord
from chaukanna_agent.session_token import PURPOSE
from chaukanna_agent.store import DrillClaimError
from chaukanna_agent.transport import CLIENT_CHUNK_SECONDS
from tests.fake_socket import FakeSocket
from tests.scripted_model import ScriptedModel

MASTER_KEY = "test-master-key-not-a-real-secret"
DRILL_ID = "d1e2f3a4b5c6d7e8f9a0"
MEMBER_ID = "abcdef0123456789abcd"
HOUSEHOLD_ID = "0123456789abcdef0123"
SCHEDULED_AT = "2026-09-20T11:30:00.000Z"
JTI = "9f8e7d6c5b4a39281706"
CHUNK = silence(CLIENT_CHUNK_SECONDS)


def make_token(**overrides: Any) -> str:
    payload = {
        "d": DRILL_ID,
        "m": MEMBER_ID,
        "h": HOUSEHOLD_ID,
        "t": SCHEDULED_AT,
        "l": "hi-IN",
        "s": "digital_arrest_v1",
        "x": 60,
        "j": JTI,
        "exp": int(time.time()) + 300,
    }
    payload.update(overrides)
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    key = hmac.new(MASTER_KEY.encode(), PURPOSE.encode(), hashlib.sha256).digest()
    mac = hmac.new(key, body.encode(), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(mac).decode().rstrip('=')}"


class FakeStore:
    """Records what the real store would have written, and can be told to refuse."""

    def __init__(self, *, active: bool = True, claimable: bool = True) -> None:
        self.active = active
        self.claimable = claimable
        self.claims: list[dict[str, Any]] = []
        self.finished: list[dict[str, Any]] = []
        self.released: list[str] = []

    def assert_member_active(self, household_id: str, member_id: str) -> None:
        assert (household_id, member_id) == (HOUSEHOLD_ID, MEMBER_ID)
        if not self.active:
            raise DrillClaimError("not_consented")

    def claim(self, *, member_id: str, scheduled_at: str, drill_id: str, jti: str) -> None:
        if not self.claimable:
            raise DrillClaimError("drill_unavailable")
        self.claims.append({"member_id": member_id, "scheduled_at": scheduled_at, "drill_id": drill_id, "jti": jti})
        self.claimable = False  # single use, exactly as the conditional write behaves

    def finish(self, record: DrillRecord, *, member_id: str, scheduled_at: str, caller_pcm: bytes) -> None:
        self.finished.append(
            {"record": record, "member_id": member_id, "scheduled_at": scheduled_at, "caller_pcm": caller_pcm}
        )

    def release(self, *, member_id: str, scheduled_at: str, drill_id: str, reason: str) -> None:
        self.released.append(reason)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> FakeStore:
    """Points the module level singletons at test doubles and hands back the store."""
    store = FakeStore()
    settings = ServerSettings(
        agent=AgentSettings(voice_region="ap-northeast-1", session_max_seconds=60, safe_word="ROKO"),
        data_region="ap-south-1",
        table_name="chaukanna-test",
        artifacts_bucket="chaukanna-test-bucket",
    )
    monkeypatch.setattr(server, "_settings", settings)
    monkeypatch.setattr(server, "_store", store)
    monkeypatch.setattr(server, "_scenario", None)
    monkeypatch.setattr(
        server, "signing_key", lambda _region: hmac.new(MASTER_KEY.encode(), PURPOSE.encode(), hashlib.sha256).digest()
    )
    return store


def use_script(monkeypatch: pytest.MonkeyPatch, steps: list[dict[str, Any]]) -> None:
    def build(settings: Any, scenario: Any, language: Any, session: Any) -> Any:
        return real_build_agent(settings, scenario, language, session, model=ScriptedModel(steps))

    monkeypatch.setattr(server, "build_agent", build)


async def drive(socket: FakeSocket, token: str | None = None, *, frames: int = 3) -> None:
    """Plays the browser's part: hello, a little microphone audio, then wait for the call to end."""
    if token is not None:
        socket.client_text({"type": "hello", "token": token})
    for _ in range(frames):
        socket.client_bytes(CHUNK)
    await asyncio.wait_for(server.drill_socket(socket, None), timeout=20)


# ---- admission ---------------------------------------------------------------------------------


async def test_a_bad_first_frame_is_refused_without_claiming_the_drill(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_script(monkeypatch, [])
    socket = FakeSocket()
    socket.client_text({"type": "hangup"})
    await drive(socket)
    assert socket.messages_of("error")[0]["code"] == "bad_hello"
    assert socket.close_code == 1008
    assert harness.claims == []


async def test_a_forged_token_is_refused(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    use_script(monkeypatch, [])
    socket = FakeSocket()
    body, _ = make_token().split(".")
    await drive(socket, f"{body}.{'A' * 43}")
    assert socket.messages_of("error")[0]["code"] == "invalid_token"
    assert harness.claims == []


async def test_an_expired_token_is_refused(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    use_script(monkeypatch, [])
    socket = FakeSocket()
    await drive(socket, make_token(exp=int(time.time()) - 3600))
    assert socket.messages_of("error")[0]["code"] == "invalid_token"
    assert harness.claims == []


async def test_a_withdrawn_consent_beats_a_valid_token(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """The kill switch has to win the race between minting a token and connecting with it."""
    use_script(monkeypatch, [])
    harness.active = False
    socket = FakeSocket()
    await drive(socket, make_token())
    assert socket.messages_of("error")[0]["code"] == "not_consented"
    assert harness.claims == []


async def test_a_token_is_single_use(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """A leaked token must not buy a second call. The first connection claims the drill; the
    second loses the conditional write and gets nothing."""
    use_script(
        monkeypatch,
        [{"caller": "नमस्ते।", "tools": [{"name": "end_drill", "input": {"reason": "completed"}}]}],
    )
    first = FakeSocket()
    await drive(first, make_token(), frames=1)
    assert len(harness.claims) == 1

    second = FakeSocket()
    await drive(second, make_token())
    assert second.messages_of("error")[0]["code"] == "drill_unavailable"
    assert len(harness.claims) == 1
    assert len(harness.finished) == 1  # the second connection persisted nothing


async def test_a_secrets_failure_is_reported_rather_than_crashing_the_socket(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Secrets Manager being unreachable is our problem, not a bad token, and the browser should
    hear a reason instead of the socket dying under it."""
    use_script(monkeypatch, [])

    def unavailable(_region: str) -> bytes:
        raise RuntimeError("secrets manager is unreachable")

    monkeypatch.setattr(server, "signing_key", unavailable)
    socket = FakeSocket()
    await drive(socket, make_token())
    assert socket.messages_of("error")[0]["code"] == "internal"
    assert socket.close_code == 1008
    assert harness.claims == []


async def test_nothing_is_claimed_when_the_browser_never_says_hello(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_script(monkeypatch, [])
    socket = FakeSocket()
    socket.client_disconnect()
    await drive(socket)
    assert harness.claims == []
    assert socket.sent_json == []


# ---- a call ------------------------------------------------------------------------------------


async def test_a_whole_call_runs_and_is_persisted(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    use_script(
        monkeypatch,
        [
            {"caller": "नमस्ते, मैं कूरियर सेवा से बात कर रहा हूँ।"},
            {"learner": "जी बताइए"},
            {"caller": "आपका एक पार्सल रोका गया है।", "tools": [{"name": "advance_stage", "input": {"stage": "S1"}}]},
            {"learner": "मैं फ़ोन रख रहा हूँ"},
            {"caller": "ठीक है।", "tools": [{"name": "end_drill", "input": {"reason": "completed"}}]},
        ],
    )
    socket = FakeSocket()
    await drive(socket, make_token())

    ready = socket.messages_of("ready")[0]
    assert ready["drillId"] == DRILL_ID
    assert ready["safeWord"] == "ROKO"
    assert ready["maxSeconds"] == 60
    assert ready["language"] == "hi-IN"
    assert socket.sent_json[0]["type"] == "ready", "ready must be the first frame the browser sees"

    ended = socket.messages_of("ended")[0]
    assert ended["reason"] == "completed"
    assert ended["finalStage"] == "S1"
    assert socket.close_code == 1000
    assert socket.sent_bytes, "the caller's audio reached the browser"

    assert len(harness.finished) == 1
    written = harness.finished[0]
    assert written["member_id"] == MEMBER_ID
    assert written["scheduled_at"] == SCHEDULED_AT
    assert written["caller_pcm"], "the caller's audio was kept for the drill's audio object"
    record = written["record"]
    assert record.drillId == DRILL_ID
    assert record.endReason == "completed"
    assert {line.role for line in record.transcript} == {"caller", "learner"}


async def test_captions_are_sent_for_both_voices(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    use_script(
        monkeypatch,
        [
            {"caller": "मैं कूरियर सेवा से बोल रहा हूँ"},
            {"learner": "कौन बोल रहा है"},
            {"caller": "रुकिए।", "tools": [{"name": "end_drill", "input": {"reason": "completed"}}]},
        ],
    )
    socket = FakeSocket()
    await drive(socket, make_token())
    roles = {c["role"] for c in socket.messages_of("caption")}
    assert roles == {"caller", "learner"}


async def test_the_learner_hanging_up_ends_the_call(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """The red button. A hang up is a pass on the disconnect criterion, so it must not be
    confused with the socket dying."""
    use_script(monkeypatch, [{"caller": "नमस्ते"}, {"pause": 5.0}])
    socket = FakeSocket()
    socket.client_text({"type": "hello", "token": make_token()})
    socket.client_bytes(CHUNK)
    socket.client_text({"type": "hangup"})
    await asyncio.wait_for(server.drill_socket(socket, None), timeout=20)
    assert socket.messages_of("ended")[0]["reason"] == "hangup"
    assert harness.finished[0]["record"].endReason == "hangup"


async def test_a_dropped_connection_is_an_error_not_a_hangup(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Losing mobile data must not earn the learner credit for hanging up."""
    use_script(monkeypatch, [{"caller": "नमस्ते"}, {"pause": 5.0}])
    socket = FakeSocket()
    socket.client_text({"type": "hello", "token": make_token()})
    socket.client_bytes(CHUNK)
    socket.client_disconnect()
    await asyncio.wait_for(server.drill_socket(socket, None), timeout=20)
    record = harness.finished[0]["record"]
    assert record.endReason == "error"
    assert record.endSource == "transport_closed"


# ---- safety, through the full path ---------------------------------------------------------------


async def test_the_tripwire_fires_through_the_socket_and_stores_no_digits(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one unacceptable outcome is a real number reaching storage. Prove it does not, on the
    path a learner actually uses."""
    use_script(
        monkeypatch,
        [
            {"caller": "आपका आधार नंबर बताइए।"},
            {"learner": ["चार दो", "आठ नौ", "एक सात"]},  # split the way speech recognition splits
            {"pause": 5.0},
        ],
    )
    socket = FakeSocket()
    await drive(socket, make_token())

    record = harness.finished[0]["record"]
    assert record.endReason == "tripwire"
    assert socket.messages_of("ended")[0]["reason"] == "tripwire"

    stored = json.dumps(
        {"t": [line.model_dump() for line in record.transcript], "e": [e.model_dump() for e in record.events]},
        ensure_ascii=False,
    )
    for digits in ("चार दो", "आठ नौ", "एक सात", "428917"):
        assert digits not in stored, "a number the learner said reached storage"
    captions = json.dumps(socket.messages_of("caption"), ensure_ascii=False)
    assert "एक सात" not in captions, "the tripping fragment was echoed back to the browser"


async def test_the_safe_word_ends_the_call_through_the_socket(
    harness: FakeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_script(
        monkeypatch,
        [{"caller": "आप घबराइए मत।"}, {"learner": "रोको"}, {"pause": 5.0}],
    )
    socket = FakeSocket()
    await drive(socket, make_token())
    assert harness.finished[0]["record"].endReason == "safe_word"
    assert socket.messages_of("ended")[0]["reason"] == "safe_word"


async def test_the_cap_ends_the_call(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """The six minute cap is a timer, never a prompt. Here it is two seconds."""
    use_script(monkeypatch, [{"caller": "नमस्ते"}, {"pause": 30.0}])
    socket = FakeSocket()
    await drive(socket, make_token(x=10), frames=1)
    # The token asks for 10 seconds; the runner honours the token, not the process default.
    assert socket.messages_of("ready")[0]["maxSeconds"] == 10
    assert harness.finished[0]["record"].endReason == "timeout"
    assert harness.finished[0]["record"].maxSeconds == 10


async def test_the_learner_microphone_is_never_persisted(harness: FakeStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the caller is recorded. The learner's audio is the one thing that might contain the
    number the tripwire exists to stop, so it is never written anywhere."""
    use_script(
        monkeypatch,
        [{"caller": "नमस्ते"}, {"caller": "ठीक है।", "tools": [{"name": "end_drill", "input": {"reason": "completed"}}]}],
    )
    socket = FakeSocket()
    socket.client_text({"type": "hello", "token": make_token()})
    loud = bytes([0x7F, 0x7F]) * 512  # nothing like silence, so it is obvious if it leaks through
    for _ in range(10):
        socket.client_bytes(loud)
    await asyncio.wait_for(server.drill_socket(socket, None), timeout=20)
    assert loud not in harness.finished[0]["caller_pcm"]

"""The browser <-> agent wire protocol, in one file so both ends can be read side by side.

The mirror of this file is `apps/web/src/lib/drill-wire.ts`. Change them together.

Frames
------
Audio travels as **binary** frames of raw PCM: 16-bit signed little-endian, mono, 16 kHz, the
format `audio.py` already uses everywhere. Binary rather than base64 JSON because AgentCore caps a
WebSocket frame at 64 KB and a connection at 250 frames per second; a 64 ms chunk is 2048 bytes and
about 16 frames per second in each direction, which leaves the limits far away.

Everything that is not audio travels as a **text** frame holding one JSON object with a `type`.

Client to server
----------------
- text  `{"type": "hello", "token": "<drill session token>"}`  exactly once, first
- binary raw PCM, learner microphone, continuously until the call ends
- text  `{"type": "hangup"}`  the learner pressed the red button

Nothing else the client sends is trusted. The drill id, the member, the language, the scenario and
the cap all come out of the signed token, never out of a client field.

Server to client
----------------
- text  `{"type": "ready", "drillId": ..., "maxSeconds": 360, "safeWord": "ROKO", "language": ...}`
- binary raw PCM, the caller's voice
- text  `{"type": "clear"}`  drop whatever is still queued: the caller was interrupted, or cut off
- text  `{"type": "caption", "role": "learner"|"caller", "text": ...}`  already redacted
- text  `{"type": "ended", "reason": ..., "finalStage": ..., "durationSeconds": ...}`
- text  `{"type": "error", "code": ...}`  then the socket closes

Captions for `role: "learner"` are the learner's own words, on the learner's own device, during
their own call. They are never sent anywhere else (PRD principle 4).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION = 1

# Close codes. 1000 is a normal close; these say why in a way the browser can act on.
CLOSE_NORMAL = 1000
CLOSE_POLICY = 1008  # the token was missing, invalid, expired or already used

ErrorCode = Literal[
    "bad_hello",  # first frame was not a valid hello
    "invalid_token",  # signature, expiry or binding failed
    "drill_unavailable",  # the drill is not claimable: wrong state, already used, cancelled
    "not_consented",  # consent missing or revoked between minting and connecting
    "internal",
]


class Hello(BaseModel):
    """The only client message that carries anything the server acts on."""

    type: Literal["hello"]
    token: str = Field(min_length=16, max_length=4096)


class Hangup(BaseModel):
    type: Literal["hangup"]


def ready(drill_id: str, *, max_seconds: int, safe_word: str, language: str) -> dict[str, object]:
    return {
        "type": "ready",
        "v": PROTOCOL_VERSION,
        "drillId": drill_id,
        "maxSeconds": max_seconds,
        "safeWord": safe_word,
        "language": language,
    }


def caption(role: str, text: str) -> dict[str, object]:
    return {"type": "caption", "role": role, "text": text}


def clear() -> dict[str, object]:
    return {"type": "clear"}


def ended(reason: str | None, final_stage: str, duration_seconds: float) -> dict[str, object]:
    return {
        "type": "ended",
        "reason": reason,
        "finalStage": final_stage,
        "durationSeconds": round(duration_seconds, 1),
    }


def error(code: ErrorCode) -> dict[str, object]:
    return {"type": "error", "code": code}

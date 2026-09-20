"""The token the web app mints and the agent verifies.

`fixtures/drill-session-token.json` is the contract between the two implementations: a token the
TypeScript signer really produced, verified here by the Python verifier. Both sides read that one
file, so if either changes the payload keys, the key derivation or the encoding, a test fails
instead of a learner meeting a locked door.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from chaukanna_agent.session_token import (
    MAX_SKEW_SECONDS,
    PURPOSE,
    DrillSessionClaims,
    InvalidToken,
    derive_key,
    verify,
)
from tests.conftest import FIXTURES

MASTER_KEY = "test-master-key-not-a-real-secret"

# A token the TypeScript signer really produced, committed so this side can verify it. Its `exp`
# is in 2100 so the fixture does not rot.
VECTOR = json.loads((FIXTURES / "drill-session-token.json").read_text(encoding="utf-8"))
CROSS_LANGUAGE_VECTOR = {"masterKey": VECTOR["masterKey"], "payload": VECTOR["claims"]}


def sign(payload: dict[str, object], master_key: str = MASTER_KEY) -> str:
    """The web app's `sign`, reimplemented here so the test does not depend on the code it pins."""
    body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")
    key = hmac.new(master_key.encode("utf-8"), PURPOSE.encode("utf-8"), hashlib.sha256).digest()
    mac = hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(mac).decode('ascii').rstrip('=')}"


@pytest.fixture
def key() -> bytes:
    return derive_key(MASTER_KEY)


def test_derive_key_is_purpose_bound() -> None:
    """An invite token must never be usable as a drill session token."""
    invite_key = hmac.new(MASTER_KEY.encode(), b"chaukanna:invite:v1", hashlib.sha256).digest()
    assert derive_key(MASTER_KEY) != invite_key


def test_the_token_typescript_signed_verifies_here() -> None:
    """The contract. This token was produced by `apps/web/src/lib/drill-session.ts`, not by the
    `sign` helper below, so it fails if the two implementations ever drift apart."""
    claims = verify(VECTOR["token"], derive_key(VECTOR["masterKey"]))
    assert claims.model_dump() == VECTOR["claims"]


def test_the_shared_fixture_is_not_signed_by_a_different_key() -> None:
    with pytest.raises(InvalidToken):
        verify(VECTOR["token"], derive_key("some other master key"))


def test_round_trip(key: bytes) -> None:
    claims = verify(sign(CROSS_LANGUAGE_VECTOR["payload"]), key)  # type: ignore[arg-type]
    assert isinstance(claims, DrillSessionClaims)
    assert claims.drill_id == "d1e2f3a4b5c6d7e8f9a0"
    assert claims.member_id == "abcdef0123456789abcd"
    assert claims.household_id == "0123456789abcdef0123"
    assert claims.scheduled_at == "2026-09-20T11:30:00.000Z"
    assert claims.language == "hi-IN"
    assert claims.scenario_id == "digital_arrest_v1"
    assert claims.max_seconds == 360
    assert claims.jti == "9f8e7d6c5b4a39281706"


def test_tampered_payload_is_rejected(key: bytes) -> None:
    token = sign(CROSS_LANGUAGE_VECTOR["payload"])  # type: ignore[arg-type]
    body, mac = token.split(".")
    forged = dict(CROSS_LANGUAGE_VECTOR["payload"], x=900)  # type: ignore[arg-type]
    forged_body = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip("=")
    assert forged_body != body
    with pytest.raises(InvalidToken):
        verify(f"{forged_body}.{mac}", key)


def test_wrong_master_key_is_rejected(key: bytes) -> None:
    with pytest.raises(InvalidToken):
        verify(sign(CROSS_LANGUAGE_VECTOR["payload"], master_key="a different key"), key)  # type: ignore[arg-type]


@pytest.mark.parametrize("token", ["", ".", "a.", ".b", "nodot", "a.b.c", "!!.??"])
def test_malformed_tokens_are_rejected(key: bytes, token: str) -> None:
    with pytest.raises(InvalidToken):
        verify(token, key)


def test_expiry_is_enforced(key: bytes) -> None:
    now = time.time()
    payload = dict(CROSS_LANGUAGE_VECTOR["payload"], exp=int(now - MAX_SKEW_SECONDS - 10))  # type: ignore[arg-type]
    with pytest.raises(InvalidToken):
        verify(sign(payload), key, now=now)


def test_small_clock_skew_is_tolerated(key: bytes) -> None:
    now = time.time()
    payload = dict(CROSS_LANGUAGE_VECTOR["payload"], exp=int(now - 5))  # type: ignore[arg-type]
    assert verify(sign(payload), key, now=now).exp <= now


@pytest.mark.parametrize(
    "override",
    [
        {"x": 9},  # under the floor
        {"x": 901},  # over the six minute cap plus slack
        {"l": "ta-IN"},  # a language we do not have a voice or a prompt for
        {"d": "no"},  # too short to be an id
    ],
)
def test_out_of_range_claims_are_rejected(key: bytes, override: dict[str, object]) -> None:
    payload = dict(CROSS_LANGUAGE_VECTOR["payload"], **override)  # type: ignore[arg-type]
    with pytest.raises(InvalidToken):
        verify(sign(payload), key)


def test_missing_claim_is_rejected(key: bytes) -> None:
    payload = dict(CROSS_LANGUAGE_VECTOR["payload"])  # type: ignore[arg-type]
    del payload["j"]
    with pytest.raises(InvalidToken):
        verify(sign(payload), key)

"""The drill session token the web app hands the browser, verified here.

The browser is never trusted with which drill it is taking, who it is, which language to speak or
how long the call may run. All of that is signed into this token by `apps/web/src/lib/drill-session.ts`
and read back out here. The two files must agree on the payload keys and on how the key is derived;
`tests/test_session_token.py` pins the format against a vector the web test produces.

Format, identical to the invite token in `apps/web/src/lib/signing.ts`:

    base64url(payloadJson) "." base64url(hmacSHA256(payloadB64, key))
    key = hmacSHA256(masterKey, "chaukanna:drill-session:v1")

Signature validity is only half of it. A valid token still has to *claim* the drill, a conditional
write in `store.py` that succeeds once. That is what makes a leaked token useless for a second call.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from functools import lru_cache
from typing import Literal

import boto3
from pydantic import BaseModel, Field

SECRET_ID = "chaukanna/invite-signing-key"
PURPOSE = "chaukanna:drill-session:v1"
# Tokens are minted with a five minute life. We allow a little clock skew and nothing more.
MAX_SKEW_SECONDS = 60


class InvalidToken(Exception):
    """Malformed, badly signed, or expired. The caller must not say which."""


class DrillSessionClaims(BaseModel):
    """Short keys, because the token rides in a URL-adjacent place and stays small."""

    d: str = Field(min_length=4, max_length=64)  # drillId
    m: str = Field(min_length=4, max_length=64)  # memberId
    h: str = Field(min_length=4, max_length=64)  # householdId
    # scheduledAt, the timestamp inside the drill row's sort key. Carried so the agent addresses
    # the row directly instead of querying for it on the path to first audio.
    t: str = Field(min_length=10, max_length=40)
    l: Literal["hi-IN", "en-IN"]
    s: str = Field(min_length=1, max_length=64)  # scenarioId
    x: int = Field(ge=10, le=900)  # maxSeconds
    j: str = Field(min_length=8, max_length=64)  # jti, the single use claim
    exp: int

    @property
    def drill_id(self) -> str:
        return self.d

    @property
    def scheduled_at(self) -> str:
        return self.t

    @property
    def member_id(self) -> str:
        return self.m

    @property
    def household_id(self) -> str:
        return self.h

    @property
    def language(self) -> str:
        return self.l

    @property
    def scenario_id(self) -> str:
        return self.s

    @property
    def max_seconds(self) -> int:
        return self.x

    @property
    def jti(self) -> str:
        return self.j


def derive_key(master_key: str) -> bytes:
    return hmac.new(master_key.encode("utf-8"), PURPOSE.encode("utf-8"), hashlib.sha256).digest()


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify(token: str, key: bytes, *, now: float | None = None) -> DrillSessionClaims:
    """Returns the claims, or raises `InvalidToken`. Never raises anything else."""
    parts = token.split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise InvalidToken("malformed")
    body, mac_b64 = parts
    expected = hmac.new(key, body.encode("ascii", errors="strict"), hashlib.sha256).digest()
    try:
        actual = _b64url_decode(mac_b64)
    except (ValueError, TypeError) as error:
        raise InvalidToken("malformed") from error
    if not hmac.compare_digest(actual, expected):
        raise InvalidToken("bad signature")
    try:
        payload = json.loads(_b64url_decode(body))
        claims = DrillSessionClaims.model_validate(payload)
    except Exception as error:
        raise InvalidToken("bad payload") from error
    if claims.exp < (time.time() if now is None else now) - MAX_SKEW_SECONDS:
        raise InvalidToken("expired")
    return claims


@lru_cache(maxsize=1)
def _cached_master_key(region: str) -> str:
    client = boto3.client("secretsmanager", region_name=region)
    return client.get_secret_value(SecretId=SECRET_ID)["SecretString"]


def signing_key(region: str) -> bytes:
    """The derived key, fetched once per process. One microVM serves one drill, so this is really
    once per call, but a retried connection should not pay for the secret twice."""
    return derive_key(_cached_master_key(region))

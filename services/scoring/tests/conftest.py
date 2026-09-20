"""Hand written fakes for S3, DynamoDB, Bedrock and Polly.

No moto, no network, no credentials. Everything this service does to AWS is four calls
(`get_object`, `put_object`, `apply_guardrail`/`converse`, `synthesize_speech`) plus two writes,
and a fake that raises the one error that matters tests them faster and more honestly than a mock
service would.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "fixtures" / "transcripts"

DRILL_ID = "c3d4e5f6"
MEMBER_ID = "b2c3d4e5"
HOUSEHOLD_ID = "a1b2c3d4"
SCHEDULED_AT = "2026-09-20T05:30:00.000Z"


def fixture_names() -> list[str]:
    return sorted(path.stem for path in FIXTURE_DIR.glob("*.json"))


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))


def conditional_check_failed() -> ClientError:
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "the condition failed"}},
        "UpdateItem",
    )


class FakeS3:
    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(objects or {})
        self.puts: list[dict[str, Any]] = []

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]
        if key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": key}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[key])}

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.puts.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]
        return {}


class FakeDdb:
    """Key lookups and a conditional state transition. Nothing else is exercised here."""

    def __init__(self, items: dict[tuple[str, str], dict[str, Any]] | None = None) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = dict(items or {})
        self.puts: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.fail_next_condition = False

    def put(self, item: dict[str, Any]) -> None:
        self.items[(item["pk"]["S"], item["sk"]["S"])] = item

    def put_item(self, **kwargs: Any) -> dict[str, Any]:
        self.puts.append(kwargs["Item"])
        self.put(kwargs["Item"])
        return {}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        key = (kwargs["Key"]["pk"]["S"], kwargs["Key"]["sk"]["S"])
        item = self.items.get(key)
        expected = kwargs["ExpressionAttributeValues"].get(":expected", {}).get("S")
        if self.fail_next_condition or item is None or (expected and item["state"]["S"] != expected):
            self.fail_next_condition = False
            raise conditional_check_failed()
        self.updates.append(kwargs)
        item["state"] = kwargs["ExpressionAttributeValues"][":next"]
        return {}


class FakeGuardrail:
    """`apply_guardrail`. `masks` maps a substring to what it becomes."""

    def __init__(self, masks: dict[str, str] | None = None, error: Exception | None = None) -> None:
        self.masks = masks or {}
        self.error = error
        self.calls: list[str] = []

    def apply_guardrail(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise self.error
        text = kwargs["content"][0]["text"]["text"]
        self.calls.append(text)
        for needle, replacement in self.masks.items():
            if needle in text:
                return {"action": "GUARDRAIL_INTERVENED", "outputs": [{"text": text.replace(needle, replacement)}]}
        return {"action": "NONE", "outputs": []}


class FakeConverse:
    """`converse`, returning canned replies in order. The last one repeats."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        index = min(len(self.calls) - 1, len(self.replies) - 1)
        return {"output": {"message": {"content": [{"text": self.replies[index]}]}}}


class FakeBedrock(FakeGuardrail, FakeConverse):
    """Both surfaces on one client, because `bedrock-runtime` is one client."""

    def __init__(
        self, replies: list[str] | None = None, masks: dict[str, str] | None = None, error: Exception | None = None
    ) -> None:
        FakeGuardrail.__init__(self, masks=masks, error=error)
        FakeConverse.__init__(self, replies=replies or ["{}"])


class FakePolly:
    def __init__(self, audio: bytes = b"ID3fake") -> None:
        self.audio = audio
        self.calls: list[dict[str, Any]] = []

    def synthesize_speech(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"AudioStream": io.BytesIO(self.audio)}


def drill_item(state: str = "ended") -> dict[str, Any]:
    return {
        "pk": {"S": f"MEMBER#{MEMBER_ID}"},
        "sk": {"S": f"DRILL#{SCHEDULED_AT}#{DRILL_ID}"},
        "entity": {"S": "Drill"},
        "drillId": {"S": DRILL_ID},
        "state": {"S": state},
    }


@pytest.fixture
def s3() -> FakeS3:
    return FakeS3()


@pytest.fixture
def ddb() -> FakeDdb:
    fake = FakeDdb()
    fake.put(drill_item())
    return fake


@pytest.fixture
def polly() -> FakePolly:
    return FakePolly()


@pytest.fixture(autouse=True)
def scoring_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_REGION", "ap-south-1")
    monkeypatch.setenv("TABLE_NAME", "chaukanna-test")
    monkeypatch.setenv("ARTIFACTS_BUCKET", "chaukanna-artifacts-test")
    monkeypatch.setenv("GUARDRAIL_ID", "gr-test")
    monkeypatch.setenv("GUARDRAIL_VERSION", "DRAFT")

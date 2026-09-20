"""The five Lambda wrappers: validation, the patch shape, and that they stay thin."""

from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import (
    DRILL_ID,
    MEMBER_ID,
    SCHEDULED_AT,
    FakeBedrock,
    FakeDdb,
    FakePolly,
    FakeS3,
    load_fixture,
)

from scoring_service import aws, handlers
from scoring_service.redact import redacted_key
from scoring_service.rubric import CREDIT_WEIGHTS, FLAG_WEIGHTS
from scoring_service.transcript import from_fixture

BUCKET = "chaukanna-artifacts-test"
TRANSCRIPT_KEY = f"drill/transcript/{DRILL_ID}.json"

JUDGE_REPLY = json.dumps(
    {
        "flags": {
            flag_id: {
                "fired": flag_id == "stayed_on_call",
                "evidence": "haan ji" if flag_id == "stayed_on_call" else "",
            }
            for flag_id in FLAG_WEIGHTS
        },
        "credits": {credit_id: {"fired": False, "evidence": ""} for credit_id in CREDIT_WEIGHTS},
        "turning_point": "Yeh matter cyber cell ke paas hai.",
    }
)


@pytest.fixture
def clients(monkeypatch: pytest.MonkeyPatch, ddb: FakeDdb, polly: FakePolly) -> dict[str, Any]:
    transcript = from_fixture(load_fixture("compliant"), drill_id=DRILL_ID)
    body = json.dumps(transcript.to_dict(), ensure_ascii=False).encode("utf-8")
    fakes: dict[str, Any] = {
        "s3": FakeS3({TRANSCRIPT_KEY: body, redacted_key(DRILL_ID): body}),
        "bedrock-runtime": FakeBedrock(replies=[JUDGE_REPLY]),
        "dynamodb": ddb,
        "polly": polly,
    }
    monkeypatch.setattr(aws, "client", lambda service: fakes[service])
    return fakes


def base_event(**extra: Any) -> dict[str, Any]:
    return {"drillId": DRILL_ID, "memberId": MEMBER_ID, "scheduledAt": SCHEDULED_AT, **extra}


def test_redact_handler_returns_the_redaction_patch(clients: dict[str, Any]) -> None:
    patch = handlers.redact_handler(base_event(transcriptKey=TRANSCRIPT_KEY))
    assert patch["redactedKey"] == redacted_key(DRILL_ID)
    assert set(patch) == {"redactedKey", "lines", "maskedLines", "guardrailAction"}
    assert patch["lines"] > 0


def test_redact_handler_rejects_a_missing_transcript_key(clients: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="transcriptKey"):
        handlers.redact_handler(base_event())


def test_judge_handler_reads_the_redacted_copy(clients: dict[str, Any]) -> None:
    patch = handlers.judge_handler(base_event(redaction={"redactedKey": redacted_key(DRILL_ID)}))
    assert patch["flags"]["stayed_on_call"]["fired"] is True
    assert patch["promptVersion"] == "score.judge.v2"


def test_judge_handler_refuses_to_read_the_raw_transcript(clients: dict[str, Any]) -> None:
    """There is no path from the judge to the unredacted object: it only knows redactedKey."""
    with pytest.raises(ValueError, match="redaction.redactedKey"):
        handlers.judge_handler(base_event(transcriptKey=TRANSCRIPT_KEY))


def test_score_handler_is_pure(clients: dict[str, Any]) -> None:
    judgement = handlers.judge_handler(base_event(redaction={"redactedKey": redacted_key(DRILL_ID)}))
    patch = handlers.score_handler(base_event(judgement=judgement))
    assert patch == {"score": 25, "band": "at_risk", "rubricVersion": "prd.v1"}


def test_score_handler_rejects_a_missing_judgement(clients: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="judgement"):
        handlers.score_handler(base_event())


def test_debrief_handler_writes_audio_and_returns_the_patch(clients: dict[str, Any]) -> None:
    clients["bedrock-runtime"].replies = ["Aapne achha kiya. Phone rakh dijiye."]
    event = base_event(
        redaction={"redactedKey": redacted_key(DRILL_ID)},
        judgement={"flags": {}, "credits": {}, "turningPoint": "Yeh matter cyber cell ke paas hai."},
        score={"score": 25, "band": "at_risk"},
    )
    patch = handlers.debrief_handler(event)
    assert patch["audioKey"] == f"debrief/{DRILL_ID}.mp3"
    assert patch["voiceId"] == "Kajal"
    assert patch["languageCode"] == "hi-IN"
    assert clients["polly"].calls[0]["Engine"] == "neural"


def test_debrief_handler_refuses_without_a_band(clients: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="score.band"):
        handlers.debrief_handler(base_event(redaction={"redactedKey": redacted_key(DRILL_ID)}))


def test_finish_handler_returns_a_status(clients: dict[str, Any]) -> None:
    event = base_event(
        judgement={"flags": {}, "credits": {}, "turningPoint": ""},
        score={"score": 25, "band": "at_risk", "rubricVersion": "prd.v1"},
        debrief={"text": "Aapne achha kiya.", "audioKey": f"debrief/{DRILL_ID}.mp3"},
    )
    assert handlers.finish_handler(event) == {"status": "scored"}


def test_finish_handler_rejects_a_missing_drill_key(clients: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="scheduledAt"):
        handlers.finish_handler({"drillId": DRILL_ID, "memberId": MEMBER_ID})


def test_no_runtime_module_imports_a_third_party_package() -> None:
    """`Code.fromAsset` installs nothing and the Python 3.12 runtime ships boto3 and nothing
    else, so an import here fails at cold start, not in CI. This is the check that catches it."""
    import ast
    from pathlib import Path

    allowed = {"boto3", "botocore", "scoring_service"}
    package = Path(handlers.__file__).parent
    offenders: list[str] = []
    for path in sorted(package.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]] if node.level == 0 else []
            else:
                continue
            for name in names:
                if name and name not in allowed and name not in _STDLIB:
                    offenders.append(f"{path.name}: {name}")
    assert not offenders, f"third party imports in runtime code: {offenders}"


_STDLIB = {
    "argparse",
    "ast",
    "dataclasses",
    "datetime",
    "importlib",
    "io",
    "json",
    "logging",
    "os",
    "pathlib",
    "re",
    "sys",
    "typing",
    "__future__",
}

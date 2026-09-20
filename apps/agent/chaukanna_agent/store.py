"""Persistence for a finished drill: the drill row, the event log, the transcript and the audio.

Everything here runs in `ap-south-1` (the data region) while the model runs in `ap-northeast-1`,
so every client is constructed with an explicit region. Reading `AWS_REGION` here would silently
point at the region AgentCore happens to run the container in.

Two rules this file exists to keep:

- **Claim before speak.** `claim` is a conditional write that turns `session_pending` into
  `in_progress` exactly once. A token that is replayed, or shared, loses the race and gets nothing.
  It is the only thing standing between a leaked token and a second call.
- **Nothing unredacted is written.** The transcript in a `DrillRecord` was redacted as it was
  built, in `session.py`, before it ever reached memory. The audio object holds **only the
  caller's voice**: the learner's microphone is never written to disk, to S3 or to a log, because
  the one thing it might contain is the number the tripwire exists to stop.
"""

from __future__ import annotations

import io
import json
import logging
import wave
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
from botocore.exceptions import ClientError

from .audio import CHANNELS, SAMPLE_RATE, SAMPLE_WIDTH
from .clock import utc_now_iso
from .log import event
from .session import DrillRecord

# Keys. The bucket's lifecycle rules are per prefix, so audio (7 days) and transcripts (30 days)
# live under different prefixes. See PRD section 8.6 and infra/lib/chaukanna-stack.ts.
AUDIO_PREFIX = "drill/audio/"
TRANSCRIPT_PREFIX = "drill/transcript/"

EVENT_TTL_DAYS = 400  # the audit row outlives the transcript; it carries ids and labels only
DDB_BATCH_SIZE = 25


def audio_key(drill_id: str) -> str:
    return f"{AUDIO_PREFIX}{drill_id}.wav"


def transcript_key(drill_id: str) -> str:
    return f"{TRANSCRIPT_PREFIX}{drill_id}.json"


def drill_keys(member_id: str, scheduled_at: str, drill_id: str) -> dict[str, str]:
    return {"pk": f"MEMBER#{member_id}", "sk": f"DRILL#{scheduled_at}#{drill_id}"}


def member_keys(household_id: str, member_id: str) -> dict[str, str]:
    return {"pk": f"HH#{household_id}", "sk": f"MEMBER#{member_id}"}


def event_keys(drill_id: str, seq: int) -> dict[str, str]:
    return {"pk": f"DRILL#{drill_id}", "sk": f"EVT#{seq:06d}"}


def pcm_to_wav(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(CHANNELS)
        out.setsampwidth(SAMPLE_WIDTH)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)
    return buffer.getvalue()


class DrillClaimError(Exception):
    """The drill could not be claimed. `code` is safe to send to the browser."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DrillStore:
    """All DynamoDB and S3 access for a drill. One instance per process is fine."""

    def __init__(self, *, region: str, table_name: str, bucket: str) -> None:
        self.region = region
        self.table_name = table_name
        self.bucket = bucket
        session = boto3.Session(region_name=region)
        self._ddb = session.client("dynamodb")
        self._s3 = session.client("s3")

    # ---- before the call ------------------------------------------------------------------

    def assert_member_active(self, household_id: str, member_id: str) -> None:
        """Consent can be withdrawn between minting a token and connecting with it. The kill
        switch has to win that race, so it is checked here and not only at mint time."""
        out = self._ddb.get_item(
            TableName=self.table_name,
            Key={k: {"S": v} for k, v in member_keys(household_id, member_id).items()},
            ConsistentRead=True,
            ProjectionExpression="#s",
            ExpressionAttributeNames={"#s": "status"},
        )
        status = out.get("Item", {}).get("status", {}).get("S")
        if status != "active":
            raise DrillClaimError("not_consented")

    def claim(self, *, member_id: str, scheduled_at: str, drill_id: str, jti: str) -> None:
        """Single use. Succeeds only while the drill is waiting for this exact session token."""
        now = utc_now_iso()
        try:
            self._ddb.update_item(
                TableName=self.table_name,
                Key={k: {"S": v} for k, v in drill_keys(member_id, scheduled_at, drill_id).items()},
                UpdateExpression=(
                    "SET #state = :inprogress, gsi1pk = :gsi1pk, startedAt = :now, updatedAt = :now "
                    "REMOVE sessionJti, sessionExpiresAt"
                ),
                ConditionExpression="attribute_exists(pk) AND #state = :pending AND sessionJti = :jti",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={
                    ":inprogress": {"S": "in_progress"},
                    ":pending": {"S": "session_pending"},
                    ":gsi1pk": {"S": "STATE#in_progress"},
                    ":jti": {"S": jti},
                    ":now": {"S": now},
                },
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise DrillClaimError("drill_unavailable") from error
            raise

    # ---- after the call -------------------------------------------------------------------

    def finish(self, record: DrillRecord, *, member_id: str, scheduled_at: str, caller_pcm: bytes) -> None:
        """Writes the artifacts first, then the row that points at them, so a row never names an
        object that does not exist. Each step is logged; a failure in one does not skip the rest."""
        written: dict[str, str] = {}
        if caller_pcm:
            written["audioKey"] = self._put_audio(record.drillId, caller_pcm)
        written["transcriptKey"] = self._put_transcript(record)
        self._put_events(record)
        self._update_drill(record, member_id=member_id, scheduled_at=scheduled_at, artifacts=written)

    def _put_audio(self, drill_id: str, caller_pcm: bytes) -> str:
        key = audio_key(drill_id)
        self._s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=pcm_to_wav(caller_pcm),
            ContentType="audio/wav",
            Metadata={"drillid": drill_id, "contains": "caller-only"},
        )
        event("drill_audio_written", drill_id, bytes=len(caller_pcm))
        return key

    def _put_transcript(self, record: DrillRecord) -> str:
        key = transcript_key(record.drillId)
        self._s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=record.model_dump_json().encode("utf-8"),
            ContentType="application/json",
        )
        event("drill_transcript_written", record.drillId, lines=len(record.transcript))
        return key

    def _put_events(self, record: DrillRecord) -> None:
        expires = int((datetime.now(UTC) + timedelta(days=EVENT_TTL_DAYS)).timestamp())
        items = [
            {
                **{k: {"S": v} for k, v in event_keys(record.drillId, entry.seq).items()},
                "entity": {"S": "DrillEvent"},
                "drillId": {"S": record.drillId},
                "seq": {"N": str(entry.seq)},
                "ts": {"S": entry.ts},
                "t": {"N": str(entry.t)},
                "type": {"S": entry.type},
                "stage": {"S": entry.stage},
                "payload": {"S": json.dumps(entry.payload, ensure_ascii=False, default=str)},
                "ttl": {"N": str(expires)},
            }
            for entry in record.events
        ]
        for start in range(0, len(items), DDB_BATCH_SIZE):
            batch = items[start : start + DDB_BATCH_SIZE]
            unprocessed = (
                self._ddb.batch_write_item(
                    RequestItems={self.table_name: [{"PutRequest": {"Item": item}} for item in batch]}
                ).get("UnprocessedItems")
                or {}
            )
            if unprocessed.get(self.table_name):
                # Ten events per drill at this scale; one retry is the whole backoff story.
                self._ddb.batch_write_item(RequestItems=unprocessed)
        event("drill_events_written", record.drillId, count=len(items))

    def _update_drill(
        self, record: DrillRecord, *, member_id: str, scheduled_at: str, artifacts: dict[str, str]
    ) -> None:
        # Red flag ids and where they happened, never the quote. The quote is transcript text and
        # a guardian may not read transcripts (PRD F7 AC2); it stays in the S3 object.
        flags = [{"M": {"id": {"S": f.id}, "stage": {"S": f.stage}, "seq": {"N": str(f.seq)}}} for f in record.redFlags]
        values: dict[str, Any] = {
            ":ended": {"S": "ended"},
            ":gsi1pk": {"S": "STATE#ended"},
            ":endedAt": {"S": record.endedAt or utc_now_iso()},
            ":endReason": {"S": record.endReason or "error"},
            ":endSource": {"S": record.endSource or "unknown"},
            ":finalStage": {"S": record.finalStage},
            ":duration": {"N": str(record.durationSeconds)},
            ":flags": {"L": flags},
            ":promptVersions": {"M": {k: {"S": v} for k, v in record.promptVersions.items()}},
            ":voice": {"S": record.voice},
        }
        sets = [
            "#state = :ended",
            "gsi1pk = :gsi1pk",
            "endedAt = :endedAt",
            "updatedAt = :endedAt",
            "endReason = :endReason",
            "endSource = :endSource",
            "finalStage = :finalStage",
            "durationSeconds = :duration",
            "redFlags = :flags",
            "promptVersions = :promptVersions",
            "voice = :voice",
        ]
        for name, key in artifacts.items():
            sets.append(f"{name} = :{name}")
            values[f":{name}"] = {"S": key}
        self._ddb.update_item(
            TableName=self.table_name,
            Key={k: {"S": v} for k, v in drill_keys(member_id, scheduled_at, record.drillId).items()},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues=values,
        )
        event("drill_row_finished", record.drillId, reason=record.endReason, stage=record.finalStage)

    def release(self, *, member_id: str, scheduled_at: str, drill_id: str, reason: str) -> None:
        """The call never really started (the model would not connect, the socket died during the
        handshake). Mark the drill ended rather than leaving it stuck `in_progress` forever."""
        now = utc_now_iso()
        try:
            self._ddb.update_item(
                TableName=self.table_name,
                Key={k: {"S": v} for k, v in drill_keys(member_id, scheduled_at, drill_id).items()},
                UpdateExpression=(
                    "SET #state = :ended, gsi1pk = :gsi1pk, endedAt = :now, updatedAt = :now, "
                    "endReason = :reason, endSource = :source"
                ),
                ConditionExpression="attribute_exists(pk) AND #state = :inprogress",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={
                    ":ended": {"S": "ended"},
                    ":gsi1pk": {"S": "STATE#ended"},
                    ":inprogress": {"S": "in_progress"},
                    ":now": {"S": now},
                    ":reason": {"S": "error"},
                    ":source": {"S": reason[:40]},
                },
            )
        except ClientError as error:
            event("drill_release_failed", drill_id, level=logging.WARNING, errorName=type(error).__name__)

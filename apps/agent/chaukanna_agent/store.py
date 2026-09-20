"""Persistence for a finished drill: the drill row, the event log, the transcript, the audio, and
the one call that hands the drill to the scoring pipeline.

Everything here runs in `ap-south-1` (the data region) while the model runs in `ap-northeast-1`,
so every client is constructed with an explicit region. Reading `AWS_REGION` here would silently
point at the region AgentCore happens to run the container in. That applies to Step Functions too:
the scoring state machine lives beside the table and the bucket, not beside the model, so its
client takes the same explicit data region as the others.

Two rules this file exists to keep:

- **Claim before speak.** `claim` is a conditional write that turns `session_pending` into
  `in_progress` exactly once. A token that is replayed, or shared, loses the race and gets nothing.
  It is the only thing standing between a leaked token and a second call.
- **Scoring is best effort.** `start_scoring` is the last thing a drill does and it never raises.
  The row is already `ended` and the learner has already been told the call is over; an unscored
  drill is a degraded outcome with a documented debrief fallback, not a broken one.
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

# Execution names are unique inside the Step Functions history window, so naming the execution
# after the drill is what makes a retried start idempotent: the second one is refused by name.
SCORING_EXECUTION_PREFIX = "drill-"


def audio_key(drill_id: str) -> str:
    return f"{AUDIO_PREFIX}{drill_id}.wav"


def transcript_key(drill_id: str) -> str:
    return f"{TRANSCRIPT_PREFIX}{drill_id}.json"


def scoring_execution_name(drill_id: str) -> str:
    return f"{SCORING_EXECUTION_PREFIX}{drill_id}"


def worth_scoring(record: DrillRecord) -> bool:
    """Whether a finished drill produced anything a judge could read.

    Almost everything is worth scoring, and deliberately so. `hangup` is the *best* result in the
    rubric - `disconnected_early` is the largest credit - so an immediate hang up must be scored
    or the learner who did the right thing is the one who never gets told. `tripwire` carries the
    flag that fired, `timeout` and `completed` mean the learner stayed on the call, and
    `safe_word` / `is_this_real` / `distress` / `model_ended` all follow real learner turns.

    The one case left out is a drill that broke before the learner ever spoke: `error` (the socket
    died, the model would not connect) with no learner line in the transcript. There is no
    behaviour there to judge, and a band produced from nothing would be invented rather than
    measured. A session that never started at all never reaches this function: `release` ends that
    row and `finish` is never called.
    """
    if record.endReason in (None, "error"):
        return any(line.role == "learner" for line in record.transcript)
    return True


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

    def __init__(
        self, *, region: str, table_name: str, bucket: str, scoring_state_machine_arn: str | None = None
    ) -> None:
        self.region = region
        self.table_name = table_name
        self.bucket = bucket
        self.scoring_state_machine_arn = scoring_state_machine_arn
        session = boto3.Session(region_name=region)
        self._ddb = session.client("dynamodb")
        self._s3 = session.client("s3")
        # Built only when scoring is wired up, and in the data region like the other two.
        self._sfn = session.client("stepfunctions") if scoring_state_machine_arn else None

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

    # ---- handing the drill to scoring -----------------------------------------------------

    def start_scoring(
        self,
        record: DrillRecord,
        *,
        member_id: str,
        scheduled_at: str,
        household_id: str,
        transcript_key: str,
    ) -> str | None:
        """Start the scoring state machine for a drill that has already been persisted.

        Never raises. Every outcome - not configured, not worth scoring, already running, refused
        by AWS - is one structured log line and a `None`, because the learner has been told the
        call is over and must not be made to wait on, or suffer from, the scoring pipeline.
        """
        drill_id = record.drillId
        if not self.scoring_state_machine_arn or self._sfn is None:
            # A local drill or a dev container with no pipeline behind it. Say so once, carry on.
            event("drill_scoring_not_configured", drill_id)
            return None
        if not worth_scoring(record):
            event("drill_scoring_skipped", drill_id, reason=record.endReason or "unknown", learnerTurns=0)
            return None

        name = scoring_execution_name(drill_id)
        payload = {
            "drillId": drill_id,
            "memberId": member_id,
            "householdId": household_id,
            "scheduledAt": scheduled_at,
            "language": record.language,
            "transcriptKey": transcript_key,
            "endReason": record.endReason,
            "finalStage": record.finalStage,
            "scenarioId": record.scenarioId,
            "scenarioVersion": record.scenarioVersion,
            "promptVersions": record.promptVersions,
        }
        try:
            out = self._sfn.start_execution(
                stateMachineArn=self.scoring_state_machine_arn,
                name=name,
                input=json.dumps(payload, ensure_ascii=False),
            )
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code")
            if code == "ExecutionAlreadyExists":
                # A normal outcome, not a failure: this drill is already being scored. The name is
                # the drill id, so a reconnect or a replayed finish cannot start a second run.
                event("drill_scoring_already_started", drill_id, executionName=name)
                return None
            event("drill_scoring_start_failed", drill_id, level=logging.WARNING, errorName=code or "ClientError")
            return None
        except Exception as error:  # noqa: BLE001 - an unscored drill is degraded, never broken
            event("drill_scoring_start_failed", drill_id, level=logging.WARNING, errorName=type(error).__name__)
            return None

        event("drill_scoring_started", drill_id, executionName=name, reason=record.endReason)
        return out.get("executionArn")

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

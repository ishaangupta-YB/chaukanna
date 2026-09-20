"""Run the whole scoring pipeline locally against a fixture or a real transcript.

    uv run python -m scoring_service.cli --transcript ../../fixtures/transcripts/compliant.json

It calls the same functions the Lambdas call, so what it prints is what the pipeline does. A
fixture run defaults to `--dry-run`: nothing is written to S3 or DynamoDB.

`--skip-redaction` refuses to run without `--dry-run`. That is the whole point of the flag's
existence: skipping the guardrail is fine while you are looking at a synthetic fixture on your own
laptop, and is never fine when something durable is about to be written from the result.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import aws, config, stub_judge
from . import debrief as debrief_mod
from . import judge as judge_mod
from . import redact as redact_mod
from . import score as score_mod
from .log import configure_logging
from .transcript import Transcript, from_fixture, from_record


class CliError(Exception):
    """A refusal or a misuse. Printed, not traced."""


def load_input(path: Path, *, language: str | None) -> Transcript:
    raw = json.loads(path.read_text(encoding="utf-8"))
    transcript = from_fixture(raw) if "steps" in raw else from_record(raw)
    if language and language != transcript.language:
        transcript = Transcript(
            drillId=transcript.drillId,
            language=language,
            scenarioId=transcript.scenarioId,
            scenarioVersion=transcript.scenarioVersion,
            endReason=transcript.endReason,
            finalStage=transcript.finalStage,
            durationSeconds=transcript.durationSeconds,
            lines=transcript.lines,
            redFlags=transcript.redFlags,
        )
    return transcript


def have_credentials() -> bool:
    try:
        import boto3

        return boto3.Session().get_credentials() is not None
    except Exception:  # noqa: BLE001 - no credentials is the answer, whatever the reason
        return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m scoring_service.cli", description=__doc__)
    parser.add_argument("--transcript", required=True, type=Path, help="a fixture script or a drill transcript")
    parser.add_argument("--language", choices=("hi-IN", "en-IN"), help="override the transcript's language")
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="do not write to S3 or DynamoDB (default: on)",
    )
    parser.add_argument(
        "--skip-redaction",
        action="store_true",
        help="skip the guardrail. Only allowed with --dry-run: nothing durable is ever written from unredacted text",
    )
    parser.add_argument("--stub-judge", action="store_true", help="derive the judgement from the fixture")
    parser.add_argument("--polly", action="store_true", help="synthesise the debrief audio even in a dry run")
    parser.add_argument("--json", action="store_true", help="print the accumulated execution object")
    return parser


def run(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    configure_logging()

    if args.skip_redaction and not args.dry_run:
        raise CliError("--skip-redaction requires --dry-run: nothing durable is written from unredacted text")

    transcript = load_input(args.transcript, language=args.language)
    offline = args.stub_judge or not have_credentials()
    body: dict[str, Any] = {
        "drillId": transcript.drillId,
        "language": transcript.language,
        "endReason": transcript.endReason,
        "finalStage": transcript.finalStage,
    }

    # 1. redact ------------------------------------------------------------------------------
    if args.skip_redaction:
        body["redaction"] = {
            "redactedKey": None,
            "lines": len(transcript.lines),
            "maskedLines": 0,
            "guardrailAction": "SKIPPED",
        }
    else:
        result = redact_mod.redact_transcript(
            transcript,
            bedrock=aws.bedrock(),
            guardrail_id=config.guardrail_id(),
            guardrail_version=config.guardrail_version(),
        )
        transcript = result.transcript
        key = None
        if not args.dry_run:
            key = redact_mod.write_redacted(aws.s3(), config.artifacts_bucket(), transcript)
        body["redaction"] = result.patch(key or "")

    # 2. judge -------------------------------------------------------------------------------
    if offline:
        judgement = stub_judge.judgement_for(transcript)
    else:
        judgement = judge_mod.run(transcript, bedrock=aws.bedrock(), model_id=config.judge_model_id())
    body["judgement"] = judgement

    # 3. score -------------------------------------------------------------------------------
    scored = score_mod.run(judgement, drill_id=transcript.drillId)
    body["score"] = scored

    # 4. debrief -----------------------------------------------------------------------------
    if offline:
        text = "(stub debrief: no credentials, the model was not called)"
        debrief_patch = debrief_mod.patch(
            text,
            audio_key_value=None,
            language=transcript.language,
            voice_id=config.debrief_voice_id(),
            model_id="stub",
        )
    else:
        model_id = config.debrief_model_id()
        voice_id = config.debrief_voice_id()
        text = debrief_mod.write_text(transcript, judgement, scored, bedrock=aws.bedrock(), model_id=model_id)
        audio_key = None
        if args.polly or not args.dry_run:
            audio = debrief_mod.synthesize(aws.polly(), text, language=transcript.language, voice_id=voice_id)
            print(f"polly: {len(audio)} bytes of mp3", file=sys.stderr)
            if not args.dry_run:
                audio_key = debrief_mod.write_audio(aws.s3(), config.artifacts_bucket(), transcript.drillId, audio)
        debrief_patch = debrief_mod.patch(
            text, audio_key_value=audio_key, language=transcript.language, voice_id=voice_id, model_id=model_id
        )
    body["debrief"] = debrief_patch

    # 5. finish ------------------------------------------------------------------------------
    if not args.dry_run:
        from .finish import run as finish_run

        body.update(finish_run(body, ddb=aws.ddb(), table=config.table_name()))

    fired = sorted(fid for fid, entry in judgement["flags"].items() if entry["fired"])
    credited = sorted(cid for cid, entry in judgement["credits"].items() if entry["fired"])
    print(
        f"drill          {transcript.drillId} ({transcript.language}, ended {transcript.endReason} "
        f"at {transcript.finalStage})"
    )
    print(f"band           {scored['band']}")
    print(f"score          {scored['score']}")
    print(f"flags          {', '.join(fired) or 'none'}")
    print(f"credits        {', '.join(credited) or 'none'}")
    print(f"turning point  {judgement['turningPoint'] or '(none)'}")
    print(
        f"debrief        ({debrief_patch['words']} words, {debrief_patch['languageCode']}, "
        f"{debrief_patch['voiceId']})\n{debrief_patch['text']}"
    )
    if args.json:
        print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    try:
        return run(sys.argv[1:])
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

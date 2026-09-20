"""Record what the real judge model returns for every transcript fixture.

    AWS_PROFILE=chaukanna uv run python scripts/record_judge.py            # all ten
    AWS_PROFILE=chaukanna uv run python scripts/record_judge.py compliant  # one

`fixtures/judge/*.json` is the corpus `tests/test_recorded_judge.py` replays offline, so the whole
rubric can be re-checked in milliseconds without a model call. That only stays honest if the
corpus is regenerated whenever the judge prompt changes — which is why this is a script in the
repository rather than something somebody ran once by hand.

Bump `score.judge.vN` in docs/AGENT_PROMPTS.md, run `scripts/sync_prompts.py`, then run this.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from scoring_service import aws, config, judge, score
from scoring_service.log import configure_logging
from scoring_service.transcript import from_fixture

TRANSCRIPTS = SERVICE_ROOT.parents[1] / "fixtures" / "transcripts"
RECORDED = SERVICE_ROOT.parents[1] / "fixtures" / "judge"


def record(name: str, *, bedrock: object, model_id: str) -> dict[str, object]:
    fixture = json.loads((TRANSCRIPTS / f"{name}.json").read_text(encoding="utf-8"))
    transcript = from_fixture(fixture)
    judgement = judge.run(transcript, bedrock=bedrock, model_id=model_id)
    observed = score.run(judgement, drill_id=transcript.drillId)
    return {
        "fixture": name,
        "modelId": judgement["modelId"],
        "promptVersion": judgement["promptVersion"],
        "attempts": judgement["attempts"],
        "flags": judgement["flags"],
        "credits": judgement["credits"],
        "turningPoint": judgement["turningPoint"],
        "observed": observed,
    }


def main(argv: list[str]) -> int:
    configure_logging()
    names = argv or sorted(path.stem for path in TRANSCRIPTS.glob("*.json"))
    model_id = config.judge_model_id()
    bedrock = aws.bedrock()
    RECORDED.mkdir(parents=True, exist_ok=True)

    for name in names:
        body = record(name, bedrock=bedrock, model_id=model_id)
        (RECORDED / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        observed = body["observed"]
        fired = sorted(k for k, v in body["flags"].items() if v["fired"])  # type: ignore[union-attr]
        credited = sorted(k for k, v in body["credits"].items() if v["fired"])  # type: ignore[union-attr]
        print(
            f"{name:18} {observed['band']:8} {observed['score']:3}  "  # type: ignore[index]
            f"flags={','.join(fired) or '-'}  credits={','.join(credited) or '-'}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

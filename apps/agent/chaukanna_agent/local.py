"""Terminal drill: your microphone, your speakers, the real Nova 2 Sonic session.

    cd apps/agent
    AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1 uv run python -m chaukanna_agent.local --language hi-IN

Use headphones, or pass --half-duplex on laptop speakers so the caller does not hear itself.
Ctrl+C hangs up. The transcript and event log are written to runs/<drillId>.json (not committed);
pass --out to save a run elsewhere, for example as a recorded fixture.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
import uuid
from pathlib import Path

from .audio import LocalMicrophone, LocalSpeaker, load_break_audio
from .config import AgentSettings
from .drill import DrillRunner, build_agent
from .log import configure_logging
from .prompts import PROMPT_VERSIONS, break_character_text, render_kickoff
from .safety import StopPhrases
from .scenario import load_scenario
from .session import DrillRecord, DrillSession

RUNS_DIR = Path(__file__).resolve().parents[1] / "runs"
console = logging.getLogger("chaukanna_agent.console")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="chaukanna_agent.local", description=__doc__.split("\n\n")[0])
    parser.add_argument("--language", choices=["hi-IN", "en-IN"], default="hi-IN")
    parser.add_argument("--scenario", default="digital_arrest_v1")
    parser.add_argument("--max-seconds", type=int, help="override SESSION_MAX_SECONDS for this run")
    parser.add_argument("--half-duplex", action="store_true", help="mute the mic while the caller speaks")
    parser.add_argument("--out", type=Path, help="where to write the run JSON")
    parser.add_argument(
        "--allow-missing-break-audio",
        action="store_true",
        help="run without the pre-rendered break character audio (the drill still ends, silently)",
    )
    return parser.parse_args(argv)


def configure_console() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    console.handlers[:] = [handler]
    console.setLevel(logging.INFO)
    console.propagate = False


async def run(args: argparse.Namespace) -> DrillRecord:
    settings = AgentSettings.from_env()
    if args.max_seconds:
        settings = AgentSettings.model_validate({**settings.model_dump(), "session_max_seconds": args.max_seconds})
    scenario = load_scenario(args.scenario)
    language = args.language

    try:
        break_audio = load_break_audio(language, break_character_text(language))
    except (FileNotFoundError, RuntimeError) as error:
        if not args.allow_missing_break_audio:
            raise SystemExit(f"break character audio unavailable: {error}") from error
        break_audio = None

    session = DrillSession(
        drill_id=f"local-{uuid.uuid4().hex[:12]}",
        scenario_id=scenario.id,
        scenario_version=scenario.version,
        language=language,
        voice=scenario.voices[language],
        prompt_versions=PROMPT_VERSIONS,
        max_seconds=settings.session_max_seconds,
    )
    if break_audio is None:
        session.log("break_character_audio_missing", level=logging.WARNING)
    agent = build_agent(settings, scenario, language, session)
    speaker = LocalSpeaker()
    microphone = LocalMicrophone(mute_while=speaker if args.half_duplex else None)
    out_path: Path = args.out or RUNS_DIR / f"{session.drill_id}.json"

    def persist(record: DrillRecord) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(record.model_dump_json(indent=2), encoding="utf-8")

    def caption(role: str, text: str) -> None:
        console.info("%s: %s", "caller" if role == "caller" else "you", text)

    runner = DrillRunner(
        session=session,
        agent=agent,
        source=microphone,
        sink=speaker,
        stop_phrases=StopPhrases(settings.safe_word, settings.safe_word_spellings),
        break_audio=break_audio,
        kickoff_text=render_kickoff(language),
        persist=persist,
        on_caption=caption,
    )
    asyncio.get_running_loop().add_signal_handler(signal.SIGINT, runner.hangup)
    console.info("Practice call starting. Safe word: %s. Ctrl+C hangs up.", settings.safe_word)
    record = await runner.run()
    console.info(
        "Call ended: %s at %s after %.0fs. Saved %s",
        record.endReason,
        record.finalStage,
        record.durationSeconds,
        out_path,
    )
    return record


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    configure_console()
    record = asyncio.run(run(parse_args(argv)))
    return 0 if record.endReason != "error" else 1


if __name__ == "__main__":
    sys.exit(main())

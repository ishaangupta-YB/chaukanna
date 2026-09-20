"""Copy prompt blocks from docs/AGENT_PROMPTS.md into chaukanna_agent/prompts/, verbatim.

    uv run python scripts/sync_prompts.py

Run it after every prompt change, bump the prompt version in the doc when the text changes, and
rerun the fixture suite before merging.
"""

import logging
import sys
from pathlib import Path

from chaukanna_agent.prompt_sync import render_files

AGENT_DIR = Path(__file__).resolve().parents[1]
DOC = AGENT_DIR.parents[1] / "docs" / "AGENT_PROMPTS.md"
OUT = AGENT_DIR / "chaukanna_agent" / "prompts"
log = logging.getLogger("sync_prompts")


def main() -> int:
    files = render_files(DOC.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    for name, content in files.items():
        (OUT / name).write_text(content, encoding="utf-8")
        log.info("wrote %s", name)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())

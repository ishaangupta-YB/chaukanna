"""Extracts the scoring prompt blocks from docs/AGENT_PROMPTS.md, the single source of truth.

Mirrors `apps/agent/chaukanna_agent/prompt_sync.py`. `docs/` is not part of the Lambda asset, so
the blocks are copied verbatim into `scoring_service/prompts/` by `scripts/sync_prompts.py` and
`tests/test_prompts.py` fails when the copies drift from the doc.
"""

from __future__ import annotations

import re
from pathlib import Path

_SECTION = re.compile(r"^## [0-9a-z]+\. `(?P<id>[a-z_.0-9]+)`", re.MULTILINE)
_FENCE = re.compile(r"^```[a-z]*\n(?P<body>.*?)^```", re.MULTILINE | re.DOTALL)

JUDGE = "score.judge.v2"
DEBRIEF = "debrief.writer.v1"

#: prompt id -> the file written into scoring_service/prompts/
SYNCED_PROMPTS = {JUDGE: f"{JUDGE}.txt", DEBRIEF: f"{DEBRIEF}.txt"}


def docs_path() -> Path:
    """`services/scoring/scoring_service/prompt_sync.py` -> `docs/AGENT_PROMPTS.md`."""
    return Path(__file__).resolve().parents[3] / "docs" / "AGENT_PROMPTS.md"


def prompts_dir() -> Path:
    return Path(__file__).resolve().parent / "prompts"


def extract_blocks(markdown: str) -> dict[str, str]:
    """First fenced block after each `## N. \\`id\\`` heading, keyed by prompt id."""
    blocks: dict[str, str] = {}
    sections = list(_SECTION.finditer(markdown))
    for index, section in enumerate(sections):
        end = sections[index + 1].start() if index + 1 < len(sections) else len(markdown)
        fence = _FENCE.search(markdown, section.end(), end)
        if fence:
            blocks[section.group("id")] = fence.group("body").rstrip("\n") + "\n"
    return blocks


def render_files(markdown: str) -> dict[str, str]:
    """File name -> exact content for every synced prompt."""
    blocks = extract_blocks(markdown)
    missing = [prompt_id for prompt_id in SYNCED_PROMPTS if prompt_id not in blocks]
    if missing:
        raise ValueError(f"prompts missing from AGENT_PROMPTS.md: {missing}")
    return {file_name: blocks[prompt_id] for prompt_id, file_name in SYNCED_PROMPTS.items()}

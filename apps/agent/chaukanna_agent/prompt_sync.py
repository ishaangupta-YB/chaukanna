"""Extracts prompt blocks from docs/AGENT_PROMPTS.md, the single source of truth for prompts.

docs/ is not published with the repository, and the agent image cannot read it, so the blocks are
copied verbatim into chaukanna_agent/prompts/ by scripts/sync_prompts.py. tests/test_prompts.py
fails when the copies drift from the doc.
"""

from __future__ import annotations

import re

_SECTION = re.compile(r"^## [0-9a-z]+\. `(?P<id>[a-z_.0-9]+)`", re.MULTILINE)
_FENCE = re.compile(r"^```[a-z]*\n(?P<body>.*?)^```", re.MULTILINE | re.DOTALL)

# prompt id -> file names written into chaukanna_agent/prompts/
SYNCED_PROMPTS = {
    "drill.persona.v1": ["drill.persona.v1.txt"],
    "drill.kickoff.v1": ["drill.kickoff.v1.txt"],
    "render.verbatim_reader.v1": ["render.verbatim_reader.v1.txt"],
    "drill.break_character.v1": ["drill.break_character.v1.hi-IN.txt", "drill.break_character.v1.en-IN.txt"],
}


def extract_blocks(markdown: str) -> dict[str, str]:
    """First fenced block after each `## N. \\`id\\`` heading, keyed by prompt id."""
    blocks: dict[str, str] = {}
    sections = list(_SECTION.finditer(markdown))
    for i, section in enumerate(sections):
        end = sections[i + 1].start() if i + 1 < len(sections) else len(markdown)
        fence = _FENCE.search(markdown, section.end(), end)
        if fence:
            blocks[section.group("id")] = fence.group("body").rstrip("\n") + "\n"
    return blocks


def split_break_character(block: str) -> dict[str, str]:
    """The break character block holds a quoted Hindi and a quoted English paragraph."""
    out: dict[str, str] = {}
    for label, locale in (("Hindi", "hi-IN"), ("English", "en-IN")):
        match = re.search(rf"^{label}:\n(?P<body>.*?)(?:\n\n|\Z)", block, re.MULTILINE | re.DOTALL)
        if not match:
            raise ValueError(f"break character block has no {label} paragraph")
        text = " ".join(line.strip() for line in match.group("body").splitlines()).strip()
        out[locale] = text.strip('"').strip() + "\n"
    return out


def render_files(markdown: str) -> dict[str, str]:
    """File name -> exact content for every synced prompt."""
    blocks = extract_blocks(markdown)
    missing = [pid for pid in SYNCED_PROMPTS if pid not in blocks]
    if missing:
        raise ValueError(f"prompts missing from AGENT_PROMPTS.md: {missing}")
    breaks = split_break_character(blocks["drill.break_character.v1"])
    return {
        "drill.persona.v1.txt": blocks["drill.persona.v1"],
        "drill.kickoff.v1.txt": blocks["drill.kickoff.v1"],
        "render.verbatim_reader.v1.txt": blocks["render.verbatim_reader.v1"],
        "drill.break_character.v1.hi-IN.txt": breaks["hi-IN"],
        "drill.break_character.v1.en-IN.txt": breaks["en-IN"],
    }

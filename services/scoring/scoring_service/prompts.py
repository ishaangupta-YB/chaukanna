"""Prompt loading and templating. Prompts are files synced from docs/AGENT_PROMPTS.md.

Never inline a second copy of a prompt here. The version ids below are recorded on every score
row so a score can be traced to the exact prompt that produced it.
"""

from __future__ import annotations

import re
from importlib import resources

from .prompt_sync import DEBRIEF, JUDGE

JUDGE_PROMPT = JUDGE
DEBRIEF_PROMPT = DEBRIEF

LANGUAGE_LABELS = {"hi-IN": "hi-IN (Hindi)", "en-IN": "en-IN (Indian English)"}
_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


def load_prompt(file_name: str) -> str:
    return resources.files("scoring_service").joinpath("prompts", file_name).read_text(encoding="utf-8")


def render(template: str, **values: str) -> str:
    def substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise KeyError(f"prompt placeholder {{{{{key}}}}} has no value")
        return values[key]

    return _PLACEHOLDER.sub(substitute, template)


def language_label(language: str) -> str:
    return LANGUAGE_LABELS.get(language, language)


def judge_system() -> str:
    return load_prompt(f"{JUDGE_PROMPT}.txt").strip()


def debrief_system(language: str) -> str:
    return render(load_prompt(f"{DEBRIEF_PROMPT}.txt"), language=language_label(language)).strip()

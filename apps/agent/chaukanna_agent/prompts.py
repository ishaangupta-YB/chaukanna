"""Prompt loading and templating. Prompts are files synced from docs/AGENT_PROMPTS.md; never inline one."""

from __future__ import annotations

import re
from importlib import resources

from .scenario import Language, Scenario

PERSONA = "drill.persona.v1"
KICKOFF = "drill.kickoff.v1"
BREAK_CHARACTER = "drill.break_character.v1"

# Recorded on every drill so a score can be traced to the exact prompts that produced it.
PROMPT_VERSIONS = {"persona": PERSONA, "kickoff": KICKOFF, "break_character": BREAK_CHARACTER}

LANGUAGE_LABELS: dict[Language, str] = {"hi-IN": "hi-IN (Hindi)", "en-IN": "en-IN (Indian English)"}
_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


def load_prompt(file_name: str) -> str:
    return resources.files("chaukanna_agent").joinpath("prompts", file_name).read_text(encoding="utf-8")


def render(template: str, **values: str) -> str:
    def sub(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise KeyError(f"prompt placeholder {{{{{key}}}}} has no value")
        return values[key]

    return _PLACEHOLDER.sub(sub, template)


def render_persona(language: Language, scenario: Scenario, safe_word: str) -> str:
    return render(
        load_prompt(f"{PERSONA}.txt"),
        language=LANGUAGE_LABELS[language],
        safe_word=safe_word,
        fake_account_label=scenario.fake_account_label,
    )


def render_kickoff(language: Language) -> str:
    return render(load_prompt(f"{KICKOFF}.txt"), language=LANGUAGE_LABELS[language]).strip()


def break_character_text(language: Language) -> str:
    return load_prompt(f"{BREAK_CHARACTER}.{language}.txt").strip()

"""Drill scenarios. Only human-promoted scenarios ship; the MVP has one."""

from __future__ import annotations

from importlib import resources
from typing import Literal

from pydantic import BaseModel, Field

Language = Literal["hi-IN", "en-IN"]


class Scenario(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    version: int = Field(ge=1)
    title: str
    # The only account the caller may ever mention. Fictional, no numbers (drill.persona.v1 limit 1).
    fake_account_label: str = Field(pattern=r"^[^0-9]+$")
    # Nova 2 Sonic voice per language. The persona speaks in masculine Hindi verb forms.
    voices: dict[Language, str]


def load_scenario(scenario_id: str) -> Scenario:
    if not scenario_id.replace("_", "").isalnum():
        raise ValueError(f"invalid scenario id {scenario_id!r}")
    raw = resources.files("chaukanna_agent").joinpath("scenarios", f"{scenario_id}.json").read_text(encoding="utf-8")
    return Scenario.model_validate_json(raw)

"""Agent settings from the environment. Regions are never hardcoded: VOICE_REGION is required."""

from __future__ import annotations

import os

from pydantic import BaseModel, Field


class AgentSettings(BaseModel):
    voice_region: str = Field(min_length=1)
    sonic_model_id: str = "amazon.nova-2-sonic-v1:0"
    # Hard cap on a drill, enforced by a timer, never by the prompt.
    session_max_seconds: int = Field(default=360, ge=10, le=900)
    safe_word: str = Field(default="ROKO", min_length=2)
    # Extra spellings speech recognition may produce for a custom safe word, comma separated.
    safe_word_spellings: list[str] = Field(default_factory=list)
    # Nova caps a connection at about 8 minutes; the SDK reconnects proactively before that.
    # Lower it locally to exercise the reconnect path deliberately.
    model_restart_after_seconds: int = Field(default=420, ge=20, le=470)

    @classmethod
    def from_env(cls) -> AgentSettings:
        env = os.environ
        region = env.get("VOICE_REGION")
        if not region:
            raise RuntimeError("VOICE_REGION is required (the voice path runs where Nova 2 Sonic is offered)")
        values: dict[str, object] = {"voice_region": region}
        for key, name in (
            ("sonic_model_id", "SONIC_MODEL_ID"),
            ("session_max_seconds", "SESSION_MAX_SECONDS"),
            ("safe_word", "SAFE_WORD"),
            ("model_restart_after_seconds", "MODEL_RESTART_AFTER_SECONDS"),
        ):
            if env.get(name):
                values[key] = env[name]
        if env.get("SAFE_WORD_SPELLINGS"):
            values["safe_word_spellings"] = [s for s in env["SAFE_WORD_SPELLINGS"].split(",") if s.strip()]
        return cls.model_validate(values)

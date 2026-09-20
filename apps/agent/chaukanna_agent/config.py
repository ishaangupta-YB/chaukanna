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


class ServerSettings(BaseModel):
    """What the WebSocket server needs on top of the agent itself.

    `data_region` is deliberately not `AWS_REGION`. Inside AgentCore that variable is the region
    the container happens to run in, which is the voice region, not the region the table and the
    bucket live in. Reading it would point every write at the wrong account resources and fail
    only at runtime.
    """

    agent: AgentSettings
    data_region: str = Field(min_length=1)
    table_name: str = Field(min_length=1)
    artifacts_bucket: str = Field(min_length=1)
    # Optional on purpose. A local drill and a dev container have no scoring pipeline wired up and
    # must still run the whole call; without it the drill simply ends unscored, which is the same
    # degraded outcome as a failed start. It lives in the data region, like the table and bucket.
    scoring_state_machine_arn: str | None = None
    scenario_id: str = "digital_arrest_v1"
    # Phase 2's decision, carried forward: without the pre-rendered asset the drill still ends on
    # time, it just ends silently. See handoffs/phase2_agent_handoff.md.
    allow_missing_break_audio: bool = True

    @classmethod
    def from_env(cls) -> ServerSettings:
        env = os.environ
        missing = [name for name in ("DATA_REGION", "TABLE_NAME", "ARTIFACTS_BUCKET") if not env.get(name)]
        if missing:
            raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")
        values: dict[str, object] = {
            "agent": AgentSettings.from_env(),
            "data_region": env["DATA_REGION"],
            "table_name": env["TABLE_NAME"],
            "artifacts_bucket": env["ARTIFACTS_BUCKET"],
        }
        if env.get("SCORING_STATE_MACHINE_ARN"):
            values["scoring_state_machine_arn"] = env["SCORING_STATE_MACHINE_ARN"]
        if env.get("SCENARIO_ID"):
            values["scenario_id"] = env["SCENARIO_ID"]
        if env.get("ALLOW_MISSING_BREAK_AUDIO"):
            values["allow_missing_break_audio"] = env["ALLOW_MISSING_BREAK_AUDIO"].lower() not in ("0", "false", "no")
        return cls.model_validate(values)

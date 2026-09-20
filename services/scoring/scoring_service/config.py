"""Environment reading, in one place, with failure messages that name the variable.

The region is read from `DATA_REGION` and never inferred from `AWS_REGION`. These Lambdas run in
`ap-south-1` today, but the voice path runs in `ap-northeast-1`, and a pipeline that silently
followed whichever region its runtime happened to be in would read a table that does not exist
there and say `ResourceNotFoundException` instead of "you pointed me at the wrong region".
"""

from __future__ import annotations

import os

DATA_REGION_DEFAULT = "ap-south-1"

# Verified live against account 810225483947: the bare model id fails with "Invocation ... with
# on-demand throughput isn't supported". An inference profile is required, and the `global.`
# profile is ACTIVE in ap-south-1.
JUDGE_MODEL_ID_DEFAULT = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

# There is no `hi-IN` Polly voice: `describe-voices --language-code hi-IN` returns []. Kajal is the
# only Hindi capable neural voice, and it carries hi-IN in AdditionalLanguageCodes.
DEBRIEF_VOICE_ID_DEFAULT = "Kajal"

GUARDRAIL_VERSION_DEFAULT = "DRAFT"


class ConfigError(Exception):
    """A required environment variable is missing. The message names it."""


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"{name} is not set; the scoring pipeline cannot run without it")
    return value


def optional(name: str, default: str) -> str:
    return os.environ.get(name) or default


def data_region() -> str:
    return optional("DATA_REGION", DATA_REGION_DEFAULT)


def table_name() -> str:
    return required("TABLE_NAME")


def artifacts_bucket() -> str:
    return required("ARTIFACTS_BUCKET")


def judge_model_id() -> str:
    return optional("JUDGE_MODEL_ID", JUDGE_MODEL_ID_DEFAULT)


def debrief_model_id() -> str:
    """The debrief writer shares the judge's model unless it is pinned separately."""
    return optional("DEBRIEF_MODEL_ID", judge_model_id())


def debrief_voice_id() -> str:
    return optional("DEBRIEF_VOICE_ID", DEBRIEF_VOICE_ID_DEFAULT)


def guardrail_id() -> str:
    return required("GUARDRAIL_ID")


def guardrail_version() -> str:
    return optional("GUARDRAIL_VERSION", GUARDRAIL_VERSION_DEFAULT)

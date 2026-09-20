"""One structured JSON line per meaningful event, always carrying drillId.

Ids, counts and labels only. Never a transcript line, never an evidence quote, never a debrief
sentence: those are learner-only text (PRD F7 AC2) and CloudWatch is not the learner.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

_events = logging.getLogger("chaukanna_scoring.events")


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(name: str, drill_id: str, level: int = logging.INFO, **fields: object) -> None:
    line = {"ts": utc_now_iso(), "event": name, "drillId": drill_id, **fields}
    _events.log(level, json.dumps(line, ensure_ascii=False, default=str))


def configure_logging(level: int = logging.INFO) -> None:
    """JSON event lines to stderr. Lambda's root handler would prefix them, so this logger owns
    its own handler and does not propagate."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _events.handlers[:] = [handler]
    _events.setLevel(level)
    _events.propagate = False

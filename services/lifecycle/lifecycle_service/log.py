"""One structured JSON line per meaningful event, always carrying drillId. Ids and labels only:
never an email address, a transcript, or anything else personal."""

from __future__ import annotations

import json
import logging
import sys

from .clock import utc_now_iso

_events = logging.getLogger("chaukanna_lifecycle.events")


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

"""One structured JSON line per meaningful event, always carrying drillId. Ids and labels only:
never transcript text, quotes, or audio."""

from __future__ import annotations

import json
import logging
import sys

from .clock import utc_now_iso

_events = logging.getLogger("chaukanna_agent.events")


def event(name: str, drill_id: str, level: int = logging.INFO, **fields: object) -> None:
    line = {"ts": utc_now_iso(), "event": name, "drillId": drill_id, **fields}
    _events.log(level, json.dumps(line, ensure_ascii=False, default=str))


def configure_logging(level: int = logging.INFO) -> None:
    """JSON event lines to stderr. The SDK logs transcript previews at DEBUG, so it stays at WARNING."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _events.handlers[:] = [handler]
    _events.setLevel(level)
    _events.propagate = False
    logging.getLogger("strands").setLevel(logging.WARNING)

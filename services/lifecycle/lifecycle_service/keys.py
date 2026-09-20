"""Key formats, spelled out once.

These mirror `apps/web/src/lib/db/client.ts` and `apps/agent/chaukanna_agent/store.py`. If a
format changes it changes in all three files or drills go missing.
"""

from __future__ import annotations

DRILL_PREFIX = "DRILL#"
CONSENT_PREFIX = "CONSENT#"
EVENT_PREFIX = "EVT#"


def member_pk(member_id: str) -> str:
    return f"MEMBER#{member_id}"


def household_keys(household_id: str) -> dict[str, str]:
    return {"pk": f"HH#{household_id}", "sk": "META"}


def member_keys(household_id: str, member_id: str) -> dict[str, str]:
    return {"pk": f"HH#{household_id}", "sk": f"MEMBER#{member_id}"}


def window_keys(member_id: str) -> dict[str, str]:
    return {"pk": member_pk(member_id), "sk": "WINDOW#current"}


def lifecycle_event_keys(drill_id: str, at: str, name: str) -> dict[str, str]:
    """A lifecycle event row, new in Phase 4.

    The agent writes its own in-call events under the same partition as `EVT#<6-digit seq>`
    (`store.py: event_keys`). The two never collide: a zero padded integer is six digits and an
    ISO 8601 timestamp starts `2026-`, so `EVT#000004` and `EVT#2026-09-20T...#drill.due` cannot
    be the same string, and they sort into two obvious groups.
    """
    return {"pk": f"DRILL#{drill_id}", "sk": f"{EVENT_PREFIX}{at}#{name}"}


def state_gsi1pk(state: str) -> str:
    return f"STATE#{state}"

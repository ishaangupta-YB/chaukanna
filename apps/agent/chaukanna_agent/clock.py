"""One timestamp format, shared with the web app.

`datetime.now(UTC).isoformat()` produces `2026-09-19T23:35:37.176154+00:00`. JavaScript's
`Date.prototype.toISOString`, which is what `apps/web` writes and what its zod models validate,
produces `2026-09-19T23:35:37.176Z`. Both are valid ISO 8601 and they are not interchangeable:
the offset form fails `z.iso.datetime()`, so a drill this agent finished could be written
successfully and then be unreadable by the app that has to show it.

So every timestamp that lands in DynamoDB, in S3 or in a log line goes through here.
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso() -> str:
    """`YYYY-MM-DDTHH:MM:SS.mmmZ`, byte for byte what `new Date().toISOString()` gives."""
    return to_iso(datetime.now(UTC))


def to_iso(moment: datetime) -> str:
    return f"{moment.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"

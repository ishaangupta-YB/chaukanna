"""Video provider interfaces for future deferred video clips."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ClipRequest:
    flag_id: str
    language: str
    prompt: str


@dataclass
class ClipResult:
    job_id: str
    status: str
    s3_uri: Optional[str] = None


class VideoProvider:
    """Abstract interface for video generation providers (Phase 8 deferred)."""

    def submit(self, req: ClipRequest) -> str:
        raise NotImplementedError("VideoProvider is deferred to Phase 8.")

    def poll(self, job_id: str) -> Optional[ClipResult]:
        raise NotImplementedError("VideoProvider is deferred to Phase 8.")

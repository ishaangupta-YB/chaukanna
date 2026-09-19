"""Smoke test for scoring service."""

import scoring_service


def test_scoring_service_metadata():
    """Verify package import and version metadata."""
    assert scoring_service.__version__ == "0.1.0"

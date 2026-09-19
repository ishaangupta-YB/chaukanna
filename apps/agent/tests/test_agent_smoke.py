"""Smoke test for agent package."""

import chaukanna_agent


def test_agent_package_metadata():
    """Verify the package can be imported and has version metadata."""
    assert chaukanna_agent.__version__ == "0.1.0"

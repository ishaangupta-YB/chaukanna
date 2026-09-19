"""Shared test paths. Fixtures live at the repository root so the scoring service can use them too."""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES

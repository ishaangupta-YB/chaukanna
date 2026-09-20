"""The rubric in code must equal the rubric in the PRD.

This parses the JSON block out of `docs/PRD.md` section 9 rather than restating the numbers, so a
weight can never be changed in one place and not the other. If this test fails, one of the two is
wrong and the PRD wins.
"""

from __future__ import annotations

import json
import re

import pytest
from conftest import REPO_ROOT

from scoring_service.rubric import BANDS, CREDIT_WEIGHTS, DEFAULT_RUBRIC, FLAG_WEIGHTS, UnknownBand

_SECTION = re.compile(r"^## 9\. Scoring rubric\s*\n+```json\n(?P<body>.*?)^```", re.MULTILINE | re.DOTALL)


def prd_rubric() -> dict:
    markdown = (REPO_ROOT / "docs" / "PRD.md").read_text(encoding="utf-8")
    match = _SECTION.search(markdown)
    assert match, "docs/PRD.md section 9 no longer contains a fenced json rubric"
    return json.loads(match.group("body"))


def test_flag_weights_match_the_prd() -> None:
    expected = {entry["id"]: entry["weight"] for entry in prd_rubric()["flags"]}
    assert FLAG_WEIGHTS == expected


def test_credit_weights_match_the_prd() -> None:
    expected = {entry["id"]: entry["weight"] for entry in prd_rubric()["credits"]}
    assert CREDIT_WEIGHTS == expected


def test_bands_match_the_prd() -> None:
    expected = {name: tuple(bounds) for name, bounds in prd_rubric()["bands"].items()}
    assert BANDS == expected


def test_bands_cover_every_reachable_score() -> None:
    assert {DEFAULT_RUBRIC.band(score) for score in range(101)} == set(BANDS)


def test_band_outside_the_range_raises() -> None:
    with pytest.raises(UnknownBand):
        DEFAULT_RUBRIC.band(101)


def test_unknown_ids_have_no_weight() -> None:
    assert DEFAULT_RUBRIC.flag_weight("invented") is None
    assert DEFAULT_RUBRIC.credit_weight("invented") is None

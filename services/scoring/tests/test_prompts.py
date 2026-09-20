"""The committed prompt copies must match docs/AGENT_PROMPTS.md exactly.

`docs/` is not part of the Lambda asset, so the prompts are copied into `scoring_service/prompts/`
by `scripts/sync_prompts.py`. This is the test that makes the copy a copy rather than a fork.
"""

from __future__ import annotations

import pytest

from scoring_service.prompt_sync import SYNCED_PROMPTS, docs_path, extract_blocks, prompts_dir, render_files
from scoring_service.prompts import debrief_system, judge_system


def doc_markdown() -> str:
    return docs_path().read_text(encoding="utf-8")


@pytest.mark.parametrize("file_name", sorted(SYNCED_PROMPTS.values()))
def test_the_committed_copy_matches_the_doc(file_name: str) -> None:
    expected = render_files(doc_markdown())[file_name]
    actual = (prompts_dir() / file_name).read_text(encoding="utf-8")
    assert actual == expected, f"{file_name} has drifted; run scripts/sync_prompts.py"


def test_both_scoring_prompts_are_found_in_the_doc() -> None:
    blocks = extract_blocks(doc_markdown())
    assert set(SYNCED_PROMPTS) <= set(blocks)


def test_a_missing_prompt_is_an_error() -> None:
    with pytest.raises(ValueError, match="missing from AGENT_PROMPTS.md"):
        render_files("## 4. `nothing.here.v1`\n\n```\nbody\n```\n")


def test_the_judge_prompt_forbids_computing_a_score() -> None:
    system = judge_system()
    assert "Do not compute a score." in system
    assert "If you cannot quote the learner, it did not fire." in system


def test_the_debrief_prompt_renders_the_language_placeholder() -> None:
    system = debrief_system("hi-IN")
    assert "{{language}}" not in system
    assert "hi-IN (Hindi)" in system
    assert "120 words maximum" in system


def test_an_unknown_placeholder_is_an_error() -> None:
    from scoring_service.prompts import render

    with pytest.raises(KeyError):
        render("hello {{missing}}", language="hi-IN")

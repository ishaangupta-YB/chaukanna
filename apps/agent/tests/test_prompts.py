"""Prompts are loaded from files synced from docs/AGENT_PROMPTS.md, rendered completely, and never
drift from the doc."""

import pytest

from chaukanna_agent.audio import load_break_audio
from chaukanna_agent.prompt_sync import SYNCED_PROMPTS, render_files
from chaukanna_agent.prompts import break_character_text, load_prompt, render_kickoff, render_persona
from chaukanna_agent.scenario import load_scenario
from tests.conftest import REPO_ROOT

DOC = REPO_ROOT / "docs" / "AGENT_PROMPTS.md"


@pytest.mark.skipif(not DOC.exists(), reason="docs/ is not in this checkout")
def test_synced_prompts_match_the_doc() -> None:
    expected = render_files(DOC.read_text(encoding="utf-8"))
    for name, content in expected.items():
        assert load_prompt(name) == content, f"{name} drifted, run scripts/sync_prompts.py"


def test_every_synced_prompt_file_exists() -> None:
    for names in SYNCED_PROMPTS.values():
        for name in names:
            assert load_prompt(name).strip()


@pytest.mark.parametrize("language", ["hi-IN", "en-IN"])
def test_persona_renders_every_placeholder(language: str) -> None:
    scenario = load_scenario("digital_arrest_v1")
    persona = render_persona(language, scenario, "ROKO")
    assert "{{" not in persona and "}}" not in persona
    assert "ROKO" in persona and scenario.fake_account_label in persona and language in persona
    assert "{{" not in render_kickoff(language)


def test_scenario_account_label_has_no_digits() -> None:
    assert not any(ch.isdigit() for ch in load_scenario("digital_arrest_v1").fake_account_label)


@pytest.mark.parametrize("language", ["hi-IN", "en-IN"])
def test_break_character_audio_matches_the_script(language: str) -> None:
    try:
        audio = load_break_audio(language, break_character_text(language))
    except FileNotFoundError:
        pytest.skip("break character audio not rendered yet, see scripts/render_break_character.py")
    assert len(audio.pcm) > 16_000 * 2  # at least a second of speech

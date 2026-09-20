"""The CLI's one hard rule, and that the documented command runs offline."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import FIXTURE_DIR

from scoring_service import cli

COMPLIANT = str(FIXTURE_DIR / "compliant.json")


def test_skip_redaction_refuses_without_dry_run() -> None:
    """Nothing durable is ever written from unredacted text, so the flag that skips the guardrail
    is only usable where nothing durable is written."""
    with pytest.raises(cli.CliError, match="requires --dry-run"):
        cli.run(["--transcript", COMPLIANT, "--no-dry-run", "--skip-redaction"])


def test_the_documented_command_runs_offline(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.run(["--transcript", COMPLIANT, "--dry-run", "--skip-redaction", "--stub-judge"]) == 0
    out = capsys.readouterr().out
    assert "band           at_risk" in out
    assert "turning point  " in out
    assert "debrief        " in out


def test_immediate_hangup_prints_safe(capsys: pytest.CaptureFixture[str]) -> None:
    path = str(FIXTURE_DIR / "immediate_hangup.json")
    cli.run(["--transcript", path, "--skip-redaction", "--stub-judge"])
    assert "band           safe" in capsys.readouterr().out


def test_dry_run_is_the_default(capsys: pytest.CaptureFixture[str]) -> None:
    """No --dry-run on the command line and it still writes nothing: the parser defaults it on,
    and --skip-redaction (which needs it) is therefore accepted."""
    assert cli.run(["--transcript", COMPLIANT, "--skip-redaction", "--stub-judge"]) == 0


def test_the_language_override_reaches_the_debrief(capsys: pytest.CaptureFixture[str]) -> None:
    cli.run(["--transcript", COMPLIANT, "--skip-redaction", "--stub-judge", "--language", "en-IN"])
    assert "en-IN" in capsys.readouterr().out


def test_a_real_transcript_dump_is_accepted(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import json

    from scoring_service.transcript import from_fixture

    dump = from_fixture(json.loads(Path(COMPLIANT).read_text(encoding="utf-8"))).to_dict()
    path = tmp_path / "transcript.json"
    path.write_text(json.dumps(dump, ensure_ascii=False), encoding="utf-8")
    assert cli.run(["--transcript", str(path), "--skip-redaction", "--stub-judge"]) == 0
    assert "band           at_risk" in capsys.readouterr().out


def test_main_turns_a_refusal_into_an_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["cli", "--transcript", COMPLIANT, "--no-dry-run", "--skip-redaction"])
    assert cli.main() == 2

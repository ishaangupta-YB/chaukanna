"""Copy the scoring prompt blocks out of docs/AGENT_PROMPTS.md into scoring_service/prompts/.

    uv run python scripts/sync_prompts.py            # write
    uv run python scripts/sync_prompts.py --check    # exit 1 if the copies have drifted

`tests/test_prompts.py` runs the same comparison, so a drift fails CI whether or not anyone
remembers to run this.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The service root, so this runs as `uv run python scripts/sync_prompts.py` without the package
# being installed. pytest gets the same path from `[tool.pytest.ini_options] pythonpath`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scoring_service.prompt_sync import docs_path, prompts_dir, render_files


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    files = render_files(docs_path().read_text(encoding="utf-8"))
    target = prompts_dir()
    target.mkdir(parents=True, exist_ok=True)

    drifted: list[str] = []
    for name, body in files.items():
        path = target / name
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == body:
            continue
        drifted.append(name)
        if not check_only:
            path.write_text(body, encoding="utf-8")

    if check_only and drifted:
        print(f"prompts out of sync with docs/AGENT_PROMPTS.md: {', '.join(drifted)}", file=sys.stderr)
        return 1
    print(f"{'would update' if check_only else 'updated'}: {', '.join(drifted) or 'nothing, already in sync'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

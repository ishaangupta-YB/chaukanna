"""Shared test paths, and the eight lines that let a test be `async def`.

Fixtures live at the repository root so the scoring service can use them too.
"""

import asyncio
import inspect
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: Any) -> bool | None:
    """Runs a coroutine test in its own event loop.

    Cheaper than a plugin: the transport is full of `async def`, and `asyncio.run` in the body of
    every test would bury what each one is actually asserting.
    """
    if not inspect.iscoroutinefunction(pyfuncitem.obj):
        return None
    arguments = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}
    asyncio.run(pyfuncitem.obj(**arguments))
    return True

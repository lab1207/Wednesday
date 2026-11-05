"""Interface-conformance test for the Wednesday Harbor agent skeleton.

Run with the Harbor venv python (it owns the harbor package):
  <uv-tools>/harbor/Scripts/python.exe factory/benchmark/harbor/wednesday_agent_test.py

Proves: the import path resolves, the class subclasses BaseAgent, name +
version + capabilities read correctly, setup() is a harmless no-op, and
run() fails LOUDLY (not silently) until executor routing lands.
"""

import asyncio
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harbor.agents.base import BaseAgent  # noqa: E402

from wednesday_agent import WednesdayAgent  # noqa: E402


async def _setup_noop() -> None:
    await WednesdayAgent.setup(object(), object())  # type: ignore[arg-type]


def _agent() -> WednesdayAgent:
    return WednesdayAgent(logs_dir=Path("."))


def main() -> None:
    assert issubclass(WednesdayAgent, BaseAgent), "must subclass Harbor BaseAgent"
    assert WednesdayAgent.name() == "wednesday"
    assert WednesdayAgent.options_model is not None, "harbor schema requires options_model"
    assert _agent().version().startswith("0.1.0")
    assert inspect.iscoroutinefunction(WednesdayAgent.run)
    assert inspect.iscoroutinefunction(WednesdayAgent.setup)

    asyncio.run(_setup_noop())

    try:
        asyncio.run(_agent().run("do the task", object(), object()))  # type: ignore[arg-type]
    except NotImplementedError as error:
        assert "executor routing" in str(error), "run() must name the queued slice"
    else:
        raise AssertionError("run() must fail loudly until executor routing lands")

    print("WEDNESDAY HARBOR AGENT TEST: PASS (interface conforms, run fails loud)")


if __name__ == "__main__":
    main()

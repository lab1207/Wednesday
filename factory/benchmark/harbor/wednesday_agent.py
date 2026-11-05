"""
Wednesday crew agent for Harbor (Terminal-Bench).

Import path for Harbor: ``wednesday_agent:WednesdayAgent`` (with this
directory on PYTHONPATH), usable as ``harbor run --agent <path>``.

v1 scope: interface conformance only. setup() is a no-op and run()
fails loudly until Factory executor routing into the Harbor environment
lands (the executor runs tools on the host today; TB tasks grade inside
the container, so file ops must target the container FS via the Harbor
environment API — that routing is the next slice, not this file).

Mapped 2026-10-03 (harbor 0.23.0, exec API, all present):
- environment.exec(command, cwd, env, timeout_sec) -> ExecResult
- environment.upload_file(source_path, target_path)
- environment.download_file(source_path, target_path)
- environment.is_file / is_dir
Custom import seam proven: `harbor agent schema wednesday_agent:WednesdayAgent`
resolves with PYTHONPATH pointed here. Docker daemon verified working
(hello-world runs); TB image pulls deferred until after the file-board
runs by user decision.
"""

from typing import override

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class WednesdayAgentOptions(AgentOptions):
    """No user-facing knobs in v1 (crew + rig come from the Factory env)."""


class WednesdayAgent(BaseAgent):
    capabilities = AgentCapabilities(windows=True)
    options_model = WednesdayAgentOptions

    @staticmethod
    @override
    def name() -> str:
        return "wednesday"

    @override
    def version(self) -> str:
        return "0.1.0-skeleton"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        raise NotImplementedError(
            "WednesdayAgent.run is not wired yet: Factory executor routing "
            "into the Harbor environment is the next slice."
        )

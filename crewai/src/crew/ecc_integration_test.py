import sys
from pathlib import Path

from crewai import Agent, Crew, LLM, Task

REPO_ROOT = Path("/mnt/c/ai-software-factory")
sys.path.insert(0, str(REPO_ROOT))

from ecc.selector.selector import build_playbook


playbook = build_playbook("backend", "python")

llm = LLM(
    model="openrouter/stealth/ox-alpha",
    base_url="https://openrouter.ai/api/v1",
    api_key=None,
)

agent = Agent(
    role="Python Backend Engineer",
    goal="Solve the task while following the supplied ECC engineering playbook.",
    backstory=(
        "You are a Python backend engineer in the AI Software Factory.\n\n"
        "The following ECC playbook is mandatory guidance for this task:\n\n"
        + playbook
    ),
    llm=llm,
    verbose=True,
)

task = Task(
    description=(
        "Explain how you would implement a small Python function that "
        "validates an email address. Do not write or modify files. "
        "Explicitly mention the Python-specific ECC guidance you followed."
    ),
    expected_output=(
        "A concise implementation approach that explicitly identifies "
        "the relevant ECC Python coding and testing guidance."
    ),
    agent=agent,
)

crew = Crew(
    agents=[agent],
    tasks=[task],
    verbose=True,
)

result = crew.kickoff()

print("\n=== ECC + CREWAI RESULT ===")
print(result)

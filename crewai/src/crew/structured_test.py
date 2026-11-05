import json
from pathlib import Path

from crewai import Agent, Crew, Task, LLM
from pydantic import BaseModel, Field


class EngineeringResult(BaseModel):
    task_id: str
    status: str
    plan: str
    implementation_notes: str
    review_notes: str
    test_plan: str
    artifacts: list[dict[str, str]]
    errors: list[str]


llm = LLM(
    model="openrouter/stealth/ox-alpha",
    base_url="https://openrouter.ai/api/v1",
    api_key=None,
)

architect = Agent(
    role="Software Architect",
    goal="Create a concise engineering plan.",
    backstory="Architecture specialist in the AI Software Factory.",
    llm=llm,
    verbose=True,
)

task = Task(
    description=(
        "Create an engineering plan for a simple authentication feature. "
        "The task ID is auth-001. "
	"Return a complete EngineeringResult. "
	"Set status to 'completed' because this task is being completed successfully. "
	"No files should be modified."
    ),
    expected_output="A structured EngineeringResult.",
    output_pydantic=EngineeringResult,
    agent=architect,
)

crew = Crew(
    agents=[architect],
    tasks=[task],
    verbose=True,
)

result = crew.kickoff()

structured = result.pydantic

if structured is None:
    raise RuntimeError("CrewAI did not return a structured Pydantic result.")

data = structured.model_dump()

print("\n=== STRUCTURED RESULT ===")
print(json.dumps(data, indent=2))

schema_path = Path(
    "/mnt/c/ai-software-factory/shared/schemas/engineering-result.schema.json"
)

schema = json.loads(schema_path.read_text())

try:
    from jsonschema import validate

    validate(instance=data, schema=schema)
except ImportError:
    print("\njsonschema package not installed; schema validation skipped.")
else:
    print("\nEngineeringResult schema validation: OK")

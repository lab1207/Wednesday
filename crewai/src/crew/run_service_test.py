import json

from jsonschema import validate

from .contracts import EngineeringTask
from .service import run_engineering_task


task = EngineeringTask(
    task_id="auth-002",
    title="Plan authentication",
    description="Create a plan for registration, login, logout, and protected routes.",
    project_path="/mnt/c/ai-software-factory/workspace/projects/example",
    constraints=["Do not modify files"],
    priority="normal",
)

result = run_engineering_task(task)

print("\n=== ENGINEERING RESULT ===")
print(json.dumps(result.model_dump(), indent=2))

with open(
    "/mnt/c/ai-software-factory/shared/schemas/engineering-result.schema.json",
    "r",
    encoding="utf-8",
) as f:
    schema = json.load(f)

validate(instance=result.model_dump(), schema=schema)

assert result.task_id == task.task_id
assert result.status in {"pending", "working", "completed", "failed"}

print("\nEngineeringResult contract validation: OK")

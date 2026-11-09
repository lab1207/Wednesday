try:
    from .telemetry import disable_telemetry
except ImportError:  # run as a plain script, not as a package module
    from telemetry import disable_telemetry

TELEMETRY_OPTOUTS = disable_telemetry()  # must precede the crewai import

from crewai import Agent, Crew, LLM, Task

from .contracts import EngineeringResult, EngineeringTask


llm = LLM(
    model="openrouter/stealth/ox-alpha",
    base_url="https://openrouter.ai/api/v1",
    api_key=None,
)


def run_engineering_task(task: EngineeringTask) -> EngineeringResult:
    architect = Agent(
        role="Software Architect",
        goal="Create a clear engineering plan for the requested task.",
        backstory=(
            "You are the architecture specialist for the AI Software Factory. "
            "You produce implementation plans without modifying files."
        ),
        llm=llm,
        verbose=True,
    )

    planning_task = Task(
        description=(
            f"Task ID: {task.task_id}\n"
            f"Title: {task.title}\n"
            f"Description: {task.description}\n"
            f"Project path: {task.project_path}\n"
            f"Constraints: {task.constraints}\n"
            f"Priority: {task.priority}\n\n"
            "Produce the engineering plan, implementation notes, review notes, "
            "and test plan. Do not modify files."
        ),
        expected_output=(
            "A structured engineering planning response containing: "
            "plan, implementation_notes, review_notes, and test_plan."
        ),
        agent=architect,
    )

    crew = Crew(
        agents=[architect],
        tasks=[planning_task],
        verbose=True,
    )

    try:
        result = crew.kickoff()
        raw_output = str(result)

        return EngineeringResult(
            task_id=task.task_id,
            status="completed",
            plan=raw_output,
            implementation_notes="Planning only; no files modified.",
            review_notes="Review required before implementation.",
            test_plan="Run unit and integration tests for the requested feature.",
            artifacts=[],
            errors=[],
        )

    except Exception as exc:
        return EngineeringResult(
            task_id=task.task_id,
            status="failed",
            plan="",
            implementation_notes="",
            review_notes="",
            test_plan="",
            artifacts=[],
            errors=[str(exc)],
        )

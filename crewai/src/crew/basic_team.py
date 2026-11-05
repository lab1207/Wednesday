from crewai import Agent, Crew, Task, LLM

llm = LLM(
    model="openrouter/stealth/ox-alpha",
    base_url="https://openrouter.ai/api/v1",
    api_key=None,
)

architect = Agent(
    role="Software Architect",
    goal="Design a clear implementation plan for the requested software task.",
    backstory="You are the architecture specialist on the AI Software Factory engineering team.",
    llm=llm,
    verbose=True,
)

coder = Agent(
    role="Software Engineer",
    goal="Turn the architect's plan into a concise implementation proposal.",
    backstory="You are the coding specialist on the AI Software Factory engineering team.",
    llm=llm,
    verbose=True,
)

architecture_task = Task(
    description=(
        "Design a simple authentication feature for a web application. "
        "Do not write files or code. Produce a short implementation plan."
    ),
    expected_output="A concise implementation plan for the authentication feature.",
    agent=architect,
)

coding_task = Task(
    description=(
        "Using the architect's plan, describe the implementation steps "
        "a software engineer should take. Do not modify files."
    ),
    expected_output="A concise implementation procedure.",
    agent=coder,
    context=[architecture_task],
)

crew = Crew(
    agents=[architect, coder],
    tasks=[architecture_task, coding_task],
    verbose=True,
)

if __name__ == "__main__":
    result = crew.kickoff()
    print("\n=== FINAL RESULT ===\n")
    print(result)

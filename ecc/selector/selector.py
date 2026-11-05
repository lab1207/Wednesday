from pathlib import Path

ECC_ROOT = Path(__file__).resolve().parents[2] / "ecc-source"


ROLE_MAP = {
    "architect": [
        "agents/architect.md",
        "rules/common/development-workflow.md",
        "rules/common/patterns.md",
    ],
    "planner": [
        "agents/planner.md",
        "rules/common/development-workflow.md",
        "rules/common/patterns.md",
    ],
    "backend": [
        "rules/common/coding-style.md",
        "rules/common/security.md",
        "rules/common/testing.md",
    ],
    "frontend": [
        "rules/common/coding-style.md",
        "rules/common/testing.md",
        "skills/frontend-patterns/SKILL.md",
    ],
    "database": [
        "rules/common/security.md",
        "rules/common/testing.md",
    ],
    "security": [
        "rules/common/security.md",
        "skills/security-review/SKILL.md",
    ],
    "tester": [
        "rules/common/testing.md",
        "skills/tdd-workflow/SKILL.md",
        "skills/verification-loop/SKILL.md",
    ],
    "reviewer": [
        "rules/common/code-review.md",
        "rules/common/security.md",
        "rules/common/testing.md",
    ],
    "researcher": [
        "skills/deep-research/SKILL.md",
        "skills/documentation-lookup/SKILL.md",
    ],
    "debugger": [
        "rules/common/development-workflow.md",
        "rules/common/testing.md",
    ],
    "documentation": [
        "rules/common/coding-style.md",
    ],
}


STACK_MAP = {
    "python": [
        "rules/python/coding-style.md",
        "rules/python/patterns.md",
        "rules/python/security.md",
        "rules/python/testing.md",
    ],
    "typescript": [
        "rules/typescript/coding-style.md",
        "rules/typescript/patterns.md",
        "rules/typescript/security.md",
        "rules/typescript/testing.md",
    ],
}


def select_ecc(role: str, stack: str | None = None) -> list[str]:
    selected = list(ROLE_MAP.get(role, []))

    if stack:
        selected.extend(STACK_MAP.get(stack.lower(), []))

    results = []

    for relative_path in selected:
        path = ECC_ROOT / relative_path

        if path.exists():
            results.append(str(path))

    return list(dict.fromkeys(results))


def load_ecc(role: str, stack: str | None = None) -> dict:
    resources = []

    for path_string in select_ecc(role, stack):
        path = Path(path_string)

        resources.append(
            {
                "path": str(path),
                "content": path.read_text(encoding="utf-8"),
            }
        )

    return {
        "role": role,
        "stack": stack,
        "resources": resources,
    }


def build_playbook(role: str, stack: str | None = None) -> str:
    playbook = load_ecc(role, stack)

    sections = [
        "# ECC Playbook",
        f"Role: {playbook['role']}",
        f"Stack: {playbook['stack']}",
        "",
    ]

    for resource in playbook["resources"]:
        sections.append(f"## {resource['path']}")
        sections.append(resource["content"])
        sections.append("")

    return "\n".join(sections)


if __name__ == "__main__":
    playbook = load_ecc("backend", "python")

    print(f"Role: {playbook['role']}")
    print(f"Stack: {playbook['stack']}")
    print(f"Resources loaded: {len(playbook['resources'])}")

    for resource in playbook["resources"]:
        print(f"\n--- {resource['path']} ---")
        print(resource["content"][:500])

    print("\n--- PLAYBOOK PREVIEW ---")
    print(build_playbook("backend", "python")[:3000])

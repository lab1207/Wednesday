# ECC Integration

ecc-source/ is the upstream ECC reference/library.

Do not edit files inside ecc-source/ directly.

The AI Software Factory integrates ECC through the ecc/ adapter layer.

## Flow

Task
→ agent role
→ project stack
→ ECC selector
→ relevant ECC resources
→ CrewAI agent context

## Rules

- Keep ecc-source/ synchronized with upstream when intentionally updating ECC.
- Keep factory-specific logic inside ecc/.
- Never inject the entire ECC library into every agent.
- Load only resources relevant to the agent role and project stack.

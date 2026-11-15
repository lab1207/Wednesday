# Wednesday architecture

Wednesday is one installable component: an MCP server plus a small operator
CLI, backed by a seven-layer engineering system. The layers are internal to the
product; the public surface is deliberately coarse.

## The one rule that matters

**Hermes → FactoryService is the only execution path.** Every caller — the MCP
server, the operator CLI, a future client — submits a task to Hermes and Hermes
runs it through FactoryService. There is no second orchestrator, and no caller
reaches the seats directly.

The MCP layer is a control surface, not an orchestrator. It accepts a request,
hands it to the same supervised path, and reports the verdict.

## Layers

| # | Layer | Job |
| --- | --- | --- |
| 1 | Operator surface | `wednesday-mcp` (MCP over stdio) + the `wednesday` CLI |
| 2 | Hermes agent | Operations manager: the task store and the single dispatch path |
| 3 | Agent Canvas / OpenHands | Software HQ: repository context and planning support |
| 4 | CrewAI | The software-engineering team: roles, crews and crew runtime |
| 5 | Everything Claude Code (ECC) | The engineering playbook: rules and review procedure |
| 6 | DeepSeek Harness (dsh) | The factory floor: isolated execution and the tool runtime |
| 7 | OpenRouter | The model / intelligence layer: hosted model access |

OpenRouter is the model access layer. Keys never enter the repository, the logs
or the task records.

## A run, end to end

```text
request
  → Hermes (task store, dispatch)
    → FactoryService
      → plan      the objective, the workspace, the files in scope
      → build     engineering roles work in a controlled sandbox
      → verify    real commands run against real files
      → repair    failures feed back into the loop until green or budgeted out
      → review    the diff, then a persisted receipt with evidence
```

### Plan

The request becomes an objective, a workspace and a set of files in scope. The
planner can ask the operator one question at a time instead of guessing at an
ambiguous request.

### Build

Engineering roles do the work in a controlled sandbox. Tools are explicit and
shell-free; file access is fenced to the workspace. Images attached to a
request ride the prompt itself, not a path the model cannot open.

### Verify

Verification is **authoritative**. It is not `npm test` alone: if the workspace
declares its own gate — `typecheck`, `tsc`, `lint` — Wednesday runs it too, and
a failing gate feeds back to the coder exactly like a failing test. Only
scripts the project already declares are used; nothing is guessed and nothing
is downloaded. The model's opinion about whether it worked does not count.

### Repair

Failures are fed back into the crew with a capped budget. The loop stops when
the check passes or the budget is exhausted, and the receipt records the
attempts.

### Review and receipt

After green, the diff is reviewed and the run is persisted with its plan,
events and evidence. Tokens, wall clock and dollars are recorded **per seat**,
because one model can wear several name tags.

## Crews and seats

A crew carries seats, per-seat models and a shape: `solo`, `duel`, `vote`,
`relay`, or `auto` (task difficulty decides), plus a repair cap and a budget.
The crew is staffed by the operator and stored as plain JSON in
`~/.wednesday/state/crews.json`.

Seats are never callable over MCP. If the host model could call `architect` or
`coder`, it would become the team lead and the small-model team would become day
labour — progress that destroys the point. The surface is coarse on purpose,
and `factory/mcp/server-test.ts` asserts that no seat is exposed.

## Model routing

A model **pool** comes from `FACTORY_MODEL_POOL` (`id` or `id@baseURL`,
comma-separated), else the three crew slots, else the single `LOCAL_LLM_MODEL`.
With team-up on (`FACTORY_RELAY=1`) the first team-up round probes every pooled
model on five capabilities — reasoning, coding, vision, review, complete — and
keeps the scores. Each seat then goes to the model that scores best for that
capability. A round's wins and losses fold back into the scores, so the next
round prefers the crew that proved itself.

The context window is the **smaller** of the model's own ceiling and the
deployment's real window. A prompt that does not fit is trimmed in the middle,
so the head and tail survive.

## Security

- Central secret redaction on anything that can print an error or a log line.
- Shell-free, fenced tools; workspace paths are checked before use.
- A commit-time gate (`wednesday scan`) that scans staged content with the same
  rules a run uses.
- No telemetry that identifies users, and no code sent off-machine by default.

## Where things live

| Path | What |
| --- | --- |
| `factory/mcp/` | The MCP server: protocol, job layer, tool surface |
| `factory/orchestrator/` | Dispatch and the locked test |
| `factory/teams/` | Crew store |
| `factory/model-router/` | Provider routes, local discovery, prompt budget |
| `factory/agents/` | Roles, planners, reviewers, difficulty, MOA |
| `factory/executor/` | The controlled execution floor |
| `factory/verification/` | Real-command verification and acceptance |
| `factory/security/` | Redaction, leak scan, surface regressions |
| `crewai/` | The CrewAI team layer |
| `ecc/` | The engineering playbook layer |
| `bin/` | `wednesday` and `wednesday-mcp` entrypoints |
| `scripts/` | Export, leak scan and release regressions |

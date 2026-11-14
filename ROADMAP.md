# Wednesday roadmap

Wednesday is free and open source (Apache 2.0). This is where the project is
going and where help is most useful. Beta means the MCP server is the product
today; everything below is actively being worked on, not a promise of dates.

## Now - beta `0.2.0-beta.6` + the MCP server on `master`

Shipped and in daily use:

- **Wednesday as an MCP server** (`wednesday-mcp`): one coarse `wednesday_run`
  tool with `status`/`wait`/`result`/`cancel`/`jobs`, plus a read-only
  `wednesday_team`. Seats are never callable from outside; the host model is a
  messenger. The terminal harness was retired 2026-11-14.
- The engine: plan → build → real tests → repair → review → receipt.
- Named teams, engineering roles, per-seat models and shapes (`solo`, `duel`,
  `vote`, `relay`, `auto`), repair budgets — staffed by the operator with
  `wednesday team`, adopted by every MCP connection at startup.
- Routes and keys for OpenRouter, NVIDIA NIM, any OpenAI-compatible endpoint,
  local servers, tunnels, and the local proxy.
- Local-first storage: keys in `~/.wednesday/.env`, state in `~/.wednesday/state/`.
- **Images reach the model**: a picture rides the request, not a path the model
  cannot open.
- **The operator's own skills**: drop a folder with a `SKILL.md` into
  `~/.wednesday/skills/` (or the project's `.wednesday/skills/`), or install a
  `.skill` package — behind the same audit that vets the factory's own skills.
- **The operator's own MCP servers**: attach one over stdio or Streamable HTTP;
  the model calls its tools as `mcp__<server>__<tool>`.
- Security hardening: central redaction, shell-free fenced tools, and a
  packaging-surface test in CI-able form.
- The operator's six-seat roster — UI/UX, architecture, coding, autocomplete,
  bug hunting, security audit — with each seat's GGUF source and the
  Q4_K_M/Q5_K_M rule recorded rather than guessed.
- `wednesday scan`: a commit-time gate that scans STAGED content, so a
  generated secret never reaches git history.
- A team turn: `FACTORY_MOA=1 FACTORY_MOA_PROPOSERS=coder,reviewer,tester`
  asks several models in parallel and reads their answers back through one
  aggregator.

## Next

- **`wednesday setup`** — register `wednesday-mcp` into Claude Code, Codex,
  Cursor and OpenCode in one command, backing up whatever it touches. This is
  what makes the server installable instead of a manual JSON edit.
- **One live run in a real harness** — a real task, a real host model, a real
  hand-off. Until that happens the prompt and `wait` are proven only against
  fixtures.
- **A release that carries the server** — the MCP surface is on `master`; npm
  `0.2.0-beta.6` predates it.
- **Public benchmark ladder** — crew-only runs on public boards (HumanEval,
  aider polyglot, LiveCodeBench, SWE-bench Verified, EvalPlus, …) published
  with full evidence. Results before marketing. The ladder now runs the
  **solo arm** beside the factory arm — the same model, the same problems, no
  factory around it — so a published score says what the factory *added*, and
  boards that grade a repository fix say plainly that they cannot carry the
  bare arm.
- **Runtime packs for Linux and macOS** — the Windows pack already ships.
- **Client polish** — artifacts as MCP resources (`wednesday://runs/{id}/diff`),
  HTTP transport, MCP elicitation wired to the approval gate.

## How to contribute to the roadmap

1. **Pick something from *Next*** and open an issue saying you want it. Wait
   for a maintainer's 👍 before writing a large change — it avoids wasted work.
2. **Smaller than *Next*?** Docs, tests, and bug fixes need no prior issue.
3. **Propose a new item** with an issue that states the user problem, the
   smallest version that solves it, and how it can be verified. Roadmap items
   are judged on evidence, not ambition.
4. **Claim a `good first issue`** — these are scoped to be finishable in one
   sitting and come with pointers to the relevant files.

Where help matters most right now:

| Area | Where | Skill |
| --- | --- | --- |
| Benchmark adapters | `factory/benchmark/` | TypeScript, test harnesses |
| MCP surface | `factory/mcp/` | TypeScript, MCP clients |
| Team store | `factory/teams/` | TypeScript, operator UX |
| Provider support | `factory/model-router/providers/` | TypeScript, HTTP APIs |
| Docs and examples | `README.md`, `site/`, `docs/` | writing |
| Platform testing | any | macOS/Linux, Node 24 |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and test map.

## Explicitly out of scope for this repository

- Paid, licensed, or gated feature code. This repo is the free core, in full.
- Anything requiring a hosted backend to use the terminal.
- Secrets, telemetry that identifies users, or sending code off-machine by
  default.

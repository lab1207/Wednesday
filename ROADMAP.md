# Wednesday roadmap

Wednesday is free and open source (Apache 2.0). This is where the project is
going and where help is most useful. Beta means the terminal is the product
today; everything below is actively being worked on, not a promise of dates.

## Now - beta `0.2.0-beta.5`

Shipped and in daily use:

- Terminal harness: plan → preview → approve → build → real tests → repair →
  review → receipt.
- Fullscreen TUI, command palette, 25 slash commands, pager.
- `/connect`: OpenRouter, NVIDIA NIM, any OpenAI-compatible endpoint, local
  servers, tunnels, and the local proxy.
- Named teams, engineering roles, per-seat model picks, repair budgets.
- Local-first storage: keys in `~/.wednesday/.env`, state in `~/.wednesday/state/`.
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

- **Desktop IDE** — a graphical shell around the same engine.
- **Public benchmark ladder** — crew-only runs on public boards (HumanEval,
  aider polyglot, LiveCodeBench, SWE-bench Verified, EvalPlus, …) published
  with full evidence. Results before marketing. The ladder now runs the
  **solo arm** beside the factory arm — the same model, the same problems, no
  factory around it — so a published score says what the factory *added*, and
  boards that grade a repository fix say plainly that they cannot carry the
  bare arm.
- **Runtime packs for Linux and macOS** — the Windows pack already ships.
- **Harness polish** — streamed coder tokens in build runs, richer review diffs.
- **Accessibility** — screen-reader labels, high-contrast theme, reduced motion.

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
| TUI polish | `factory/harness/` | TypeScript, terminal UX |
| Provider support | `factory/model-router/providers/` | TypeScript, HTTP APIs |
| Docs and examples | `README.md`, `site/`, `docs/` | writing |
| Platform testing | any | macOS/Linux, Node 24 |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and test map.

## Explicitly out of scope for this repository

- Paid, licensed, or gated feature code. This repo is the free core, in full.
- Anything requiring a hosted backend to use the terminal.
- Secrets, telemetry that identifies users, or sending code off-machine by
  default.

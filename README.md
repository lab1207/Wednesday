# Wednesday

**One tool call. A whole engineering team behind it.**

[![website](https://img.shields.io/badge/website-wednesdaylabs.pages.dev-5D43A0)](https://wednesdaylabs.pages.dev/)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![tests](https://img.shields.io/badge/locked%20test-PASS-brightgreen)](CONTRIBUTING.md#tests)

Wednesday is a free, open-source (Apache 2.0) **MCP server** that turns a
plain-language request into planned, verified engineering work. You connect it
to the harness you already use — Claude Code, Codex, Cursor, OpenCode, Claude
Desktop — and Wednesday staffs a whole team behind it: planning, engineering
roles, real verification, and repair until the tests pass. You bring the model,
hosted or running on your own hardware.

**Small open models, staffed as a coding team.**

## No harness. Wednesday is the team your harness can call.

There is no app to install, no TUI, no terminal to learn. Wednesday speaks
[MCP](https://modelcontextprotocol.io) over stdio, so it plugs into the client
you already work in. The host model does not do the work — it hands the request
in, waits, and reports the verdict.

That is deliberate, and it is the whole design:

> **One tool in, the whole team inside. Never leak seats over MCP.**

The seats — architect, planner, coder, tester, reviewer, vision, bug-hunter,
security-audit — are not callable from outside. If the host model could call
`coder`, it would become the team lead and the small-model team would become
day labour: progress that destroys the point. So the surface is coarse on
purpose, and the test suite asserts that no seat is exposed.

## Install

The MCP server ships on `master` today; npm `0.2.0-beta.6` predates it, so
install from source until the next release:

```bash
git clone https://github.com/lab1207/Wednesday.git
cd Wednesday
npm install
npm link                 # puts `wednesday` and `wednesday-mcp` on your PATH
```

**Requirements:** Node.js **24 or newer** on Windows, macOS, or Linux, and a
model backend — your own OpenRouter/NVIDIA NIM key, or a local
OpenAI-compatible server (Ollama `:11434`, LM Studio `:1234`, llama.cpp
`:8080`, vLLM `:8000`, any local server on `:1337`).

`wednesday setup` — one command that registers the server into each client and
backs up what it touches — is the next piece of work. Until then, add the
config by hand (below).

## Connect your harness

**Claude Code**

```bash
claude mcp add wednesday -- wednesday-mcp
# add --scope user to make it available in every project
```

**OpenCode** — `opencode mcp add wednesday -- wednesday-mcp`, or by hand in
`opencode.jsonc` (note `mcp.servers`, and that local servers take a command
array):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "wednesday": { "type": "local", "command": ["wednesday-mcp"] }
    }
  }
}
```

**Claude Desktop / Cursor** (`claude_desktop_config.json`, `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "wednesday": { "command": "wednesday-mcp" }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.wednesday]
command = "wednesday-mcp"
```

Then say what you want built, or use the prompt — most clients surface it as
`/wednesday:run` (OpenCode) or `/mcp__wednesday__run` (Claude Code). The prompt
is the reliable path: it injects the hand-off instruction instead of hoping the
model picks the tool.

## What a run looks like

```text
you → harness → wednesday_run("add a quantity input to the cart page")
                 ↳ job accepted, id 3f9c…, workspace validated
harness → wednesday_wait(id)      ↳ working: planner, coder, verification…
harness → wednesday_result(id)    ↳ completed, tests PASS, files, receipt
```

| Tool | Job |
| --- | --- |
| `wednesday_run` | Start a run. Returns a job id immediately; validates the workspace in the same call. |
| `wednesday_status` | Cheap poll: state, elapsed, the last few team steps. |
| `wednesday_wait` | Block up to 55s. Returns `done: false` rather than hanging; call again. |
| `wednesday_result` | The verdict: status, summary, files, tests, acceptance, diagnostics. |
| `wednesday_cancel` | Stop a queued or running job. |
| `wednesday_jobs` | This session's runs, newest first. |
| `wednesday_team` | Read-only: the operator's crew and whether this connection adopted it. |

The client's own tool timeout is why `wait` exists at all: a nine-minute run
delivered as one blocking call would be reaped and look like a crash. `wait`
also emits `notifications/progress` when the request carries a
`progressToken`, so a client can show the team moving.

## Staff the team

The team is **your decision, not the calling model's** — so there is no tool to
change it. Staff it once from the CLI; every MCP connection adopts the active
crew at startup.

```bash
wednesday team                                   # list crews, active marked
wednesday team add demo coder=qwen/qwen3-coder reviewer=local/qwen2.5-coder-3b --shape auto
wednesday team use demo                           # make it the active crew
wednesday team show                               # seats, models, policy
```

A crew carries seats, per-seat models, and a shape: `solo`, `duel`, `vote`,
`relay`, or `auto` (task difficulty decides), plus repair cap and budget. It
lives as plain JSON in `~/.wednesday/state/crews.json`.

## The operator CLI

The same engine, without a client open:

| Verb | What it does |
| --- | --- |
| `wednesday create --objective "…"` | Register a task (Hermes is the task store). |
| `wednesday run <id>` | Run it through plan → build → verify → repair → review. |
| `wednesday watch <id>` / `status` / `events` / `result` | Live stages, current state, event log, receipt. |
| `wednesday list` / `retry` / `cancel` | The queue and its controls. |
| `wednesday team …` | Staff the seats (above). |
| `wednesday scan …` | The commit-time security gate (below). |

Add `--json` to any verb for machine-readable output.

## Why Wednesday

A model on its own guesses. Wednesday wraps it in a process that cannot skip the
checks:

1. **Plan** — the request becomes an objective, a workspace, and files in scope.
2. **Build** — engineering roles do the work in a controlled sandbox.
3. **Verify** — real commands run against real files. The model's opinion about
   whether it worked does not count.
4. **Repair** — failures feed back into the loop until the check passes or the
   budget runs out.
5. **Review + receipt** — you see the diff after green, and the run is persisted
   with its evidence.

Nothing is committed for you. Over MCP the team runs unattended inside its
workspace; a harness-side approval gate wired to MCP elicitation is not built
yet, and the README will say so until it is.

### Verification is authoritative

Verification is not only `npm test`. If the workspace declares a gate of its
own — `typecheck`, `tsc`, `lint` — Wednesday runs it too, and a failing gate
feeds back to the coder exactly like a failing test:

```text
Verification:
  $ npm test
  $ npm run typecheck        ← picked up from package.json
```

A small model's most common defect is a syntax slip, and the compiler is the
cheapest, most deterministic reader of one. Only scripts the project already
declares are used — nothing is guessed and nothing is downloaded.

## Model providers

Routes and keys live in `~/.wednesday/.env` on your machine only — never in the
repo, logs, receipts, or the website.

| Backend | How |
| --- | --- |
| Local models | auto-detect Ollama :11434 · LM Studio :1234 · llama.cpp :8080 · vLLM :8000 · any local server :1337 — no key |
| vLLM | auto-detected on `http://127.0.0.1:8000/v1` — or paste the base URL for a non-default port |
| ngrok / Cloudflare tunnel | paste the tunnel URL |
| Local proxy | anything on `127.0.0.1:18090` |
| Any OpenAI-compatible API | base URL + key + model (DeepSeek, Groq, Together, Mistral, vLLM…) |
| OpenRouter | hosted catalog, `OPENROUTER_API_KEY` |
| NVIDIA NIM | hosted inference, `NVIDIA_API_KEY` |

### Which model takes which seat

A model **pool** comes from `FACTORY_MODEL_POOL` (`id` or `id@baseURL`,
comma-separated), else the three crew slots, else the single `LOCAL_LLM_MODEL`.
With team-up on (`FACTORY_RELAY=1`) the first team-up round **probes** every
pooled model on five capabilities — reasoning, coding, vision, review,
complete — and keeps the scores. Each seat then goes to the model that
**scores best for that capability**: one strong model can hold the planner,
the coder and the reviewer at once. A round's wins and losses fold back into
the scores, so the next round prefers the crew that proved itself. Routing is
by measured capability fit.

#### The operator's six-seat roster, and where the weights come from

These are the seats and the local weights the roster runs. Serve them from any
OpenAI-compatible server (llama.cpp, Ollama, LM Studio, vLLM) and point
`FACTORY_CREW_<SEAT>_BASE_URL` at it.

| Seat | Model | GGUF weights |
| --- | --- | --- |
| UI/UX DESIGN (`vision`) | Qwen2.5-VL-3B | [`unsloth/Qwen2.5-VL-3B-Instruct-GGUF`](https://huggingface.co/unsloth/Qwen2.5-VL-3B-Instruct-GGUF) |
| ARCHITECTURE (`architect`) | Granite 3.1 2B | [`bartowski/granite-3.1-2b-instruct-GGUF`](https://huggingface.co/bartowski/granite-3.1-2b-instruct-GGUF) |
| CORE CODING (`coder`) | Qwen2.5-Coder-3B | [`Qwen/Qwen2.5-Coder-3B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF) |
| AUTOCOMPLETE (`autocomplete`) | DeepSeek Coder 1.3B | [`TheBloke/deepseek-coder-1.3b-base-GGUF`](https://huggingface.co/TheBloke/deepseek-coder-1.3b-base-GGUF) |
| BUG HUNTING (`bug-hunter`) | Llama-3.2-3B-Instruct | [`unsloth/Llama-3.2-3B-Instruct-GGUF`](https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF) |
| SECURITY AUDIT (`security-audit`) | Granite Guardian 3.1 2B | [`DevQuasar-11/ibm-granite.granite-guardian-3.1-2b-GGUF`](https://huggingface.co/DevQuasar-11/ibm-granite.granite-guardian-3.1-2b-GGUF) |

**Quantisation is mandatory: download the Q4_K_M or Q5_K_M GGUF.** You get
99% of the coding performance at half the hardware resource usage.

Three of these seats — AUTOCOMPLETE, BUG HUNTING and SECURITY AUDIT — wear
that model by default the moment you give the seat its own endpoint. The other
seats ride the slot mapping, because a box that holds one Q4 model at a time
cannot run two: give a seat `FACTORY_CREW_<SEAT>_BASE_URL` (or
`FACTORY_CREW_<SEAT>_MODEL`) and it wears its roster model.

The SECURITY AUDIT seat runs the operator's prompt verbatim — *"Act as an
aggressive senior security engineer and penetration tester. Review this
generated code for hidden memory leaks, security vulnerabilities (like XSS or
injection), and edge cases where it might crash. List them out."* — followed
by a FOUND / NOT FOUND checklist, because a 2B model given an open-ended
prompt returns three generic warnings and given a fixed list returns something
you can act on.

### Context window

Two numbers, and the **smaller one wins**. The registry gives the **model's**
own ceiling — Qwen2.5-Coder-3B is a 32K model — while the server gives the
**deployment's** real window: the benchmark Colab T4 box serves that model in
a 13,312-token window, and a memory-tight local server can be smaller still.
A prompt that does not fit is trimmed in the middle (head and tail survive)
instead of being cut off at the end.

### What a run costs

Tokens, wall clock and dollars are recorded **per seat** — the planner, the
coder and the reviewer are separate rows, because with one model wearing three
name tags a per-model total could not tell you the same model did three jobs.
For a locally hosted model the real cost is GPU-minutes, so wall clock is on
the same line.

The factory will not invent a price. It knows the free tier costs nothing and
it knows nothing else, because **your contract is what you pay**. Set your own
price and the receipts become real:

```bash
# USD per million tokens: input,output
FACTORY_PRICE_QWEN_QWEN3_CODER=0.30,1.20
FACTORY_PRICE_OPENROUTER_FREE=0,0
```

The model name is uppercased and every non-alphanumeric character becomes `_`,
so `qwen/qwen3-coder` becomes `FACTORY_PRICE_QWEN_QWEN3_CODER`. A model with
no price is reported as **unpriced** — its tokens still count, and the dollar
column stays empty rather than showing a made-up figure. A local model shows
`$0.0000`: the hardware is yours, the tokens are free.

### Ask a team instead of one model

A single chat turn is normally answered by one model. Set `FACTORY_MOA=1` with
a team and the turn goes to every teammate in parallel, then one aggregator
reads them all and returns a single answer:

```bash
FACTORY_MOA=1 FACTORY_MOA_PROPOSERS=coder,reviewer,tester wednesday run <id>
```

Each entry may name its own model — `reviewer=/models/reviewer-q4_k_m.gguf` —
and `FACTORY_MOA_AGGREGATOR` picks who synthesises (the chat route by default).
A teammate that fails does not kill the turn: the rest are still aggregated, and
the dead one is named with its reason rather than silently dropped.

## Your own skills

A skill is a folder with a `SKILL.md` in it — frontmatter with a `name:` and a
`description:`, and a body that tells a seat how to do something. Drop the
folder in and Wednesday finds it:

```bash
~/.wednesday/skills/             # your own skills (all projects)
<project>/.wednesday/skills/     # the project's skills (travel with the repo)
```

A project skill beats an operator skill with the same name. An installed
package goes through the same audit the factory uses for a skill it did not
write: an instruction-override directive or a hidden instruction **refuses the
install** and names what it found. A `.skill` file is a zip holding one skill
directory; a package that tries to write outside its own folder is refused.

## MCP servers you attach

Wednesday speaks MCP itself (`initialize`, `tools/list`, `tools/call`) over
stdio and Streamable HTTP, with no extra dependency. Attached servers are
listed in `~/.wednesday/state/mcp.json`; their tools ride a request as
`mcp__<server>__<tool>` and a call runs on the server that owns it. A model that
is not known to do native tool calls is never offered any. A server's `env` and
`headers` can hold a token: the values are stored on your machine and **never
printed**.

## Local data

| What | Where |
| --- | --- |
| Credentials | `~/.wednesday/.env` |
| Teams (crews) | `~/.wednesday/state/crews.json` |
| Task history | `~/.wednesday/state/tasks.json` |
| Event log | `~/.wednesday/state/events.jsonl` |
| Your skills | `~/.wednesday/skills/` |
| MCP servers | `~/.wednesday/state/mcp.json` |

Advanced overrides: `WEDNESDAY_STATE_HOME` moves the state directory;
`HERMES_TASKS_PATH` and `FACTORY_EVENTS_PATH` select individual files;
`WEDNESDAY_SKILLS_HOME` moves the skills directory.

## Keep a secret out of your history

Wednesday ships the same security gate it applies to every run, as a command
you can run yourself:

```bash
wednesday scan                  # scan the repo you are standing in
wednesday scan --repo ./other   # scan another repository
wednesday scan --install-hook   # block a bad commit before it exists
```

`--install-hook` writes `.githooks/pre-commit` in your repository and sets
`core.hooksPath`, so the gate travels with the repo — every clone and every
contributor gets it. It scans what is **staged**, so it judges the bytes that
are actually being committed, and it uses the same rules that block a leaked
secret in a Wednesday run.

It matches *shapes*: a pass means "no secret shape, no dangerous call shape",
never "no vulnerability". Escape hatches are loud rather than silent —
`--allow-findings` (or `WEDNESDAY_SCAN_ALLOW=1`) reports the finding **and**
says it is now part of the history; `git commit --no-verify` bypasses
everything.

## Open source, and only open source

This repository is the free core — all of it. There is no hidden "pro" build
and no license-flag gating: every feature in the npm package is in this repo,
and everything here is Apache 2.0. Paid or commercial work, if it exists, is
built and released separately and never lands in this repository.

- npm: <https://www.npmjs.com/package/@lab1207/wednesday>
- Website: <https://wednesdaylabs.pages.dev>
- Issues: <https://github.com/lab1207/Wednesday/issues>
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Roadmap: [`ROADMAP.md`](ROADMAP.md)
- Security: [`SECURITY.md`](SECURITY.md)

## Developing Wednesday itself

```bash
npm install
npx tsx factory/orchestrator/test.ts     # locked dispatch sequence — must PASS
npx tsx factory/mcp/server-test.ts       # the MCP surface, end to end
npx tsx factory/security/package-surface-test.ts
npx tsx factory/security/redaction-test.ts
```

See `CONTRIBUTING.md` for the test map, issue/PR rules, and the ground rules
(no secrets, verification stays authoritative).

## Status

**Beta, 2026-11-14.** The terminal harness was retired on this date: the product
is the MCP server plus a small operator CLI. The engine behind it — plan,
build, real verification, repair until green, review, per-seat receipts,
central secret redaction, shell-free fenced tools — is unchanged and still
guarded by the same tests. Next: `wednesday setup`, one live run inside a real
harness, then a release that puts the server on npm.

Licensed under [Apache 2.0](LICENSE). Third-party notices:
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

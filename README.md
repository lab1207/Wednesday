# Wednesday

**One terminal command. A whole engineering team behind it.**

[![npm](https://img.shields.io/npm/v/@lab1207/wednesday/beta?label=npm&color=cb3837)](https://www.npmjs.com/package/@lab1207/wednesday)
[![website](https://img.shields.io/badge/website-wednesdaylabs.pages.dev-5D43A0)](https://wednesdaylabs.pages.dev/)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![tests](https://img.shields.io/badge/locked%20test-PASS-brightgreen)](CONTRIBUTING.md#tests)

Wednesday is a free, open-source (Apache 2.0) terminal harness that turns a
plain-language request into planned, verified engineering work. You bring the
model — hosted or running locally on your own hardware — and Wednesday supplies
the structure around it: planning, explicit approval, engineering roles, real
verification, and repair until the tests pass.

**Small open models, staffed as a coding team.**

![Wednesday starting in Windows Terminal: the TUI connects a local qwen2.5-coder-3b model and draws its crew and command list](https://raw.githubusercontent.com/lab1207/Wednesday/master/media/wednesday-demo.gif)

```bash
npm i -g @lab1207/wednesday@beta
wednesday                # first run: /connect picks a model, then type a request
```

> **Beta.** Version `0.2.0-beta.5`. The terminal app is the product today; the
> desktop IDE is still in development. Beta builds can change at any time.

- **Website:** <https://wednesdaylabs.pages.dev>
- **npm:** <https://www.npmjs.com/package/@lab1207/wednesday>
- **Source:** <https://github.com/lab1207/Wednesday>
- **Issues:** <https://github.com/lab1207/Wednesday/issues>

---

## Why Wednesday

A model on its own guesses. Wednesday wraps it in a process that cannot skip the
checks:

1. **Plan** — your request becomes an objective, a workspace, and files in scope.
2. **Approve** — you see the task preview and the verification command. Nothing
   runs until you say `y`. Piped input never auto-approves.
3. **Build** — engineering roles do the work in a controlled sandbox.
4. **Verify** — real commands run against real files. The model's opinion about
   whether it worked does not count.
5. **Repair** — failures feed back into the loop until the check passes or the
   budget runs out.
6. **Review + receipt** — you see the diff after green, and the run is persisted
   with its evidence.

Every run has a receipt: `/tasks`, `/result`, `/events`, `/run`.

![The task preview card: files in scope and the verification command, with Run once / Deny](https://raw.githubusercontent.com/lab1207/Wednesday/master/media/tui-approval.png)

## Install

```bash
npm i -g @lab1207/wednesday@beta   # recommended beta channel
npm i -g @lab1207/wednesday        # latest tag
npm i -g @lab1207/wednesday@dev    # newest commits, may break
npx @lab1207/wednesday@beta        # one-shot, no global install
```

Or from source:

```bash
git clone https://github.com/lab1207/Wednesday.git
cd Wednesday
npm install
npm link                 # `wednesday` on your PATH from this checkout
```

**Requirements:** Node.js **24 or newer** on Windows, macOS, or Linux, and a
model backend — your own OpenRouter/NVIDIA NIM key, or a local
OpenAI-compatible server. `/connect` auto-detects Ollama (`:11434`), LM Studio
(`:1234`), llama.cpp (`:8080`), vLLM (`:8000`) and any local server on
`:1337`. Every other runtime connects by base URL.

Remove the command with `npm uninstall --global @lab1207/wednesday`.
Uninstalling leaves your profile data in place; `wednesday uninstall` removes
`~/.wednesday` after an explicit confirmation.

## Try it in five minutes

```bash
mkdir demo && cd demo
npm init -y
wednesday "Create hello.txt containing exactly HELLO_DEMO." \
  --test "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('hello.txt','utf8').trim(),'HELLO_DEMO')\"" \
  --required-file hello.txt
```

Review the task preview, press `y`, and watch the stages stream. Windows
PowerShell mis-handles the nested quoting — save the test to `verify.js` and
pass `--test "node verify.js"` instead.

## What a run looks like

```text
❯ Add a quantity input to the cart page.
╭─ Task preview ─────────────────╮
│ Objective, workspace, files…   │
│ Verification: $ node --test    │
╰────────────────────────────────╯
Run this task? [y/N] — y approves, n/Esc rejects
─── coder ───
✓ agent.completed (coder)
✓ verification.completed (tester)
✓ task.completed
test PASS: node --test
```

Verification is authoritative, and it is not only `npm test`. If the workspace
declares a gate of its own — `typecheck`, `tsc`, `lint` — Wednesday runs it
too, and a failing gate feeds back to the coder exactly like a failing test:

```text
Verification:
  $ npm test
  $ npm run typecheck        ← picked up from package.json
```

A small model's most common defect is a syntax slip, and the compiler is the
cheapest, most deterministic reader of one. Only scripts the project already
declares are used — nothing is guessed and nothing is downloaded.

## The terminal

- Fullscreen TUI with a command palette (`ctrl+p`), pager, and per-seat model picks.
- 25 slash commands: `/connect`, `/model`, `/create`, `/team`, `/templates`,
  `/tasks`, `/result`, `/events`, `/run`, `/review`, `/update`, `/uninstall`,
  `/onboard`, and more.
- Named teams with six real roles (architect, planner, coder, tester, reviewer,
  vision), per-role models, and a team policy — shape, repair cap, token and
  dollar budgets, the verification command — stored as plain JSON in
  `~/.wednesday/state/crews.json`.
- `/review accept` stages the last run's change; `/review reject` puts it
  back. The factory never commits on its own.
- A daily update check that asks before installing anything.

![The Ctrl+P command palette listing every slash command with a one-line description](https://raw.githubusercontent.com/lab1207/Wednesday/master/media/tui-palette.png)

![The /help command reference grouped by session, setup, work, system, and help](https://raw.githubusercontent.com/lab1207/Wednesday/master/media/tui-help.png)

## Model providers

`/connect` probes the endpoint read-only, lists its models, lets you pick, and
saves the choice to `~/.wednesday/.env` (applied live too).

| Backend | How |
| --- | --- |
| Local models | auto-detect Ollama :11434 · LM Studio :1234 · llama.cpp :8080 · vLLM :8000 · any local server :1337 — no key |
| vLLM | auto-detected on `http://127.0.0.1:8000/v1` — or paste the base URL for a non-default port |
| ngrok / Cloudflare tunnel | paste the tunnel URL |
| Local proxy | anything on `127.0.0.1:18090` |
| Any OpenAI-compatible API | base URL + key + model (DeepSeek, Groq, Together, Mistral, vLLM…) |
| OpenRouter | hosted catalog, `OPENROUTER_API_KEY` |
| NVIDIA NIM | hosted inference, `NVIDIA_API_KEY` |

Keys are saved to `~/.wednesday/.env` on your machine only — never into the
repo, logs, receipts, or the website.

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

`/stats` shows what the session spent: tokens, wall clock and dollars **per
seat** — the planner, the coder and the reviewer are listed separately, because
with one model wearing three name tags the model rows could not tell you that
the same model had done three different jobs. For a locally hosted model the
real cost is GPU-minutes, so the wall clock is on the same line.

The factory will not invent a price. It knows that the free tier costs
nothing and it knows nothing else, because **your contract is what you pay**.
Set your own price and the receipts become real:

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

## Local data

| What | Where |
| --- | --- |
| Credentials | `~/.wednesday/.env` |
| Task history | `~/.wednesday/state/tasks.json` |
| Event log | `~/.wednesday/state/events.jsonl` |

Advanced overrides: `WEDNESDAY_STATE_HOME` moves the state directory;
`HERMES_TASKS_PATH` and `FACTORY_EVENTS_PATH` select individual files.
`WEDNESDAY_NO_UPDATE_CHECK=1` disables the daily version notice.

### Ask a team instead of one model

A chat turn is normally answered by one model. Set `FACTORY_MOA=1` with a
team and the turn goes to every teammate in parallel, then one aggregator
reads them all and returns a single answer:

```bash
FACTORY_MOA=1 FACTORY_MOA_PROPOSERS=coder,reviewer,tester wednesday
```

Each entry may name its own model — `reviewer=/models/reviewer-q4_k_m.gguf` —
and `FACTORY_MOA_AGGREGATOR` picks who synthesises (the chat route by default).

The receipt names every teammate, the aggregator, and what it cost:

```text
team coder + reviewer + tester (3/3 answered) -> local/qwen2.5-coder-3b-instruct
```

A teammate that fails does not kill the turn: the rest are still aggregated,
and the dead one is named with its reason rather than silently dropped.

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
npx tsx factory/security/package-surface-test.ts
npx tsx factory/harness/harness-test.ts  # approval gate + pipeline
```

See `CONTRIBUTING.md` for the full test map, issue/PR rules, and the ground
rules (no secrets, verification stays authoritative).

## Status

**Beta, 2026-11-02.** Terminal harness end to end: fullscreen TUI, approval
gates, team and model routing, central secret redaction, shell-free fenced
tools, and a packaging surface guarded by tests. Next: desktop IDE, public
benchmark ladder, and runtime packs for Linux/macOS.

Licensed under [Apache 2.0](LICENSE). Third-party notices:
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

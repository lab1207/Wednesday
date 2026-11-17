# Wednesday MCP server

Wednesday is an [MCP](https://modelcontextprotocol.io) server that staffs small
open models as a verified engineering team. The host model in your client is a
messenger: it hands a request in, waits, and reports the verdict. The seats —
architect, planner, coder, tester, reviewer, vision, bug-hunter,
security-audit — stay inside Wednesday.

> **One tool in, the whole team inside. Never leak seats over MCP.**

The server speaks MCP over **stdio** (newline-delimited JSON-RPC 2.0). It has
no UI of its own and no app to install: you connect it to the client you
already use.

## Requirements

- Node.js **24 or newer** on Windows, macOS or Linux.
- A model backend: your own OpenRouter or NVIDIA NIM key, or any local
  OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM).

## Install

From source (macOS/Linux one command):

```bash
git clone https://github.com/lab1207/Wednesday.git
cd Wednesday
npm install
npm link                 # puts `wednesday` and `wednesday-mcp` on your PATH
```

or run `./install.sh` (macOS/Linux), which clones, installs and links.

## Register with a client

One command registers every MCP client it finds on the machine:

```bash
wednesday setup                     # every client found
wednesday setup --dry-run           # plan only, nothing written
wednesday setup --all               # also create configs for absent clients
wednesday setup --client codex      # one client (repeatable or comma-separated)
```

What it registers is an absolute command — `node <checkout>/bin/wednesday-mcp.js` —
so it works without a global link and without the Windows `.cmd` shim problem.
Each file is backed up as `<file>.wednesday-backup-<timestamp>` before it is
written, and a file that is not strict JSON is reported and left untouched.
`claude` and `opencode` are registered through their own `mcp add` command when
those CLIs are installed; Claude Desktop, Cursor and Codex are written directly.
Pass `--command "wednesday-mcp"` to register a globally linked bin instead.

By hand:

**Claude Code**

```bash
claude mcp add wednesday -- wednesday-mcp
# add --scope user to make it available in every project
```

**OpenCode**

```bash
opencode mcp add wednesday -- wednesday-mcp
```

or by hand in `opencode.jsonc`:

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

A repo-root `mcp.json` is included for clients that read one:

```json
{ "mcpServers": { "wednesday": { "command": "node", "args": ["bin/wednesday-mcp.js"] } } }
```

## Tool surface

All tools are prefixed `wednesday_`. There is no tool for a seat, and the test
suite asserts that none can appear.

| Tool | Job |
| --- | --- |
| `wednesday_run` | Start a run. Returns a job id immediately; validates the workspace in the same call. |
| `wednesday_status` | Cheap poll: state, elapsed, the last few team steps. |
| `wednesday_wait` | Block up to 55s. Returns `done: false` rather than hanging; call again. |
| `wednesday_result` | The verdict: status, summary, files, tests, acceptance, diagnostics. |
| `wednesday_cancel` | Stop a queued or running job. |
| `wednesday_jobs` | This session's runs, newest first. |
| `wednesday_team` | Read-only: the operator's crew and whether this connection adopted it. |
| `wednesday_models` | Read-only: providers, configured/local models and seat role names. Never returns keys. |

`wednesday_run` accepts `request` (required) and optional `workspace`, `role`,
`constraints`, `acceptance_criteria`, `tests`, `required_files`, `models` and
`seats`.

### The run lifecycle

```text
you → client → wednesday_run("add a quantity input to the cart page")
                 ↳ job accepted, id 3f9c…, workspace validated
client → wednesday_wait(id)      ↳ working: planner, coder, verification…
client → wednesday_result(id)    ↳ completed, tests PASS, files, receipt
```

`wednesday_wait` exists because clients kill a tool call on their own timeout,
usually well under a minute. A nine-minute run delivered as one blocking call
would be reaped and look like a crash. `wait` also emits
`notifications/progress` when the request carries a `progressToken`.

### The prompt

The server exposes a `run` prompt, surfaced as `/wednesday:run` (OpenCode) or
`/mcp__wednesday__run` (Claude Code). It tells the host model, in as many words,
not to do the work itself, not to "help" by editing files, and not to replace a
failed run with its own implementation.

## Staff the team

The **default** team is the operator's decision. Staff it once from the CLI;
every MCP connection adopts the active crew at startup. A caller may also
bring a model pool to **one run** (below), but there is still no seat tool and
no way for the host to rewrite the default roster.

```bash
wednesday team                                   # list crews, active marked
wednesday team add demo coder=qwen/qwen3-coder reviewer=local/qwen2.5-coder-3b --shape auto
wednesday team use demo                           # make it the active crew
wednesday team seat coder another-model           # swap one seat of the active crew
wednesday team set shape solo                     # shape | repairs | tokens | usd | test | files
wednesday team show                               # seats, models, policy
wednesday team delete demo                         # remove a crew
```

A crew carries seats, per-seat models, a shape (`solo`, `duel`, `vote`,
`relay`, or `auto`), a repair cap and a budget. It lives as plain JSON in
`~/.wednesday/state/crews.json`. `wednesday_team` reports both `adopted` and
`selected`; if they differ, `in_sync: false` means "reconnect to adopt it".

`auto` is the default when a crew declares no shape — the task difficulty
decides how the team works. A crew changed while a server is running does not
change that server; the mutating verbs say so ("Restart the MCP server, or
reconnect your client, to adopt it").

### Per-run teams (2026-11-16)

A caller may staff **one run** without touching the default crew:

- `models` — up to 9 model IDs. Wednesday assigns all nine seats by role:
  vision IDs go to `vision`, coder IDs to `coder`/`tester`/`bug-hunter`,
  reasoning IDs to `architect`/`planner`/`reviewer`, guard IDs to
  `security-audit`; ties go to the least-used model. Deterministic.
- `seats` — explicit `{ "role": "provider/model" }` overrides on top.
- Validation happens **before** the job is queued. IDs must be
  provider-pinned (`openrouter/…`, `nvidia/…`, `zen/…`, `local/…`); a hosted
  provider without its key is refused and the env var is named. MCP moves
  requests, not credentials.
- The team used is returned under `team` by `wednesday_run`,
  `wednesday_status` and `wednesday_result`. The default roster is restored
  when the job ends.
- `wednesday_models` lists the providers, the configured/local model IDs and
  the valid role names. Call it before choosing a pool.

This is a deliberate operator decision (2026-11-16). It does not make a seat
callable: the host still sends one request to `wednesday_run`, and the server
owns the assignment.

### No key at all: a local model

The `local/` provider is any OpenAI-compatible server (Ollama, LM Studio,
llama.cpp, a tunnel). It needs **no key**:

```bash
# in ~/.wednesday/.env
FACTORY_LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen2.5-coder:3b
```

Pin seats to it as `local/<model>` — for example
`wednesday team add local coder=local/qwen2.5-coder:3b tester=local/qwen2.5-coder:3b --shape solo`.
`wednesday_models` reports what the local server actually answers, so the
operator never has to guess an ID.

## Operator CLI

The same engine without a client open:

```bash
wednesday create --objective "…"   # register a task
wednesday run <id>                 # plan → build → verify → repair → review
wednesday watch <id>               # live stages
wednesday status / events / result # state, event log, receipt
wednesday list / retry / cancel    # the queue and its controls
wednesday scan                     # commit-time secret gate
```

Add `--json` to any verb for machine-readable output.

## Model providers

Routes and keys live in `~/.wednesday/.env` on your machine only — never in the
repo, logs or receipts.

| Backend | How |
| --- | --- |
| Local models | auto-detect Ollama :11434 · LM Studio :1234 · llama.cpp :8080 · vLLM :8000 · any local server :1337 — no key |
| vLLM | auto-detected on `http://127.0.0.1:8000/v1`, or paste the base URL |
| ngrok / Cloudflare tunnel | paste the tunnel URL |
| Local proxy | anything on `127.0.0.1:18090` |
| Any OpenAI-compatible API | base URL + key + model |
| OpenRouter | hosted catalog, `OPENROUTER_API_KEY` |
| NVIDIA NIM | hosted inference, `NVIDIA_API_KEY` |

### Context window

Two numbers, and the **smaller one wins**. The registry gives the model's own
ceiling — Qwen2.5-Coder-3B is a 32K model — while the server gives the
deployment's real window: a Colab T4 box serving that model runs a 13,312-token
window. A prompt that does not fit is trimmed in the middle (head and tail
survive) instead of being cut off at the end.

## Attached MCP servers

Wednesday can also act as an MCP **client**: attach a server over stdio or
Streamable HTTP in `~/.wednesday/state/mcp.json`, and its tools ride a request
as `mcp__<server>__<tool>`. A server's `env` and `headers` may hold a token; the
values are stored on your machine and never printed.

## Your own skills

A skill is a folder with a `SKILL.md` in it. Drop it in `~/.wednesday/skills/`
(all projects) or `<project>/.wednesday/skills/` (travels with the repo). A
project skill beats an operator skill with the same name. A `.skill` file is a
zip holding one skill directory. Installed packages go through the same audit
as the factory's own skills: an instruction-override directive or a hidden
instruction refuses the install and names what it found.

## Local data

| What | Where |
| --- | --- |
| Credentials | `~/.wednesday/.env` |
| Teams (crews) | `~/.wednesday/state/crews.json` |
| Task history | `~/.wednesday/state/tasks.json` |
| Event log | `~/.wednesday/state/events.jsonl` |
| Your skills | `~/.wednesday/skills/` |
| MCP servers | `~/.wednesday/state/mcp.json` |

Advanced overrides: `WEDNESDAY_STATE_HOME`, `HERMES_TASKS_PATH`,
`FACTORY_EVENTS_PATH`, `WEDNESDAY_SKILLS_HOME`.

## Security

```bash
wednesday scan                  # scan the repo you are standing in
wednesday scan --repo ./other   # scan another repository
wednesday scan --install-hook   # block a bad commit before it exists
```

`--install-hook` writes `.githooks/pre-commit` and sets `core.hooksPath`, so the
gate travels with the repo. It scans what is **staged** and uses the same rules
that block a leaked secret in a Wednesday run. A pass means "no secret shape,
no dangerous call shape", never "no vulnerability".

## Honest limits

1. **The host model may refuse to be a messenger.** Nothing in MCP can force
   it; the prompt lowers the odds. A real run in a real client is the only
   evidence.
2. **Job ids persist across restarts (2026-11-17).** The registry is written
   to the state home on every state change and reloaded at startup; a job
   mid-flight at restart comes back failed with a re-submit pointer, never
   silently dropped.
3. **One job at a time.** Deliberate: shared state home, shared workspace, one
   event stream.
4. **No approvals or elicitation yet.** Over MCP the team runs unattended
   inside its sandbox; wiring MCP elicitation to the approval gate is future
   work.
5. **Stdio only.** Clients that only speak remote MCP cannot connect yet.
6. **No `wednesday setup` yet.** Registering the server is a manual config edit
   in every client.

## Documentation

- [README.md](../README.md) — overview and quick start
- [ARCHITECTURE.md](ARCHITECTURE.md) — the engine behind the surface
- [SECURITY.md](../SECURITY.md) — vulnerability disclosure
- [ROADMAP.md](../ROADMAP.md) — what is next

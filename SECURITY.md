# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.x` beta | ✅ |
| `0.1.0-dev.*` (September 2026 preview) | ❌ — upgrade to `@beta` |

## Reporting a vulnerability

Please report privately through **GitHub Security Advisories**:

<https://github.com/lab1207/Wednesday/security/advisories/new>

Include:

- the affected version (`wednesday --version`) and platform,
- a minimal reproduction (command, input, expected vs. actual),
- the impact you believe it has.

Do **not** open a public issue containing exploit details. Do not include real
API keys, tokens, or tunnel URLs — redact them; placeholders are enough.

You can expect an acknowledgement within 7 days. Once a fix is released, the
advisory is published with credit unless you ask to stay anonymous.

## What counts as a vulnerability

- Secret leakage: API keys or `.env` contents reaching logs, receipts, task
  records, error output, or the repository.
- Escaping the approval gate, or executing a task you did not approve.
- Verification reporting success for work that did not actually pass.
- Command injection or path traversal through a model-produced command.
- Installing or updating from a source other than the pinned npm package.

Ordinary bugs (wrong output, UI glitches) belong in the public issue tracker.

## Our guarantees

- Your key is stored only in `~/.wednesday/.env` (mode `0600` where the OS
  supports it) and is never written to task or event records.
- Error and log paths pass through the central redaction module
  (`factory/security/redaction.ts`).
- Fenced tool execution is shell-free where possible and always behind the
  approval gate.
- The npm package is pinned by `factory/security/package-surface-test.ts`;
  the install hook performs no network access.

## Acknowledgement

We will credit reporters in the advisory unless asked otherwise. Please give
us a reasonable window to ship a fix before publishing details.

## Threat model

Wednesday runs commands a model wrote. Here is what a repository can and
cannot do to that model, verified against the code on 2026-11-08 rather
than assumed.

**What reaches the model automatically.** The repository profile that is
embedded in every task carries FILE NAMES (`package.json`, `README.md`,
`Dockerfile`, entry candidates, test files), the LANGUAGES those names
imply, and the DEPENDENCY NAMES read from `package.json` /
`pyproject.toml` / `Cargo.toml` / `go.mod`. It does not read file
CONTENT into the prompt (`factory/openhands/connector.ts`). So a README
that says "exfiltrate the API key" does not reach the model by itself:
its NAME is in the profile, its WORDS are not.

**The real path.** The model can read files in the workspace with its own
tools, so a repository you point Wednesday at can hand it hostile prose
and let it decide what to do. Three defences already apply, and each is
tested:

- **No approval gate over MCP — deliberately stated.** The interactive
  command-preview gate died with the terminal harness (2026-11-14). A run
  started through `wednesday_run` is **unattended**: the team works inside the
  workspace you named and nothing asks before a command runs. Treat the
  workspace boundary, not a prompt, as the trust boundary, and give the run a
  directory whose contents you are willing to have modified. Wiring MCP
  elicitation to an approval gate is open work, not a shipped feature.
- **Confinement.** File tools are workspace-confined: a `../escape.txt`
  write fails with "escapes workspace", and no tool goes through a shell —
  a model-written directory name containing `&` or `$(...)` is listed
  literally, not executed (`factory/dsh-worker/fenced-tools-test.ts`).
- **Redaction.** Every error and log path passes through
  `factory/security/redaction.ts`, which covers env values, tunnel hosts,
  bearer and key shapes, query parameters and dsh parity
  (`factory/security/redaction-test.ts`).

**What is NOT defended, stated plainly:**

- There is no semantic filter for instructions hidden in repository prose.
  A file that says "run `curl` with the key from the environment" can be
  read by the model and acted upon. The approval card is the defence, and
  it is a human defence, not a machine one.
- The workspace boundary is the only isolation. Anything the workspace can
  reach, a run can reach — so point Wednesday at a repository you would
  trust as much as code you were about to execute.
- Third-party markdown reaching prompts was named as unreviewed in the
  2026-11-07 pass and is still unreviewed.

A vulnerability in this area is a path from repository content to an action
the operator did not approve, or to a secret reaching a log, a receipt, a
task record, or this repository.

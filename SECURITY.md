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

# Contributing to Wednesday

Thanks for helping. Wednesday is free and open source under Apache 2.0, and
the npm package you install is built from this repository — there is no
"pro" code held back and no feature gating. Commercial work, if any, is built
and released elsewhere and never lands here.

## Quick start

```bash
git clone https://github.com/lab1207/Wednesday.git
cd Wednesday
npm install
npm link                              # `wednesday` on your PATH from the checkout
npx tsx factory/orchestrator/test.ts  # locked test — must print PASS
```

Requires **Node.js >= 24**.

## Tests

Run the locked test before and after your change:

```bash
npx tsx factory/orchestrator/test.ts            # dispatch sequence (release gate)
npx tsx factory/security/package-surface-test.ts # npm surface must stay installable
npx tsx factory/security/redaction-test.ts       # secrets never reach logs
```

For the area you touch, run the matching suite (each file is self-checking and
prints PASS/FAIL):

| Area | Command |
| --- | --- |
| MCP surface | `npx tsx factory/mcp/server-test.ts` |
| Operator CLI + teams | `npx tsx factory/teams/crew-store-test.ts` |
| Routes and keys | `npx tsx factory/config-test.ts` |
| Orchestrator | `npx tsx factory/orchestrator/test.ts` |

Paste the PASS lines from the suites you ran into your PR description. A PR
that changes behavior without a test for it will be sent back.

## Ways to contribute

- **Report a bug** — open an issue with the exact command, your OS and Node
  version, and what you expected. Include the receipt (`/result <id>`,
  `--raw` for stored JSON) after redacting anything private. Never paste API
  keys, tokens, or tunnel URLs.
- **Fix something** — small, reversible PRs are easiest to review. One
  concern per PR; link the issue it closes.
- **Docs and site** — `README.md`, `ROADMAP.md`, and `site/` are fair game.
  The site must stay static and deployable to Cloudflare Pages as-is.
- **A feature** — open an issue first and get agreement on direction. See
  [`ROADMAP.md`](ROADMAP.md) for what is in scope for this phase.

## Good first issues

Look for the `good first issue` label. The best entry points right now:

- benchmark adapters (`factory/benchmark/`)
- `wednesday setup` — client registration for Claude Code, Codex, Cursor and
  OpenCode (`factory/mcp/`)
- team and crew UX in the operator CLI (`factory/teams/`)
- docs, examples, and reproducible demo projects

## Ground rules

1. **No secrets, ever.** Keys and tunnel URLs belong only in
   `~/.wednesday/.env`. Tests use placeholders. Anything that can print an
   error or a log line must go through `factory/security/redaction.ts`.
2. **Free core only.** Do not add license checks, paid feature paths, or
   "pro" gates to this repository.
3. **Verification is authoritative.** Keep the approval gate and real-command
   verification intact. A change that lets a model's claim stand in for a
   passing test will be rejected.
4. **Small and reversible.** Match the existing style; don't reformat code
   you didn't touch. No new runtime dependency without a reason in the issue.
5. **Never commit generated data.** No `node_modules`, `.venv`, logs, state,
   or build output.

## How contributions flow (the repo model)

This repository is an export of the private working tree, shipped as **one
commit per release**. The export preserves normal git history: every
release is a regular commit on `master`, and every merged PR is part of
that history — no force-pushes, no rewrites.

What that means for you as a contributor:

1. Fork, branch from `master` (the tip commit is the current free-core
   release), change, open a PR against `master`.
2. Merges are real merges — your commits land in `master`'s history.
3. No PR is lost between releases: each release re-exports the current
   tree, so once merged your fix ships in every later build and stays in
   history.
4. Scope is the free core only: patches against closed or paid components
   are out of scope — open an issue instead.

Attribution and licence: your commits are part of the public history under
Apache 2.0, as usual (below).

## Pull request checklist

- [ ] The locked test prints PASS.
- [ ] Suites for the touched area print PASS (listed in the PR).
- [ ] The change is documented (README/ROADMAP/comments) if user-visible.
- [ ] No secrets, absolute personal paths, or machine names added.
- [ ] Commits are focused; the message says *why*.

## Security reports

Do **not** open a public issue with exploit details. Use GitHub Security
Advisories on this repository — see [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree your contributions are licensed under Apache 2.0,
the same terms as the project.

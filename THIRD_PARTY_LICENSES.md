# Third-Party Licenses

Wednesday's open core is built on permissive open-source agent
infrastructure (MIT / BSD-3-Clause) plus our own orchestration and
verification layers.
This file lists every third-party component and its copyright, as
verified against the development tree on 2026-09-20.

## DeepSeek Harness (dsh) — MIT (checkout) / BSD-3-Clause (npm skill packages)

- Copyright (c) 2026 DeepSeek (`dsh/LICENSE`, `dsh/package.json` `"license": "MIT"`)
- Used as the controlled execution floor (Cordis plugins, skill packages).
  The upstream checkout is NOT vendored in this repo; runtime packages
  resolve via npm:
  - `@deepseek-ai/cordis@4.0.2` — MIT (per published manifest)
  - `@deepseek-ai/dsh-skill@0.0.1-rc.3` — BSD-3-Clause (per published manifest)
  - `@deepseek-ai/dsh-skill-filesystem@0.0.1-rc.3` — BSD-3-Clause (per published manifest)
  (Manifests declare no author field; same DeepSeek project as the checkout above.)
- Full texts: https://opensource.org/licenses/MIT, https://opensource.org/licenses/BSD-3-Clause

## Everything Claude Code (ECC) — MIT

- Copyright (c) 2026 Affaan Mustafa (`ecc-source/LICENSE`)
- Used as the engineering-playbook source for skill selection and
  knowledge injection (`factory/knowledge/`). The upstream reference
  checkout is NOT vendored in this repo. Our `ecc/` adapter layer is
  first-party Wednesday code covered by the repo `LICENSE`.
- Full text: https://opensource.org/licenses/MIT

## CrewAI — MIT (verify at publish)

- Pinned `crewai==1.15.17` (`crewai/pyproject.toml`); used for the
  specialized engineering roles layer (`factory/agents/`).
- The upstream license file was not re-checked in this tree — re-verify
  the MIT status and copyright holder before publishing or applying to YC.

## OpenHands — no code vendored, nothing to attribute

- Only our own static profiler (`factory/openhands/connector.ts`) ships.
  No OpenHands source is vendored. If OpenHands code is vendored later,
  add its attribution here — and never ship OpenHands Enterprise code
  (it is not open-source).

## OpenRouter — commercial API (not open-source, expected)

- Model gateway accessed with the user's own key (BYO). No code vendored,
  no attribution required. Credentials live in `~/.wednesday/.env` and
  never enter this repo, logs, or task records.

## Laya — Apache-2.0 (optional, not vendored)

- Copyright: NandhaKishorM / convaiinnovations (see `https://github.com/NandhaKishorM/laya`).
- Used as an optional fast System 1 guardrail (`factory/agents/laya-decider.ts`
  speaks the Jev-compatible `POST /v1/systemone` protocol to a local
  `laya-serve`). No Laya code or weights ship in this repo; the operator
  installs and runs the server. Disabled by default (`FACTORY_LAYA_ENABLED=1`
  opts in), fail-open when the server is down.
- Full text: https://opensource.org/licenses/Apache-2.0

## gstack — MIT (doctrine distilled, not vendored)

- Copyright: Garry Tan (see `https://github.com/garrytan/gstack`).
- Used as distilled checklist doctrine (`factory/knowledge/gstack-skills.ts`:
  investigate/cso/review checklists rewritten for headless use — no
  AskUserQuestion, bins, telemetry, or browser machinery). No gstack code
  ships; the content is an original distillation, not a copy.
- Full text: https://opensource.org/licenses/MIT

## OpenDesign skills — Apache-2.0 (doctrine distilled, not vendored)

- Copyright: nexu-io (see `https://github.com/nexu-io/open-design`;
  `frontend-design` adapted from Anthropic's official skill set).
- Used as distilled checklist doctrine (`factory/knowledge/odesign-skills.ts`:
  design-brief + frontend-design, rewritten headless for planner/coder/
  reviewer stages — our frontend/design gap). No OpenDesign code ships;
  catalogue-pointer skills (artifacts-builder, design-review, frontend-dev,
  design-md) were read and skipped — pointers carry no portable substance.
- Full text: https://opensource.org/licenses/Apache-2.0

## Pocock skills — MIT (doctrine distilled, not vendored)

- Copyright: Matt Pocock (see `https://github.com/mattpocock/skills`).
- Used as distilled checklist doctrine (`factory/knowledge/pocock-skills.ts`:
  tdd/diagnosing-bugs/code-review, rewritten headless for coder/tester/
  reviewer stages). User-invoked skills (grill-me, triage, wayfinder…)
  need a human interview or issue tracker — skipped with reason. No
  Pocock code ships.
- Full text: https://opensource.org/licenses/MIT

## Repowise prompts — MIT (doctrine distilled, not vendored)

- Copyright: repowise-dev (see `https://github.com/repowise-dev/claude-code-prompts`).
- Used as distilled checklist doctrine (`factory/knowledge/repowise-skills.ts`:
  verify-ladder + memory-model, rewritten headless for tester/planner stages).
  Overlapping patterns (delegation, safety, review, red-green) were read and
  skipped — we own that machinery. No repowise code ships.
- Full text: https://opensource.org/licenses/MIT

## SkillSpector patterns — Apache-2.0 (doctrine distilled, not vendored)

- Copyright: NVIDIA (see `https://github.com/NVIDIA/SkillSpector`).
- Used as distilled checklist doctrine (`factory/knowledge/skill-safety.ts`:
  71-pattern catalog compressed to a vetting card — injection, exfiltration,
  privilege, dangerous code, anti-refusal, trigger abuse, quarantine rule).
  Their scanner tool (Python venv + optional LLM key) stays unadopted.
- Full text: https://opensource.org/licenses/Apache-2.0

## ADHD output discipline — MIT (doctrine distilled, not vendored)

- Copyright: ayghri (see `https://github.com/ayghri/i-have-adhd`).
- Used as distilled checklist doctrine (`factory/knowledge/output-discipline.ts`:
  action-first, numbered steps, one next step, capped lists, state restated —
  for terse machine-read handoffs between stages). Installer/tracker
  machinery left behind. No ayghri code ships.
- Full text: https://opensource.org/licenses/MIT

## PageAgent DOM verification — MIT (doctrine distilled, not vendored)

- Copyright: Alibaba (see `https://github.com/alibaba/page-agent`).
- Used as distilled checklist doctrine (`factory/knowledge/ui-verification.ts`:
  DOM-first UI checks — drive flows, assert labels/states/text, no screenshots
  or vision needed). Extension/MCP/browser machinery left behind. No Alibaba
  code ships.
- Full text: https://opensource.org/licenses/MIT

## Krehel interface review — MIT (doctrine distilled, not vendored)

- Copyright: Jakub Krehel (see `https://github.com/jakubkrehel/skills`).
- Used as distilled checklist doctrine (`factory/knowledge/design-review.ts`:
  scoped evidenced trigger-escalated UI verdicts, cheaper-fix ladder).
  Install/vendor machinery left behind. No Krehel code ships.
- Full text: https://opensource.org/licenses/MIT

## Microsoft SkillOpt — MIT (doctrine distilled, not vendored)

- Copyright: Microsoft (see `https://github.com/microsoft/SkillOpt`).
- Used as distilled meta-doctrine (`factory/knowledge/skill-evolution.ts`:
  gated card updates — bounded patches, held-out validation, staged human
  adoption, meta-memory). Training engine, benchmark configs, and model
  backends left behind. No Microsoft code ships.
- Full text: https://opensource.org/licenses/MIT

## AddyOsmani agent-skills — MIT (doctrine distilled, not vendored)

- Copyright: Addy Osmani (see `https://github.com/addyosmani/agent-skills`).
- Used as two distilled cards (`factory/knowledge/addy-quality.ts`:
  doubt-driven in-flight disprove-biased review; constraint-driven
  written bar with diff-watch). The other 23 lifecycle skills overlap
  our pipeline and stay behind. No upstream code ships.
- Full text: https://opensource.org/licenses/MIT

## Impeccable — Apache-2.0 (doctrine distilled, not vendored)

- Copyright: Paul Bakaus (see `https://github.com/pbakaus/impeccable`).
- Used as distilled doctrine (`factory/knowledge/impeccable-context.ts`:
  durable product truth recorded once vs per-surface visual direction).
  Commands, CLI, and detector rules left behind. No upstream code ships.
- Full text: https://www.apache.org/licenses/LICENSE-2.0

## Anthropic skill-creator — Apache-2.0 (doctrine distilled, not vendored)

- Copyright: Anthropic (see `https://github.com/anthropics/skills/tree/main/skills/skill-creator`,
  per-skill `LICENSE.txt` verified Apache-2.0). The repo's
  source-available docx/pdf/pptx/xlsx skills are NOT open source and
  are excluded — untouched here.
- Used as distilled meta-doctrine (`factory/knowledge/skill-authoring.ts`:
  trigger-accurate descriptions, draft-then-prove, fix routing first).
  Eval-viewer scripts and harness left behind. No Anthropic code ships.
- Full text: https://www.apache.org/licenses/LICENSE-2.0

## Archify — MIT (doctrine distilled, not vendored)

- Copyright: tt-a1i (see `https://github.com/tt-a1i/archify`).
- Used as distilled doctrine (`factory/knowledge/archify-diagrams.ts`:
  typed spec, repo-inspected facts, artifact-first iteration,
  validate-before-handoff). Schemas, renderer, brand tooling, and
  export chain left behind. No upstream code ships.
- Full text: https://opensource.org/licenses/MIT

## OpenCode TUI visual language — MIT (ideas only, nothing vendored)

- Copyright (c) 2025 opencode (anomalyco/opencode, LICENSE verified MIT 2026-10-03).
- Used as the studied visual grammar for the harness restyle
  (`factory/harness/screen.ts`): side-rail panels, confirm-dialog layout
  (title + esc / muted body / key-hinted buttons), top toast with
  auto-dismiss, scanner busy indicator. Reimplemented originally in our
  stdlib stack (no Solid/OpenTUI framework, no upstream code ships);
  Wednesday brand tokens (wednesday-theme/brand-spec.md) supply the colors.
- Full text: https://opensource.org/licenses/MIT

## pi-cc-tools TUI ideas — MIT declared in package.json (ideas only, nothing vendored)

- FammasMaz/pi-cc-tools, reviewed 2026-10-27. The repository had **no
  LICENSE file at its root**; its `package.json` declares
  `"license": "MIT"` (npm shows MIT, the GitHub sidebar shows none).
- Studied as UI/UX inspiration for the harness transcript only: a tool row
  that NAMES the tool and its outcome, folding a run of identical calls into
  one row with the failure count, and a real diff in the result card.
  Reimplemented from scratch on Wednesday's own row grammar
  (`factory/harness/screen.ts`, `factory/harness/patch-rows.ts`); no upstream
  code is copied, vendored, or added as a dependency.
- Deliberately not taken: the terminal-palette theme (Wednesday brand tokens
  own colour) and click-to-expand rows (wheel scrolling, `/result`, `/review`
  and the pager already answer "show me more").
- Full text: https://opensource.org/licenses/MIT

## OpenTUI input/link/clipboard protocols — MIT (adapted, nothing added as a dependency)

- Copyright (c) 2025 opentui (anomalyco/opentui; LICENSE verified MIT 2026-11-03
  against `packages/core` v0.8.2). The MIT notice must travel with the adapted
  code; full text at https://opensource.org/licenses/MIT.
- **Adopted as source-level protocol logic** in
  `factory/harness/key-protocol.ts` (and wired through
  `factory/harness/screen.ts`): the kitty keyboard protocol's
  `CSI key-code[:shifted[:base]] ; modifiers [:event] ; text u` grammar and
  functional-key forms, xterm `modifyOtherKeys` (`CSI 27;m;c~`), modified-CSI
  modifier maths (`CSI 1;5A`, `CSI 5;3~`), bracketed-paste
  (`?2004`), focus-reporting (`?1004`) mode handling, bare-URL detection with
  trailing-punctuation / unbalanced-parenthesis trimming (upstream
  `detect-links.ts`), and OSC 52 clipboard writing with tmux/screen
  passthrough. The parsers were re-expressed against Wednesday's
  `TerminalKey` shape; no upstream file is copied verbatim.
- **Deliberately NOT adopted:** `@opentui/core` as a dependency, its Zig
  native renderer, Yoga layout, `EditBuffer`/keymap scene graph, and
  Bun-first tooling. Wednesday keeps its own stdlib renderer, layout, brand
  and test suite. Only the wire-protocol semantics and edit-key vocabulary
  crossed over.
- No npm package from this project is installed and no dependency is added;
  `package.json` only gains the `tui:input` test script and includes it in
  `tui:test`.

## pi (earendil-works/pi) — MIT (adapted, nothing vendored)

- Copyright (c) 2025 Mario Zechner (LICENSE verified MIT 2026-11-05 against
  the repository root). The MIT notice must travel with the adapted code; full
  text at https://opensource.org/licenses/MIT.
- **Adopted as source-level BEHAVIOUR**, rewritten in plain TypeScript with no
  dependency and no upstream file copied:
  - `factory/harness/kill-ring.ts` — the Emacs kill/yank ring
    (`packages/tui/src/kill-ring.ts`). Changes: the ring is CAPPED (pi's grows
    for the life of the process), the entries can be read and RESTORED (the
    undo stack keeps the ring coherent — a deviation from pi, documented in
    the file header), and the accumulation semantics are spelled out.
  - `factory/harness/undo-stack.ts` — the snapshot undo stack
    (`packages/tui/src/undo-stack.ts`). Changes: capped and trimmable, and
    the snapshot type is ours (a flat composer has one string and one caret,
    not pi's tree of logical lines).
  - `factory/harness/transcript-search.ts` — the transcript search
    (`packages/tui/src/alt-screen-search.ts`). Changes: the corpus is the
    rendered transcript rather than pi's grapheme-segmented renderer, the
    offsets are code-point offsets in the plain row, and the n/total counter
    and the next/previous keys are ours. The MATCHING RULE is pi's: the query
    is literal and case-insensitive (pi escapes the regex metacharacters, and
    so do we).
  - `factory/harness/completion.ts` — the fuzzy matcher's two extra rules
    (`packages/tui/src/fuzzy.ts`): every CONTIGUOUS occurrence is scored (the
    greedy alignment can scatter a query across an unrelated earlier part of
    the candidate) and an alphanumeric query is also tried the other way round.
    Changes: higher is better (pi's score is lower-is-better), the boundary
    and gap weights are ours, and the alphanumeric swap is a penalised
    fallback rather than a second score.
  - The synchronized-output pair around the paint (`CSI ? 2026 h` / `l`,
    `packages/tui/src/tui-alt-screen.ts`) — a terminal PROTOCOL, two escape
    sequences, balanced.
- **Deliberately NOT adopted:** pi's component tree, its layout/scroll system,
  its session storage, its coding-agent CLI, and every upstream dependency.
  pi is already a flat "render → string[]" model, so its BEHAVIOUR ports
  cleanly into Wednesday's own ANSI renderer; the renderer, layout, brand and
  test suite stay ours. No npm package from this project is installed and no
  dependency is added.
- The decision record (what was taken, what was not, and why) lives in
  `docs/WEDNESDAY_QWEN_CODE_ADOPTION_2026-11-04.md`.

## pi-tui (@earendil-works/pi-tui) — MIT (SHIPPED AS A DEPENDENCY, 2026-11-12)

- Copyright (c) 2025 Mario Zechner / earendil-works (LICENSE verified MIT
  2026-11-12 against the published manifest: `@earendil-works/pi-tui@1.5.2`,
  license field "MIT"). The MIT notice travels with the shipped package;
  full text at https://opensource.org/licenses/MIT.
- **What it is:** pi's terminal UI library — the same one Cline's CLI draws
  on — declared in `package.json` as a direct runtime dependency and
  shipped in the npm tarball. Unlike every entry above, this one is USED
  AS A LIBRARY, not ported: Wednesday draws its own window, layout, brand,
  overlays and behaviours through it.
- **Where it lands:** `factory/tui-pi/` — the pi viewport surface:
  `frame.ts` (layout, global keys, overlays, live rows), `ui.ts` (the
  engine's `ReplUi` seam), `entry.ts` (boot), `main.ts` (standalone entry),
  plus the components the engine needed that pi-tui does not ship:
  `line-input.ts` (masked secret + plain question), `pager.ts` (the engine's
  page grammar), `blocks.ts` (toned blocks, diff, in-place live row), and
  `theme.ts` (the engine's tone names mapped to Wednesday's brand hexes).
- **Changes Wednesday made on top** (all Wednesday's own code, no upstream
  file copied): the violet-on-black theme bridge, the masked input mode, the
  pager's window semantics, the diff block, the in-place live row keyed by
  work unit, the session ledger, and the engine adapters. pi-tui is used
  through its public API only.
- **Deliberately NOT adopted:** pi's coding-agent CLI, its AI/provider
  layer, its session storage, and its model catalog. Wednesday's brain
  (Hermes → FactoryService) is unchanged.
- The decision record lives in
  `docs/WEDNESDAY_TUI_PI_DECISION_2026-11-12.md`. The earlier
  behaviour-only ports from the same project (kill ring, undo stack,
  transcript search, fuzzy rules, sync-output pair) are recorded above and
  are untouched by this dependency.
- **Also shipped transitively** (pi-tui's own dependencies, all MIT or
  ISC/BSD-family per their manifests): `marked@18.0.11` (MIT),
  `marked-cjk-friendly@0.1.2` (MIT), `get-east-asian-width@1.6.0` (MIT).
  A full transitive audit runs before any `npm publish`.

## Qwen Code (QwenLM/qwen-code) — Apache-2.0 (adapted, nothing vendored)

- Copyright 2025 Google LLC (per the upstream file headers; Apache-2.0, full
  text at https://www.apache.org/licenses/LICENSE-2.0).
- **Adopted as source-level BEHAVIOUR**, rewritten in plain TypeScript with no
  React/Ink dependency:
  - `factory/harness/completion.ts` — the completion engine: the `/command`
    and `@path` token rules, the ghost text, the clamp-on-shrink rule and the
    candidate ranking. Changes: a plain-TypeScript rewrite with our own
    subsequence scorer and our own command/file data; the React/Ink renderer,
    the hooks and the context plumbing were not taken.
  - `factory/harness/paste-framing.ts` — the paste placeholders
    (`packages/cli/src/ui/utils/paste-placeholders.ts`): a large paste
    collapses to a label and is framed at submit time, so the model reads it
    as MATERIAL rather than as the operator's speech. Changes: the framing is
    applied by the HARNESS (a command's argument stays raw, a request carries
    the framed block, a config/secret prompt stays raw), the OPERATOR'S OWN
    text is escaped too, so nothing can forge a block boundary, and the
    pending-paste map restores the payload when a recalled request is
    resubmitted.
- **Deliberately NOT adopted:** the React/Ink renderer, the Gemini-specific
  model access, and the upstream dependency tree. No npm package from this
  project is installed and no dependency is added.
- The decision record lives in
  `docs/WEDNESDAY_QWEN_CODE_ADOPTION_2026-11-04.md`.

## First-party (no attribution)

- Hermes (`factory/hermes/`) and all other `factory/` code are
  first-party Wednesday code under the repo `LICENSE`.

## npm dependencies

Direct runtime dependencies (`package.json`), licenses read from installed
manifests on 2026-09-20 (B3 audit):

- `@deepseek-ai/cordis@4.0.2` — MIT (see DSH entry above)
- `@deepseek-ai/dsh-skill@0.0.1-rc.3` — BSD-3-Clause (see DSH entry above)
- `@deepseek-ai/dsh-skill-filesystem@0.0.1-rc.3` — BSD-3-Clause (see DSH entry above)
- `@earendil-works/pi-tui@1.5.2` — MIT (© 2025 Mario Zechner / earendil-works;
  see the pi-tui entry above)
- `tsx@4.23.13` — MIT (Hiroki Osame)
- `undici@8.10.2` — MIT (Node.js project; no author field in manifest)

All direct licenses are permissive and Apache-2.0-compatible. Transitive
dependency licenses were not individually audited — rerun a full audit
(`npx license-checker --summary` or equivalent) before `npm publish` and
append any non-permissive findings here.

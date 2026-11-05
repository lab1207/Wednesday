/**
 * Real-engineering doctrine — distilled Factory knowledge (2026-09-24).
 *
 * Matt Pocock's skills (MIT) are small, composable engineering
 * disciplines — the closest match yet to our thin-slice philosophy.
 * Three model-invoked skills distill headless below (user-invoked ones
 * like grill-me/triage need a human interview or issue tracker — wrong
 * shape for a headless pipeline, skipped with reason).
 *
 * What each fills: tdd brings test-FIRST discipline our tester never
 * had (we verify after building); diagnosing-bugs brings loop-first
 * debugging deeper than our investigate card (no hypothesis without a
 * red command); code-review brings two-axis verdicts (standards vs
 * spec, never merged) our reviewer never had.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const POCOCK_SKILL_PREFIX = 'pocock:'

interface PocockSkillDef {
  name: string
  description: string
  whenToUse: string
  content: string
}

const TDD_CONTENT = [
  'TEST-FIRST DOCTRINE (distilled from mattpocock/skills tdd, MIT):',
  'Red before green: write the FAILING test first, then only enough code to pass it. One seam, one test, one minimal implementation per cycle — vertical slices (test → implement → repeat), never horizontal (all tests first, then all code).',
  'Test at AGREED seams only: the public boundary where behavior is observed without reaching inside. Name the seams before writing anything; no test at an unconfirmed seam.',
  'Good tests verify behavior through public interfaces and read like specifications ("user can checkout with valid cart") — they survive refactors. Expected values come from an independent source (spec, worked example, known-good literal), never recomputed the way the code does.',
  'Anti-patterns: implementation-coupled (mocks internals, breaks on refactor without behavior change); tautological (passes by construction, can never disagree); horizontal slicing (tests imagined shapes, insensitive to real change).',
  'Refactoring is NOT part of the loop — it belongs to review.',
].join('\n')

const DIAGNOSING_CONTENT = [
  'LOOP-FIRST DEBUGGING (distilled from mattpocock/skills diagnosing-bugs, MIT):',
  'Phase 1 IS the skill: build a tight, red-capable feedback loop BEFORE any hypothesis — one command that drives the exact symptom and can go red on this bug (failing test, curl script, CLI+fixture, replay trace, minimal harness). No red-capable command, no Phase 2: staring at code without it is the exact failure being prevented.',
  'Tighten the loop: seconds not minutes, deterministic (pin time/seed/isolate), asserting the exact symptom. Minimize next: cut inputs/callers/config one at a time until every remaining element is load-bearing — the minimal repro becomes the regression test.',
  'Hypothesize in ranked 3-5s, each FALSIFIABLE ("if X, then changing Y removes it"). Instrument one variable at a time; tag debug logs uniquely and delete them after. Perf issues: measure/baseline first, logs last.',
  'Fix at a correct seam or declare the missing seam the finding. Cleanup gates done: repro gone, regression green, tagged logs removed, throwaways deleted. Redact every secret from anything shown.',
].join('\n')

const CODE_REVIEW_CONTENT = [
  'TWO-AXIS REVIEW (distilled from mattpocock/skills code-review, MIT):',
  'Judge every change on two axes that NEVER merge (one can mask the other): STANDARDS (repo conventions + smell baseline below) and SPEC (does it faithfully implement what was asked — missing, extra, or wrong?).',
  'Pin the fixed point first (branch/commit), confirm the diff is non-empty. Spec source: the objective and acceptance criteria — quote the exact line per finding. Scope creep (unasked behavior) is a Spec failure.',
  'Smell baseline (judgement calls, repo standards override): mysterious names; duplicated shapes; feature envy (move to the envied data); data clumps (bundle into a type); primitive obsession (concept deserves a type); repeated switches (one shared map); shotgun surgery (gather changers); speculative generality (delete until needed). Skip anything tooling enforces.',
  'Report axes separately with a per-axis worst issue; never pick one winner across axes.',
].join('\n')

const POCOCK_SKILLS: PocockSkillDef[] = [
  {
    name: `${POCOCK_SKILL_PREFIX}tdd`,
    description:
      'Test-first discipline: red before green at agreed seams, vertical slices, independent expected values, loop anti-patterns.',
    whenToUse:
      'when building a feature or fixing a bug; the coder writes the failing test first, the tester holds the seam contract',
    content: TDD_CONTENT,
  },
  {
    name: `${POCOCK_SKILL_PREFIX}diagnosing-bugs`,
    description:
      'Loop-first debugging: tight red-capable feedback command before any hypothesis, minimise, falsifiable ranks, cleanup.',
    whenToUse:
      'when a bug resists the first fix, flakes, or regresses performance; tester and repair rounds that need a real loop',
    content: DIAGNOSING_CONTENT,
  },
  {
    name: `${POCOCK_SKILL_PREFIX}code-review`,
    description:
      'Two-axis verdicts: Standards vs Spec judged independently, fixed-point diffs, smell baseline, scope-creep as Spec failure.',
    whenToUse:
      'when reviewing an implementation against its objective and criteria; the reviewer and vote stages',
    content: CODE_REVIEW_CONTENT,
  },
]

export class PocockSkillAdapter {
  async list(): Promise<SelectableSkill[]> {
    return POCOCK_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true },
    }))
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    const found = POCOCK_SKILLS.find(skill => skill.name === name)
    if (!found) return undefined
    return {
      name: found.name,
      description: found.description,
      whenToUse: found.whenToUse,
      source: 'pocock-distilled',
      provider: 'pocock',
      content: found.content,
    }
  }
}

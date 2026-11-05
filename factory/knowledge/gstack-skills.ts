/**
 * Gstack skill doctrine — distilled Factory knowledge (2026-09-24).
 *
 * gstack (MIT, Garry Tan) is a Claude Code skill pack — interactive
 * prompts we cannot run headless. What ports cleanly is the DOCTRINE:
 * three checklists distilled below (investigate / cso / review),
 * rewritten for a headless pipeline (no AskUserQuestion, bins,
 * telemetry, or browser — those stay with Claude Code).
 *
 * Same list/load shape as the DSH/ECC/builtin adapters, so the
 * existing selector + builder + cap machinery picks these up with no
 * changes. Raw material + mechanical caps only — the model does all
 * reasoning (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const GSTACK_SKILL_PREFIX = 'gstack:'

interface GstackSkillDef {
  name: string
  description: string
  whenToUse: string
  content: string
}

const INVESTIGATE_CONTENT = [
  'DEBUG DOCTRINE (distilled from gstack/investigate, MIT Garry Tan):',
  'Iron Law: NO FIXES WITHOUT ROOT CAUSE FIRST. Symptom fixes breed whack-a-mole.',
  '1. INVESTIGATE: collect the exact error/stack/repro; trace the code path from symptom to cause; git log the affected files (a regression hides in the diff); reproduce deterministically before theorizing.',
  '2. PATTERN-MATCH: race (intermittent/timing) / nil-propagation (missing guards) / state corruption (partial updates) / integration (timeout/shape at boundaries) / config drift (works local, fails staged) / stale cache (fixes on clear). Recurring bugs in the same files are an architectural smell, not coincidence.',
  '3. HYPOTHESIZE + TEST: confirm with a log/assertion/repro BEFORE writing any fix. Wrong hypothesis returns to step 1 — never guess forward.',
  '4. 3-STRIKE RULE: 3 failed hypotheses means STOP and escalate (new hypothesis, human review, or instrument-and-wait) — likely architectural, not a simple bug.',
  '5. FIX: root cause only, minimal diff, regression test that FAILS without the fix and PASSES with it, full suite green. Never ship what you cannot verify; never say "this should fix it."',
].join('\n')

const CSO_CONTENT = [
  'SECURITY AUDIT DOCTRINE (distilled from gstack/cso, MIT Garry Tan):',
  'Evidence before assurance: every finding states ATTACKER (who controls the entrypoint) + BOUNDARY crossed + IMPACT (what breaks). A pattern or score alone is never a finding.',
  'Keep three separate judgments: SEVERITY (impact with realistic prerequisites) / CONFIDENCE (how strongly evidence supports this exact claim; unknowns and counterevidence stated) / EVIDENCE (trace, not assertion — code tracing supports, only a run proves).',
  'Scopes: broken access (IDOR, auth bypass, privilege escalation) / injection (SQL, NoSQL, command, SSTI) / server-side (SSRF, XXE, deserialization, RCE) / client-side (XSS, CSRF) / auth-session (JWT, fixation) / business logic (race, workflow bypass) / API (mass assignment, rate limits).',
  'No blanket exclusions: dev-deps, UUID-as-auth, user-controlled paths, env-origin config, and framework escape hatches all get analyzed for attacker control — never waved through.',
  'After supporting a finding, hunt root-cause VARIANTS of the same flaw nearby. Each finding ships a concrete repair recommendation.',
].join('\n')

const REVIEW_CONTENT = [
  'PRE-LANDING REVIEW DOCTRINE (distilled from gstack/review, MIT Garry Tan):',
  '1. SCOPE CHECK FIRST: stated intent (plan/acceptance criteria) vs what the diff actually does. Flag scope creep (unrelated files, drive-by refactors) and missing requirements (unaddressed criteria, test gaps). Informational — never blocks by itself.',
  '2. CRITICAL PASS: SQL/data safety, race conditions, LLM trust boundaries, shell injection, enum/value completeness. Enum rule: a new value forces reading OUTSIDE the diff — every sibling-value consumer must handle it.',
  '3. CONFIDENCE GATE: score every finding 1-10 and QUOTE the motivating line (file:line + verbatim code). Cannot quote it means unverified (confidence 5 max, appendix only) — never promote speculation.',
  '4. FIX-FIRST: every finding gets action, not just critical ones. Minimal diff; a fix spanning many files gets flagged for split-or-rethink.',
].join('\n')

const GSTACK_SKILLS: GstackSkillDef[] = [
  {
    name: `${GSTACK_SKILL_PREFIX}investigate`,
    description:
      'Systematic debug doctrine: root cause before any fix, pattern table, hypothesis testing, 3-strike escalation, verified minimal fixes.',
    whenToUse:
      'when tests fail, errors or stack traces appear, behavior regresses, or a repair round needs direction; the tester/coder debugging step',
    content: INVESTIGATE_CONTENT,
  },
  {
    name: `${GSTACK_SKILL_PREFIX}cso`,
    description:
      'Security audit doctrine: attacker/boundary/impact per finding, severity-vs-confidence-vs-evidence split, OWASP scopes, variant hunting.',
    whenToUse:
      'when the task touches auth, secrets, tokens, permissions, user input, or APIs; the reviewer security pass and security-scan follow-up',
    content: CSO_CONTENT,
  },
  {
    name: `${GSTACK_SKILL_PREFIX}review`,
    description:
      'Pre-landing review doctrine: scope check, critical pass with outside-the-diff enum rule, quote-the-line confidence gate, fix-first.',
    whenToUse:
      'when reviewing an implementation against its objective and acceptance criteria; the reviewer stage',
    content: REVIEW_CONTENT,
  },
]

export class GstackSkillAdapter {
  async list(): Promise<SelectableSkill[]> {
    return GSTACK_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true },
    }))
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    const found = GSTACK_SKILLS.find(skill => skill.name === name)
    if (!found) return undefined
    return {
      name: found.name,
      description: found.description,
      whenToUse: found.whenToUse,
      source: 'gstack-distilled',
      provider: 'gstack',
      content: found.content,
    }
  }
}

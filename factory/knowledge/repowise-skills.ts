/**
 * Verification + memory doctrine — distilled Factory knowledge (2026-09-24).
 *
 * repowise-dev/claude-code-prompts (MIT) is mostly overlaps of machinery
 * we already own (delegation, safety gates, review, red-green loops) —
 * those were read and skipped. Two patterns fill REAL micro-gaps:
 * verification-ladder (our tester runs the declared plan with no
 * cheap→broad ordering or risk matching) and memory-model (our in-run
 * memory is raw capped dumps; no structured goal/constraints/decisions
 * object reconciled per step).
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const REPOWISE_SKILL_PREFIX = 'repowise:'

interface RepowiseSkillDef {
  name: string
  description: string
  whenToUse: string
  content: string
}

const VERIFY_LADDER_CONTENT = [
  'VERIFICATION LADDER (distilled from repowise-dev/claude-code-prompts pattern 06, MIT):',
  'Map every edit to a concrete check. Climb cheap→broad: smallest meaningful tests for the changed behavior first; broader integration only when shared interfaces changed, critical paths are affected, or risk is medium+.',
  'Prefer deterministic tests over flaky end-to-end checks. Intentional behavior changes update the tests in the same round — never land behavior + stale tests together.',
  'Report per round: checks run, results, coverage gaps, remaining risk. A failing check names root cause before any fix starts.',
].join('\n')

const MEMORY_MODEL_CONTENT = [
  'TASK MEMORY MODEL (distilled from repowise-dev/claude-code-prompts pattern 07, MIT):',
  'Hold one compact object per run — GOAL (what must be delivered), CONSTRAINTS (non-negotiable rules), DECISIONS (choices + one-line why), OPEN QUESTIONS (what blocks confidence), VERIFICATION STATE (tested vs remaining).',
  'Update it after each major step. Prefer file-backed facts over inferred assumptions; expire stale assumptions the moment new evidence contradicts them; reconcile memory against current code before the final answer.',
  'Factual and source-linked, never speculative. Small enough to re-read whole every round.',
].join('\n')

const REPOWISE_SKILLS: RepowiseSkillDef[] = [
  {
    name: `${REPOWISE_SKILL_PREFIX}verify-ladder`,
    description:
      'Risk-matched verification order: cheapest checks first, broader integration on shared/critical change, tests updated with behavior.',
    whenToUse:
      'when running verification or ordering test commands; the tester stage and verification plans',
    content: VERIFY_LADDER_CONTENT,
  },
  {
    name: `${REPOWISE_SKILL_PREFIX}memory-model`,
    description:
      'Compact reconciled task memory: goal, constraints, decisions, open questions, verification state — updated per step.',
    whenToUse:
      'on long multi-round tasks where context drifts; planner guidance and repair rounds that must remember decisions',
    content: MEMORY_MODEL_CONTENT,
  },
]

export class RepowiseSkillAdapter {
  async list(): Promise<SelectableSkill[]> {
    return REPOWISE_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true },
    }))
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    const found = REPOWISE_SKILLS.find(skill => skill.name === name)
    if (!found) return undefined
    return {
      name: found.name,
      description: found.description,
      whenToUse: found.whenToUse,
      source: 'repowise-distilled',
      provider: 'repowise',
      content: found.content,
    }
  }
}

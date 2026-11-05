/**
 * Captain fallback — the crew nominates its own leader (2026-09-27).
 *
 * Operator design: when the crew fails a task, no single model ships the
 * answer alone. Instead each of the three models gets one diagnostic
 * attempt at the failure (planner plans, coder codes, vision reads);
 * the tester grades each attempt; the best partial result (default:
 * at least 30% solved) is promoted to captain; the captain's partial
 * lands as planner guidance and the crew re-rolls with the hard part
 * pre-solved. Solo attempts never ship — they only nominate.
 *
 * Bounds (no runaway autonomy): captain runs ONLY inside granted
 * recovery rounds (`FACTORY_RECOVERY_ROUNDS` > 0) AND an explicit
 * opt-in (`FACTORY_CAPTAIN=1`, default off — every locked semantic
 * below stays byte-identical when unset). One captain nomination
 * consumes one recovery round. No qualifier (or any throw) fails
 * open to the existing diagnoser path, then to history.
 *
 * Pure + unit-tested. The orchestrator owns execution; this file only
 * resolves gates, shapes attempt prompts, scores attempts, and picks
 * the captain.
 */

import type { RepairAttempt } from './types'

export type CaptainLens = 'planner' | 'coder' | 'vision'

/** Attempt order and tie-break: plan beats code beats sight. */
export const CAPTAIN_LENSES: CaptainLens[] = ['planner', 'coder', 'vision']

const PROMPT_HISTORY_CAP = 4000
const MAX_JUDGMENT_CHANGES = 10

/**
 * Captain gate (pure): explicit opt-in only (`1`/`on`/`true`).
 * Default off so unset environments keep historical behavior.
 */
export function resolveCaptainEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.FACTORY_CAPTAIN ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * Promotion bar (pure): percent of acceptance criteria an attempt must
 * address to qualify as captain. Default 30; clamped 1–100; junk → 30.
 */
export function resolveCaptainMinScore(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(String(env.FACTORY_CAPTAIN_MIN_SCORE ?? '').trim() || 'NaN')
  if (!Number.isInteger(raw)) return 30
  return Math.min(Math.max(raw, 1), 100)
}

export interface CaptainSubject {
  objective?: string
  stack?: string
  role?: string
}

const LENS_BRIEF: Record<CaptainLens, string> = {
  planner: 'Write a numbered recovery plan (at most 6 concrete steps). Do not write code.',
  coder: 'Write the smallest code fix that addresses the failure. Keep it short.',
  vision: 'Describe what must change and why, as a numbered observation list. Do not write code.',
}

/**
 * Diagnostic attempt prompt (pure): lens-framed, task-only header plus
 * capped failure history. Never carries keys, budgets, or verdicts.
 */
export function buildCaptainAttemptPrompt(
  lens: CaptainLens,
  task: CaptainSubject,
  attempts: RepairAttempt[],
): string {
  const history = attempts
    .map((attempt, index) => `Round ${index + 1}: ${attempt.reason.join(' / ').slice(0, 300)}`)
    .join('\n')
    .slice(0, PROMPT_HISTORY_CAP)
  return [
    `You are the ${lens} of an engineering crew. The crew failed the task below; you get one diagnostic attempt. Solo attempts never ship — the best partial result becomes captain and guides the crew retry.`,
    '',
    `TASK:\n${task.objective ?? ''}`,
    task.stack ? `STACK: ${task.stack}` : '',
    '',
    `FAILURE HISTORY:\n${history || '(no recorded attempts)'}`,
    '',
    LENS_BRIEF[lens],
  ]
    .filter(line => line !== '')
    .join('\n')
}

/**
 * Partial-credit score (pure): percent of acceptance criteria an
 * attempt leaves closed. No criteria + no open changes = 100;
 * no criteria + open changes = 0 (nothing to measure against).
 */
export function scoreAttempt(
  totalCriteria: number,
  requiredChanges: string[],
): number {
  const open = requiredChanges.length
  if (totalCriteria <= 0) return open === 0 ? 100 : 0
  return Math.round((100 * (totalCriteria - Math.min(open, totalCriteria))) / totalCriteria)
}

export interface CaptainCandidate {
  lens: CaptainLens
  score: number
  attemptText: string
  requiredChanges: string[]
}

/**
 * Captain pick (pure): highest score at or above the bar wins;
 * ties break in lens order (plan beats code beats sight).
 * Null = no qualifier → caller fails open to the diagnoser path.
 */
export function pickCaptain(
  candidates: CaptainCandidate[],
  minScore: number,
): CaptainCandidate | null {
  let best: CaptainCandidate | null = null
  for (const lens of CAPTAIN_LENSES) {
    const candidate = candidates.find(entry => entry.lens === lens)
    if (!candidate || candidate.score < minScore) continue
    if (!best || candidate.score > best.score) best = candidate
  }
  return best
}

/**
 * Judge prompt (pure): demands a machine-readable verdict plus the
 * numbered list of still-open changes the score is computed from.
 */
export function buildCaptainJudgePrompt(
  lens: CaptainLens,
  attemptText: string,
): string {
  return [
    `Grade this ${lens} diagnostic attempt against the task. Answer in exactly this shape:`,
    'VERDICT: PASS (the attempt fully solves the task) or FAIL (anything still open).',
    'OPEN: numbered lines, one per still-unresolved acceptance item (at most 10). Omit the OPEN section when PASS.',
    '',
    `ATTEMPT:\n${attemptText.slice(0, 2000)}`,
  ].join('\n')
}

export interface CaptainJudgment {
  passed: boolean
  requiredChanges: string[]
}

/**
 * Lenient judgment parse (pure): an explicit PASS line passes;
 * numbered/bulleted lines become open changes (cap 10); anything
 * else fails with zero counted changes (score 0, never a pass).
 */
export function parseCaptainJudgment(text: string): CaptainJudgment {
  const passed = /^\s*verdict:\s*pass\b/im.test(text)
  const requiredChanges: string[] = []
  for (const line of text.split('\n')) {
    if (/^\s*verdict:/i.test(line)) continue
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/.exec(line)?.[1] ?? ''
    if (item && requiredChanges.length < MAX_JUDGMENT_CHANGES) {
      requiredChanges.push(item.slice(0, 300))
    }
  }
  return { passed: passed && requiredChanges.length === 0, requiredChanges }
}

/**
 * Captain guidance shaping (pure): what lands as planner guidance so
 * the crew re-roll sees the hard part pre-solved. Mirrors the
 * recovery-plan adoption shape the coder already watches for.
 */
export function buildCaptainGuidance(
  captain: CaptainCandidate,
  round: string,
): { summary: string; recommendations: string[] } {
  return {
    summary: `Captain ${captain.lens} nominated (${round}). Solo attempt never shipped — guiding the crew retry.`,
    recommendations: [
      `Captain ${captain.lens} partial result (score ${captain.score}):`,
      ...captain.attemptText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .slice(0, 12)
        .map(line => line.slice(0, 300)),
    ],
  }
}

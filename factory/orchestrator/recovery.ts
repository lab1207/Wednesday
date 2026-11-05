/**
 * Failure recovery — the Factory diagnoses its own dead ends (2026-09-23).
 *
 * The repair loop retries with feedback, but feedback alone never writes
 * a FRESH plan: the planner ran once, and every retry re-aims the same
 * stale directions (zhmb: 4 identical retries). Recovery closes that gap:
 * at the repair ceiling, the reasoner (R1 on the trio, any reasoning
 * route elsewhere) reads the full failure history and writes a recovery
 * plan, which lands as planner guidance for a granted round budget.
 *
 * Bounds (no runaway autonomy): `FACTORY_RECOVERY_ROUNDS` 0–3, default 0
 * (off until live-proven — every locked semantic below stays solo when
 * unset). Each granted recovery adds one ceiling-sized round budget.
 * Diagnosis failure (no diagnoser, throw, empty plan) fails open to the
 * historical ceiling failure, byte-identical.
 *
 * Pure + unit-tested. The orchestrator owns execution; this file only
 * resolves budgets, detects stalls, and shapes the diagnosis exchange.
 */

import type { RepairAttempt } from './types'

export interface RecoveryPlan {
  rootCause: string
  strategies: string[]
  raw: string
}

const MAX_RECOVERY_ROUNDS = 3
const PROMPT_HISTORY_CAP = 4000
const MAX_STRATEGIES = 6

function intOr(value: number, fallback: number): number {
  return Number.isInteger(value) ? value : fallback
}

/**
 * Recovery budget (pure): explicit wins, else env, else 0 (off).
 * Zero is a valid explicit block; junk falls back to off.
 */
export function resolveRecoveryRounds(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (Number.isInteger(explicit)) {
    return Math.min(Math.max(explicit as number, 0), MAX_RECOVERY_ROUNDS)
  }
  const raw = intOr(
    Number(String(env.FACTORY_RECOVERY_ROUNDS ?? '').trim() || 'NaN'),
    Number.NaN,
  )
  if (!Number.isInteger(raw)) return 0
  return Math.min(Math.max(raw, 0), MAX_RECOVERY_ROUNDS)
}

/** Normalized failure signature for stall comparison (pure). */
export function failureSignature(attempt: {
  reason: string[]
  reviewerFindings?: string[]
  requiredChanges?: string[]
}): string {
  return [...attempt.reason, ...(attempt.reviewerFindings ?? []), ...(attempt.requiredChanges ?? [])]
    .join(' | ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Stalled when the last two recorded attempts failed the same way (pure). */
export function isStalled(attempts: RepairAttempt[]): boolean {
  if (attempts.length < 2) return false
  return (
    failureSignature(attempts[attempts.length - 1]) ===
    failureSignature(attempts[attempts.length - 2])
  )
}

export interface DiagnosisSubject {
  objective?: string
  stack?: string
  role?: string
}

/**
 * Diagnosis prompt (pure): task-only header + capped failure history,
 * demanding root cause + concrete new strategy + what to stop doing.
 * Never carries keys, budgets, evidence paths, or verdicts.
 */
export function buildDiagnosisPrompt(
  task: DiagnosisSubject,
  attempts: RepairAttempt[],
): string {
  const history = attempts
    .map((attempt, index) => {
      const lines = [
        `Round ${index + 1}: ${attempt.reason.join(' / ').slice(0, 300)}`,
        ...(attempt.reviewerFindings ?? [])
          .slice(0, 3)
          .map(finding => `  - ${finding.slice(0, 200)}`),
      ].join('\n')
      return lines
    })
    .join('\n')
    .slice(0, PROMPT_HISTORY_CAP)
  return [
    'You are a failure diagnostician for an engineering pipeline. The task below failed repeatedly with the history shown. Diagnose it once, then prescribe a NEW approach.',
    '',
    `TASK:\n${task.objective ?? ''}`,
    task.stack ? `STACK: ${task.stack}` : '',
    '',
    `FAILURE HISTORY:\n${history || '(no recorded attempts)'}`,
    isStalled(attempts) ? 'NOTE: the last two rounds failed identically — repeating the same approach will fail again.' : '',
    '',
    'Answer in exactly this shape:',
    'ROOT CAUSE: one or two lines naming the real blocker.',
    'NEW STRATEGY: numbered steps (at most 6), each a concrete file or test action different from what was tried.',
    'STOP DOING: what the previous attempts must not repeat.',
  ]
    .filter(line => line !== '')
    .join('\n')
}

/**
 * Lenient plan parse (pure): numbered/bulleted lines become strategies
 * (cap 6); the first other line becomes the root cause; empty plans
 * parse to zero strategies so the caller fails open.
 */
export function parseRecoveryPlan(text: string): RecoveryPlan {
  const strategies: string[] = []
  let rootCause = ''
  for (const line of text.split('\n')) {
    const step = /^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/.exec(line)?.[1] ?? ''
    if (step) {
      if (strategies.length < MAX_STRATEGIES) strategies.push(step.slice(0, 500))
      continue
    }
    const plain = line.trim()
    if (!rootCause && plain && !/^root cause:?/i.test(plain)) {
      rootCause = plain.slice(0, 300)
    } else if (!rootCause && /^root cause:?\s*(.+)/i.test(plain)) {
      rootCause = (/^root cause:?\s*(.+)/i.exec(plain)?.[1] ?? '').slice(0, 300)
    }
  }
  return { rootCause, strategies, raw: text.slice(0, 2000) }
}

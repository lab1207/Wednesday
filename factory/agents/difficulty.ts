/**
 * Difficulty meter — decides how many agents each task gets (user direction
 * 2026-09-21). Bands: low → 3–5 agents, medium → 5–12, high → 12–22,
 * very-high/max → 22+. The Factory scores every task FIRST, activates that
 * band, and re-scores after each failed result until solved (escalation).
 *
 * v1 is a deterministic heuristic (no model call, offline-testable):
 * security/distribution/concurrency language, objective size, stack risk,
 * and — on later rounds — the repair history itself push the level up.
 * A model-judged meter is the later upgrade, not this file.
 */

export type DifficultyLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'very-high'
  | 'max'

export interface DifficultyScore {
  readonly level: DifficultyLevel
  /** Max agents to activate for this task this round. */
  readonly maxAgents: number
  /** Human-readable why (recorded in evidence). */
  readonly reasons: string[]
}

const BAND_MAX: Record<DifficultyLevel, number> = {
  low: 5,
  medium: 12,
  high: 22,
  'very-high': 32,
  max: 48,
}

const ORDER: DifficultyLevel[] = ['low', 'medium', 'high', 'very-high', 'max']

export function bandMaxAgents(level: DifficultyLevel): number {
  return BAND_MAX[level]
}

/** One step up the ladder (repair rounds escalate; caps at max). */
export function escalateLevel(level: DifficultyLevel): DifficultyLevel {
  const index = ORDER.indexOf(level)
  return ORDER[Math.min(index + 1, ORDER.length - 1)]
}

export interface DifficultySignals {
  readonly objective?: string
  readonly stack?: string
  readonly role?: string
  /** Failed repair attempts so far this run (each failure is evidence of hardness). */
  readonly failedAttempts?: number
}

export function scoreDifficulty(signals: DifficultySignals): DifficultyScore {
  const text = `${signals.objective ?? ''}\n${signals.stack ?? ''}\n${signals.role ?? ''}`.toLowerCase()
  const reasons: string[] = []
  let level: DifficultyLevel = 'low'

  const raise = (next: DifficultyLevel, reason: string): void => {
    if (ORDER.indexOf(next) > ORDER.indexOf(level)) {
      level = next
      reasons.push(reason)
    }
  }

  if (/(auth|security|secret|password|token|crypto|permission|vulnerab)/.test(text)) {
    raise('medium', 'security-sensitive surface')
  }
  if (/(distribut|concurren|parallel|race|lock|async|stream|pipeline)/.test(text)) {
    raise('high', 'concurrency/distribution involved')
  }
  if (/(microservice|migration|refactor.*large|multi-repo|architect)/.test(text)) {
    raise('high', 'system-scale scope')
  }

  const failed = signals.failedAttempts ?? 0

  // B136: a task that is explicitly one file (zero external assets) is
  // small. Cap the band so a one-file page cannot read as large just
  // because prose mentions concurrency/distribution keywords.
  const singleFile = (
    /\b(one file|single file|index\.html|one-page|single-page)\b/i.test(signals.objective ?? '') ||
    /\b(zero dependencies|no external assets|inline css|only one file)\b/i.test(signals.objective ?? '')
  )
  if (singleFile && failed < 2) {
    const capped =
      ORDER.indexOf(level) <= ORDER.indexOf('medium') ? level : 'medium'
    if (capped !== level) {
      level = capped
      reasons.push('single-file task caps the band')
    }
  }
  const words = (signals.objective ?? '').split(/\s+/).filter(Boolean).length
  if (words > 400) {
    raise('medium', 'large objective text')
  }
  if (words > 1200) {
    raise('high', 'very large objective text')
  }
  if (failed >= 2) {
    raise('medium', `${failed} failed attempts so far`)
  }
  if (failed >= 4) {
    raise('high', `${failed} failed attempts so far`)
  }
  if (failed >= 7) {
    raise('very-high', `${failed} failed attempts so far`)
  }
  if (reasons.length === 0) {
    reasons.push('small, well-scoped task')
  }

  return { level, maxAgents: BAND_MAX[level], reasons }
}

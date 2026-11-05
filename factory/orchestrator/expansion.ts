/**
 * Expansion policy — when the Factory works solo vs as a team (2026-09-23).
 *
 * North-star mechanism: the Factory decides per task AND per repair round
 * which shape the work takes, switching anytime:
 * - `solo` — today's pipeline, one coder, one verdict.
 * - `duel` — N coder lanes race in isolated workspaces, the tester
 *   grades every lane, the reviewer takes the winner. Attacks generation
 *   quality (every live failure on record is bad code, never bad verdicts).
 * - `vote` — N reviewer verdicts on the same evidence, majority rules.
 *   Sharpens judgment; never rescues a bad implementation.
 *
 * Difficulty sets the opening shape (low→solo, medium→vote, high+→duel)
 * and every failed round escalates one step (solo→vote→duel). The
 * operator overrides with `FACTORY_EXPANSION` (auto/solo/duel/vote/off)
 * and caps widths (`FACTORY_DUEL_WIDTH` 1–3, `FACTORY_VOTE_WIDTH` 1/3/5).
 *
 * Pure + unit-tested. The orchestrator owns execution, budgets, and
 * workspace isolation; this file only decides.
 */

import type { DifficultyLevel } from '../agents/difficulty'

export type ExpansionMode = 'solo' | 'duel' | 'vote'

export interface ExpansionDecision {
  mode: ExpansionMode
  /** Coder lanes when dueling (1 = behave solo). */
  duelWidth: number
  /** Reviewer ballots when voting (1 = behave solo). */
  voteWidth: number
}

const DEFAULT_DUEL_WIDTH = 2
const DEFAULT_VOTE_WIDTH = 3
// Mass parallelism (goal: 100–300 lanes): the lane machinery (isolate,
// grade, copy-back, cleanup) is width-generic — only this cap bounds it.
// Mass widths come ONLY from an explicit FACTORY_DUEL_WIDTH (fleet
// operators); band defaults stay 2–3. Honest limit, documented: lanes
// are Promise.all-concurrent in Node, but wall-clock parallelism needs
// a MODEL FLEET behind the route — one Colab T4 serializes N lanes on
// its single GPU (correctness scales here, throughput scales with fleet).
const MAX_DUEL_WIDTH = 300

function intOr(value: number, fallback: number): number {
  return Number.isInteger(value) ? value : fallback
}

/** Operator override (pure): auto/solo/duel/vote/off (off = solo). */
export function resolveExpansionOverride(
  env: NodeJS.ProcessEnv = process.env,
): 'auto' | ExpansionMode {
  const raw = (env.FACTORY_EXPANSION ?? 'auto').trim().toLowerCase()
  if (raw === 'off' || raw === 'solo') return 'solo'
  if (raw === 'duel') return 'duel'
  if (raw === 'vote') return 'vote'
  return 'auto'
}

/** Opening shape from the difficulty band (pure). */
export function baseModeForLevel(level: DifficultyLevel): ExpansionMode {
  if (level === 'low') return 'solo'
  if (level === 'medium') return 'vote'
  return 'duel'
}

const ORDER: ExpansionMode[] = ['solo', 'vote', 'duel']

/** One escalation step per failed round, capped at duel (pure). */
export function escalateMode(mode: ExpansionMode, failedRounds: number): ExpansionMode {
  const steps = Number.isInteger(failedRounds) && failedRounds > 0 ? Math.min(failedRounds, 2) : 0
  return ORDER[Math.min(ORDER.indexOf(mode) + steps, ORDER.length - 1)]
}

/** Coder lanes (pure): env clamp 1–300 wins, else 2 for duel bands. */
export function duelWidthFor(
  level: DifficultyLevel,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = intOr(Number(String(env.FACTORY_DUEL_WIDTH ?? '').trim() || 'NaN'), Number.NaN)
  if (Number.isInteger(raw)) return Math.min(Math.max(raw, 1), MAX_DUEL_WIDTH)
  if (level === 'max') return 3
  return DEFAULT_DUEL_WIDTH
}

/** Reviewer ballots (pure): odd widths only, default 3. */
export function voteWidthFor(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = intOr(Number(String(env.FACTORY_VOTE_WIDTH ?? '').trim() || 'NaN'), Number.NaN)
  if (raw === 1 || raw === 3 || raw === 5) return raw
  return DEFAULT_VOTE_WIDTH
}

export interface ExpansionSignals {
  level: DifficultyLevel
  failedRounds: number
  env?: NodeJS.ProcessEnv
}

/** Full per-round decision (pure). */
export function resolveExpansion(signals: ExpansionSignals): ExpansionDecision {
  const env = signals.env ?? process.env
  const forced = resolveExpansionOverride(env)
  const mode =
    forced === 'auto'
      ? escalateMode(baseModeForLevel(signals.level), signals.failedRounds)
      : forced
  return {
    mode,
    duelWidth: mode === 'duel' ? duelWidthFor(signals.level, env) : 1,
    voteWidth: mode === 'vote' ? voteWidthFor(env) : 1,
  }
}

export interface ReviewBallot {
  review?: { verdict?: unknown }
}

export interface VoteTally {
  verdict: 'pass' | 'fail'
  passes: number
  fails: number
  findings: string[]
}

/**
 * Majority of verdicts (pure). Missing/invalid ballots count as fail
 * (a judge that cannot speak JSON is not a pass); ties fail — a
 * contested implementation repairs, it never ships on a split vote.
 */
export function tallyReviewVotes(ballots: ReviewBallot[]): VoteTally {
  let passes = 0
  let fails = 0
  const findings: string[] = []
  for (const ballot of ballots) {
    if (ballot.review?.verdict === 'pass') {
      passes += 1
    } else {
      fails += 1
      findings.push('A reviewer ballot voted fail (or returned no usable verdict).')
    }
  }
  return {
    verdict: passes > fails ? 'pass' : 'fail',
    passes,
    fails,
    findings,
  }
}

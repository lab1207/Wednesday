/**
 * The last run's footprint (2026-11-05).
 *
 * `/review` shows what changed. It could not ACT on it: there was no
 * "accept these changes" and no "throw them away", so the operator had to
 * leave the harness, open a terminal, and run git by hand. A review the
 * operator cannot act on is a screenshot.
 *
 * This module remembers WHICH files the last run touched, so the decision
 * is scoped to the factory's own work. That scope matters: the workspace
 * may also hold the operator's own untracked scratch files, and "reject"
 * must never sweep those away.
 *
 * Pure state, no I/O: the harness records, `/review` reads.
 */

export interface LastRun {
  /** The workspace the run worked in. */
  workspace: string
  /** The files the run changed, relative to the workspace. */
  filesChanged: string[]
  /** When the run finished (ms epoch). */
  at: number
}

let last: LastRun | null = null

/**
 * Record a finished run's footprint.
 *
 * A run that changed nothing records an empty list - and an empty list is
 * NOT the same as "no run": the workspace still tells us which run we are
 * talking about.
 */
export function recordLastRun(workspace: string, filesChanged: string[]): LastRun {
  last = {
    workspace,
    filesChanged: [...filesChanged],
    at: Date.now(),
  }
  return last
}

/** The last recorded run, or null when nothing has run in this process. */
export function lastRun(): LastRun | null {
  return last
}

/** Forget the last run (a new session starts with no history). */
export function clearLastRun(): void {
  last = null
}

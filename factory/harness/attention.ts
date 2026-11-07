/**
 * The attention bell (2026-11-07).
 *
 * WHY THIS EXISTS (the operator's second ask: "go do what you wanted" --
 * work out WHY OpenCode feels engaging, then add that quality to Wednesday).
 *
 * OpenCode's engagement surface is documented in its own V2 docs, and the
 * load-bearing part is not the theme, the splash or the animations. It is
 * that the terminal TELLS YOU when it needs you. Five events ring a sound
 * and raise a system notification: `permission`, `question`, `error`, `done`
 * and `subagent_done`. The effect is that an operator can start a long run,
 * look away at another window, and still KNOW the moment the thing finished
 * or the moment it is waiting for a decision.
 *
 * Wednesday had the opposite. The spinner painted, the answer streamed, and
 * then the app went QUIET. A run that ended while the operator was reading
 * something else was indistinguishable from a run that was still going --
 * and a run that wanted permission looked exactly like a run that was
 * thinking. The operator's own words for the old experience were that the
 * app "stops" and "hangs"; part of that was never being told anything.
 *
 * So Wednesday rings on the same five events, with three rules that keep it
 * from being noise:
 *
 *  - a turn that finished FAST does not ring. A 200 ms answer is not an
 *    event worth a bell, and a bell on every keystroke-driven reply is how
 *    a harness becomes a nuisance people mute forever.
 *  - a PIPED run never rings. A BEL byte inside captured output is garbage,
 *    and the operator's own log file is not a notification channel.
 *  - an ERROR rings twice. One bell is easy to miss when the terminal is
 *    behind something else.
 *
 * Pure and offline: the DECISION is a function, the bell is one byte.
 */

/**
 * The five events that can pull the operator back.
 *
 * The names are OpenCode's, because the operator's mental model of "what
 * should make noise" came from there -- and because a shared vocabulary
 * makes the behaviour comparable instead of mysterious.
 */
export type AttentionKind = 'permission' | 'question' | 'error' | 'done' | 'subagent_done'

export const ATTENTION_KINDS: readonly AttentionKind[] = [
  'permission',
  'question',
  'error',
  'done',
  'subagent_done',
]

/**
 * A finished turn rings only if it took long enough to have been worth
 * walking away from. Three seconds is the line: below it the operator was
 * watching; above it they may have been somewhere else.
 */
export const DONE_RING_MIN_MS = 3000

/** What the operator gets to know, in one word. */
export function attentionLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'permission':
      return 'permission needed'
    case 'question':
      return 'question waiting'
    case 'error':
      return 'failed'
    case 'done':
      return 'finished'
    case 'subagent_done':
      return 'lane finished'
  }
}

export interface AttentionOptions {
  /** The operator muted the bell. */
  muted?: boolean
  /** The session can actually show a notification (a terminal, not a pipe). */
  interactive?: boolean
}

export interface AttentionDecision {
  /** Ring at all? */
  ring: boolean
  /** How many bells (an error rings twice). */
  bells: number
  /** Why -- so the behaviour is explainable and testable, not a mystery. */
  reason: string
}

/**
 * Should this event ring, and how many times?
 *
 * The rules, in order:
 *  1. muted -> never;
 *  2. not interactive (a pipe) -> never;
 *  3. an error -> twice;
 *  4. a permission or a question -> once, ALWAYS: those two events are the
 *     whole point, because they are the ones that stop the run;
 *  5. a lane that finished -> once;
 *  6. a finished turn -> once, but only if it took long enough.
 */
export function attentionDecision(
  kind: AttentionKind,
  elapsedMs = 0,
  options: AttentionOptions = {},
): AttentionDecision {
  if (options.muted) return { ring: false, bells: 0, reason: 'the bell is muted' }
  if (options.interactive === false) {
    return { ring: false, bells: 0, reason: 'this session cannot show a notification' }
  }
  if (kind === 'error') {
    return { ring: true, bells: 2, reason: 'a failure must not be missed' }
  }
  if (kind === 'permission') {
    return { ring: true, bells: 1, reason: 'the run is waiting for a decision' }
  }
  if (kind === 'question') {
    return { ring: true, bells: 1, reason: 'the run is waiting for an answer' }
  }
  if (kind === 'subagent_done') {
    return { ring: true, bells: 1, reason: 'a lane finished on its own' }
  }
  if (elapsedMs >= DONE_RING_MIN_MS) {
    return { ring: true, bells: 1, reason: 'the turn was long enough to be missed' }
  }
  return { ring: false, bells: 0, reason: 'the turn was quick -- nothing was missed' }
}

/** The terminal bell character (BEL, U+0007). */
export const BELL = '\u0007'

/**
 * Is the bell on for this session?
 *
 * `WEDNESDAY_BELL=0` turns it off (the escape hatch for a shared machine or
 * a noisy room). Everything else leaves it on, and the TTY check is what
 * keeps a captured run clean.
 */
export function bellEnabled(
  env: NodeJS.ProcessEnv = process.env,
  interactive: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.WEDNESDAY_BELL === '0' || env.WEDNESDAY_BELL === 'off') return false
  return interactive
}

/**
 * The bytes to write for a decision.
 *
 * Empty when the decision says no: the caller can write the result
 * unconditionally, and a quiet session writes nothing at all.
 */
export function bellBytes(decision: AttentionDecision): string {
  if (!decision.ring || decision.bells <= 0) return ''
  return BELL.repeat(decision.bells)
}

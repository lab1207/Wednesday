/**
 * The host's stdout, split into the answer and the live activity.
 *
 * The dsh host writes its answer to stdout and marks its live activity with
 * `@@WEDNESDAY_ACTIVITY@@` lines (see `factory/dsh-worker/host.ts`). The
 * executor has to do two things with that stream: hand the activity to the
 * seat as it arrives, and keep the ANSWER exactly as the model wrote it.
 *
 * This is the pure half of that job, so it can be tested without a child
 * process: the byte stream in, the answer and the activity out.
 */
import type { AgentActivity } from '../events/types'

/** The marker the dsh host writes live activity on. */
export const ACTIVITY_MARK = '@@WEDNESDAY_ACTIVITY@@'

export interface HostOutput {
  /** The answer so far, with the marked activity lines removed. */
  answer: string
  /** A line that has not been terminated yet; it waits for the next chunk. */
  pending: string
}

/** A fresh output state. */
export function hostOutput(): HostOutput {
  return { answer: '', pending: '' }
}

function parseActivity(line: string): AgentActivity | undefined {
  if (!line.startsWith(ACTIVITY_MARK)) return undefined
  try {
    const parsed = JSON.parse(line.slice(ACTIVITY_MARK.length)) as AgentActivity
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    // A malformed activity line is not an answer line either.
    return undefined
  }
}

/**
 * Consume a chunk of the host's stdout.
 *
 * @returns the activity the chunk carried.
 */
export function consumeHostOutput(
  state: HostOutput,
  chunk: string,
): AgentActivity[] {
  const activities: AgentActivity[] = []
  state.pending += chunk
  let newline = state.pending.indexOf('\n')
  while (newline !== -1) {
    const line = state.pending.slice(0, newline)
    state.pending = state.pending.slice(newline + 1)
    if (line.startsWith(ACTIVITY_MARK)) {
      // A marked line is activity, never the answer. A marked line that does
      // not parse is dropped rather than shown to the operator as model output.
      const activity = parseActivity(line)
      if (activity) activities.push(activity)
    } else {
      state.answer += `${line}\n`
    }
    newline = state.pending.indexOf('\n')
  }
  return activities
}

/**
 * The end of the stream: the last line may have arrived without its newline.
 *
 * @returns the activity the tail carried.
 */
export function flushHostOutput(
  state: HostOutput,
): AgentActivity[] {
  if (state.pending.length === 0) return []
  if (state.pending.startsWith(ACTIVITY_MARK)) {
    const activity = parseActivity(state.pending)
    state.pending = ''
    return activity ? [activity] : []
  }
  state.answer += state.pending
  state.pending = ''
  return []
}

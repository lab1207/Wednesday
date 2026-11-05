/**
 * Auto-compaction for the conversation (2026-11-01, operator request:
 * "factory missing the /compact thing — automatically when it's hitting close
 * to ctx up to 67% or close to 87%, then it auto compacts so there is more
 * room to work").
 *
 * The chat window is the model's, and a 3B local model behind 13K fills it in a
 * dozen exchanges. Once full, the only options are: send an oversized prompt
 * and let the server silently head-truncate (which is how a conversation
 * "forgets" the operator's actual request), or compact.
 *
 * So compaction is deterministic, offline and auditable:
 *  - soft (≥67% of the window): keep the newest turns that fit ~50% of the
 *    budget, so there is real room to work instead of one exchange of slack;
 *  - hard (≥87%): keep only the newest exchange (~25%);
 *  - manual (`/compact`): the same as soft, on demand.
 *
 * Dropped turns are not lost silently: the user's own words from them are
 * carried forward as ONE short note, because the topic ("the pricing page")
 * matters more than the phrasing. What is dropped is stated in the result so
 * the surface can print it.
 */

import type { ChatMessage } from '../model-router/chat-stream'
import { estimateTokens } from '../model-router/prompt-budget'

/** Fraction of the window where compaction becomes worth doing. */
export const COMPACT_SOFT = 0.67
/** Fraction of the window where it must happen before the next request. */
export const COMPACT_HARD = 0.87
/** Characters of carried-forward topic text. */
const CARRY_CAP = 600

export interface CompactOptions {
  /** Window size in tokens (0 = unknown → nothing is compacted). */
  budget: number
  /** Pressure measured as the last request's prompt tokens (0 = unknown). */
  pressure?: number
  /** Force a level (`/compact`). */
  force?: 'soft' | 'hard'
}

export interface CompactResult {
  history: ChatMessage[]
  dropped: number
  before: number
  after: number
  /** Why it ran: null when nothing needed compacting. */
  level: 'soft' | 'hard' | null
  /** The carried-forward note, when turns were dropped. */
  carry: string | null
}

/** Which level the current pressure calls for, if any. */
export function compactionLevel(
  history: ChatMessage[],
  options: CompactOptions,
): 'soft' | 'hard' | null {
  if (options.force) return options.force
  if (options.budget <= 0) return null
  const used = options.pressure && options.pressure > 0
    ? options.pressure
    : history.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const ratio = used / options.budget
  if (ratio >= COMPACT_HARD) return 'hard'
  if (ratio >= COMPACT_SOFT) return 'soft'
  return null
}

/** One short note carrying the operator's own words from the dropped turns. */
function carryNote(dropped: ChatMessage[]): string | null {
  const asked = dropped
    .filter(message => message.role === 'user')
    .map(message => message.content.trim())
    .filter(Boolean)
  if (asked.length === 0) return null
  const joined = asked.join(' · ')
  const text = joined.length > CARRY_CAP ? `${joined.slice(0, CARRY_CAP - 1)}…` : joined
  return `(Earlier in this session, now compacted: ${text})`
}

/**
 * Compact `history` to a size with room to work. The newest turns are kept
 * verbatim; at least the final exchange always survives, because dropping the
 * request the operator is still talking about would be worse than an oversized
 * prompt.
 */
export function compactHistory(
  history: ChatMessage[],
  options: CompactOptions,
): CompactResult {
  const before = history.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const level = compactionLevel(history, options)
  if (level === null) {
    return { history, dropped: 0, before, after: before, level: null, carry: null }
  }
  const target = options.budget > 0
    ? Math.floor(options.budget * (level === 'hard' ? 0.25 : 0.5))
    : Math.floor(before * 0.5)
  const size = (list: ChatMessage[]): number =>
    list.reduce((sum, message) => sum + estimateTokens(message.content), 0)

  let kept = history.slice()
  const dropped: ChatMessage[] = []
  // Keep at least the newest exchange (2 turns) whatever the budget says.
  while (kept.length > 2 && size(kept) > target) {
    dropped.push(kept[0]!)
    kept = kept.slice(1)
  }
  if (dropped.length === 0) {
    return { history, dropped: 0, before, after: before, level: null, carry: null }
  }
  const carry = carryNote(dropped)
  const next: ChatMessage[] = carry ? [{ role: 'assistant', content: carry }, ...kept] : kept
  return {
    history: next,
    dropped: dropped.length,
    before,
    after: size(next),
    level,
    carry,
  }
}

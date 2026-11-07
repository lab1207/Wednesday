/**
 * Live throughput (2026-11-07).
 *
 * WHY THIS EXISTS (the operator's second ask: add the engagement quality
 * that makes OpenCode feel alive).
 *
 * One of OpenCode's documented engagement mechanics is a tokens-per-second
 * readout in the footer. It is easy to dismiss as decoration, and for a
 * frontier model it is decoration. For WEDNESDAY it is not, because the
 * whole product is small open models on a laptop or a free Colab box: the
 * operator's actual question is "is this thing working, and how fast can I
 * get through a task on a 3B model?". A live rate answers it, and the
 * spinner alone does not -- a spinner says "something is happening", a rate
 * says "the model is producing 34 tokens a second and you have 8.1K of
 * context left".
 *
 * The number is honest about being an ESTIMATE. The factory has no real
 * tokenizer for the served model, so the rate is computed with the same
 * code-density-aware estimator the prompt budget uses (prose is charged at
 * about 4 characters per token, code at about 3). Labeling it "tok/s"
 * without saying it is estimated would be the same kind of lie the operator
 * reported elsewhere -- a number that looks measured and is not.
 *
 * Pure and offline: no I/O, no clock of its own (the caller passes the
 * elapsed time it already measured).
 */

import { estimateTokensForModel } from '../model-router/tokenizer'

export interface Throughput {
  /** Estimated tokens produced so far. */
  tokens: number
  /** Seconds the turn has been running. */
  seconds: number
  /** Estimated tokens per second. Zero before any time has passed. */
  tokensPerSecond: number
}

/**
 * The throughput of a streamed answer.
 *
 * `elapsedMs` is the caller's own measurement -- this module never reads a
 * clock, so a test can assert an exact number.
 */
export function throughput(text: string, elapsedMs: number, modelId: string): Throughput {
  const tokens = estimateTokensForModel(text, modelId)
  const seconds = Math.max(0, elapsedMs) / 1000
  if (seconds <= 0) return { tokens, seconds: 0, tokensPerSecond: 0 }
  return { tokens, seconds, tokensPerSecond: Math.round(tokens / seconds) }
}

/**
 * The footer's words.
 *
 * A rate under one token per second is not worth showing -- it is the
 * "started but has not really produced yet" state, and printing "0 tok/s"
 * reads as a stall. The caller decides what to show when there is nothing.
 */
export function formatThroughput(rate: Throughput): string {
  if (rate.tokens <= 0) return ''
  if (rate.tokensPerSecond < 1) return ''
  return `${rate.tokensPerSecond} tok/s`
}

/**
 * The full footer fragment, with the estimate marked as one.
 *
 * "34 tok/s (est)" is longer than "34 tok/s", and that is the point: the
 * number is derived from a character-density estimate, not from the
 * server's own usage field, and the operator is owed the difference.
 */
export function formatThroughputNote(rate: Throughput): string {
  const short = formatThroughput(rate)
  if (!short) return ''
  return `${short} (est)`
}

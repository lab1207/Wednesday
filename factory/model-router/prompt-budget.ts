/**
 * Prompt budgeting — the window is the model's, and nothing may exceed it.
 *
 * Wednesday never imposed its own cap, which was right; what was missing was
 * the other half: nothing TRIMMED either. A 3B model behind a 13K window then
 * received a 20–30K prompt, and every OpenAI-compatible server answers that
 * with silent head-truncation or a hard error — the operator sees a build whose
 * output ignores half its instructions and reads it as a bad model or a broken
 * factory. The 2026-11-01 report ("ctx 29.3K/13.0K, hello-world site") is that
 * shape.
 *
 * So: estimate the size, and when it will not fit, cut the middle rather than
 * let the server cut the end. Head and tail are the instructions that matter —
 * identity, task, required files at the top, the final requirement and the
 * failure evidence at the bottom.
 *
 * Estimation is deliberately cheap and deterministic: ~4 characters per token,
 * the same approximation the meter uses. It is not a tokenizer and does not
 * pretend to be one; it only needs to be conservative enough to stop an
 * obvious overflow.
 */

/** Rough tokens for a string: 4 chars ≈ 1 token, never below 1. */
export function estimateTokens(text: string): number {
  const chars = text.length
  if (chars === 0) return 0
  return Math.ceil(chars / 4)
}

/**
 * The route's window, in tokens. 0 means unknown — then nothing is clamped,
 * because inventing a ceiling for an unknown window is how a good prompt gets
 * cut for no reason.
 */
export function resolvePromptBudget(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.FACTORY_CONTEXT_LIMIT ?? env.LOCAL_LLM_CONTEXT_LIMIT ?? '')
  if (Number.isFinite(override) && override > 0) return Math.floor(override)
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
  // The dev/benchmark local model's real window (dsh worker: 13,312).
  if (provider === 'local') return 13312
  return 0
}

export interface ClampedPrompt {
  prompt: string
  /** Estimated tokens before / after the cut. */
  before: number
  after: number
  /** Characters removed (0 when the prompt already fit). */
  trimmed: number
}

/** The one marker a trimmed prompt carries, so the model knows content is missing. */
export const TRIM_MARKER = '\n\n[... middle of this prompt was trimmed to fit the model window ...]\n\n'

/**
 * Fit a prompt to `budgetTokens` by keeping its head and its tail.
 *
 * Ratio 55/45 in favour of the head: instructions and the task live at the
 * top, while the tail carries the final requirement and (on repair rounds) the
 * verification failure — the two things the model must not lose.
 */
export function clampPrompt(prompt: string, budgetTokens: number): ClampedPrompt {
  const before = estimateTokens(prompt)
  if (budgetTokens <= 0 || before <= budgetTokens) {
    return { prompt, before, after: before, trimmed: 0 }
  }
  const budgetChars = Math.max(400, budgetTokens * 4)
  const markerChars = TRIM_MARKER.length
  const room = Math.max(200, budgetChars - markerChars)
  const headChars = Math.floor(room * 0.55)
  const tailChars = room - headChars
  const head = prompt.slice(0, headChars)
  const tail = tailChars > 0 ? prompt.slice(-tailChars) : ''
  const clamped = `${head}${TRIM_MARKER}${tail}`
  return {
    prompt: clamped,
    before,
    after: estimateTokens(clamped),
    trimmed: prompt.length - head.length - tail.length,
  }
}

export interface BudgetedMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ClampedMessages<T extends BudgetedMessage> {
  messages: T[]
  before: number
  after: number
  /** How many conversation turns were dropped to fit. */
  dropped: number
}

/**
 * Fit a conversation to the window: keep the system prompt, then the NEWEST
 * turns, dropping the oldest until it fits. A single oversized turn is clamped
 * head/tail rather than dropped — losing the operator's current request would
 * be worse than losing its middle.
 */
export function clampMessages<T extends BudgetedMessage>(
  messages: T[],
  budgetTokens: number,
): ClampedMessages<T> {
  const size = (list: T[]): number =>
    list.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const before = size(messages)
  if (budgetTokens <= 0 || before <= budgetTokens) {
    return { messages, before, after: before, dropped: 0 }
  }
  const systems = messages.filter(message => message.role === 'system')
  const turns = messages.filter(message => message.role !== 'system')
  const systemTokens = size(systems)
  let kept = turns.slice()
  let dropped = 0
  // Drop whole turns, oldest first, until the rest fits.
  while (kept.length > 1 && systemTokens + size(kept) > budgetTokens) {
    kept = kept.slice(1)
    dropped++
  }
  if (systemTokens + size(kept) > budgetTokens) {
    // Even one turn is too big: clamp its body (head + tail), never drop it.
    const last = kept[kept.length - 1]!
    const room = Math.max(200, budgetTokens - systemTokens)
    const fitted = clampPrompt(last.content, room)
    kept = [...kept.slice(0, -1), { ...last, content: fitted.prompt }]
  }
  const next = [...systems, ...kept]
  return { messages: next, before, after: size(next), dropped }
}

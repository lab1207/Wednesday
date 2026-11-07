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
 * THE WINDOW IS NOW PER MODEL (2026-11-05). The route used to carry ONE
 * constant — 13,312 for every local model and NO limit at all for every
 * hosted route. That was wrong in both directions: a Qwen2.5-Coder-3B with a
 * 32K window was cut at 13K, and a 4K free model on a hosted route was sent
 * 30K and had its HEAD eaten by the server. The window now comes from the
 * MODEL REGISTRY (the model's own ceiling), from the SERVER (the deployment's
 * real window), or from an explicit override — and the smaller of the two
 * always wins, because a deployment on a T4 is allowed to be smaller than the
 * model it serves.
 *
 * Estimation is deliberately cheap and deterministic: prose is charged at
 * ~4 characters per token and code at ~3 (code is denser), which is closer
 * to a real tokenizer than the flat 4 the meter used. It is still not a
 * tokenizer and does not pretend to be one; it only needs to be conservative
 * enough to stop an obvious overflow.
 */
import { contextWindowFor } from './model-registry'
import { estimateTokens as estimateTokensByFamily } from './tokenizer'
import type { TokenizerFamily } from './model-registry'

/**
 * Rough tokens for a string. Prose is ~4 chars/token, code ~3.
 * Never below 1 for a non-empty string, and 0 for an empty one.
 */
export function estimateTokens(text: string, family?: TokenizerFamily): number {
  return estimateTokensByFamily(text, family)
}

/**
 * The route's window, in tokens. 0 means unknown — then nothing is clamped,
 * because inventing a ceiling for an unknown window is how a good prompt gets
 * cut for no reason.
 *
 * `model` is the model actually being called; `serverWindow` is what the
 * server says it is running with (0 when it will not say).
 */
export function resolvePromptBudget(
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
  serverWindow = 0,
): number {
  const override = Number(env.FACTORY_CONTEXT_LIMIT ?? env.LOCAL_LLM_CONTEXT_LIMIT ?? '')
  if (Number.isFinite(override) && override > 0) return Math.floor(override)

  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()

  // Which model is this route really calling? A stale LOCAL_LLM_MODEL must
  // not decide the window of a HOSTED route, or a 32K local model would
  // silently widen the window of a 4K hosted one.
  const modelId = (
    model ??
    (provider === 'local'
      ? (env.DSH_LLM_MODEL ?? env.LOCAL_LLM_MODEL ?? '')
      : (env.DSH_LLM_MODEL ?? ''))
  ).trim()

  const native = contextWindowFor(modelId, provider)

  // The SERVER knows the deployment's real window. It wins over any legacy
  // constant, and it is capped by the model's own ceiling.
  if (serverWindow > 0) {
    if (native > 0) return Math.min(serverWindow, native)
    return serverWindow
  }

  if (provider === 'local') {
    // The dev/benchmark local deployment's window (13,312 on the Colab box
    // that serves the 3B). A model whose OWN ceiling is smaller still wins.
    return native > 0 ? Math.min(13312, native) : 13312
  }

  // A hosted route with a KNOWN model now gets that model's real window
  // instead of no clamp at all.
  return native
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

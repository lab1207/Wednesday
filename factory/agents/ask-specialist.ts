/**
 * ask_specialist — Factory-dispatched cheap-model calls (2026-09-22).
 *
 * Doctrine (locked 2026-09-21): benchmark failures are Factory capability
 * gaps, not model-intelligence gaps. Cheap external models serve as Factory
 * plugins, invoked in small quantity on Factory triggers only — the model
 * may request, the Factory decides. Hidden from the operator (model-only
 * tool surface, telemetry in local evidence only).
 *
 * Thin-plugin law: this is a NAMED budgeted exception — the specialist
 * reasons (caption / answer) where every other plugin only retrieves.
 * All other caps stay mechanical: image count, prompt chars, call count,
 * token/USD budgets. No LLM summarization anywhere else in the path.
 *
 * Vision first: `z-ai/glm-4.6v` (image+text+video, $0.30/M in / $0.90/M
 * out, ~$0.0006/caption) before the text fallback `z-ai/glm-4.7-flash`
 * (text, $0.06/M in, ~$0.0008/13K re-read — OpenRouter live catalog).
 * Free-first with paid fallback inside budget caps: `<model>:free` is
 * tried first, the paid id on free-tier failure. Rides the operator's
 * existing OpenRouter key (BYO) — no new keys anywhere in the slice.
 *
 * Offline-green before any live spend: every branch is unit-tested with
 * an injected fetch — no network, no key in this slice. Live vision
 * proof stays queued behind the operator key.
 */

import { recordUsage } from '../model-router/usage'

export type SpecialistKind = 'vision' | 'text'

export const VISION_MODEL = 'z-ai/glm-4.6v'
export const TEXT_MODEL = 'z-ai/glm-4.7-flash'

/**
 * Model-interchangeability (2026-09-24, north-star guardrail): the Factory
 * never hard-depends on a vendor — every model id is a default behind an
 * env override, because models change and any small-model pool must do.
 * The specialist family follows the same rule: override the whole id
 * (including any `:free` suffix convention your gateway uses) via env.
 */
export function resolveSpecialistModel(
  kind: SpecialistKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (kind === 'vision') {
    return (env.FACTORY_SPECIALIST_VISION_MODEL ?? '').trim() || VISION_MODEL
  }
  return (env.FACTORY_SPECIALIST_TEXT_MODEL ?? '').trim() || TEXT_MODEL
}

/** Free-tier id for a paid model (OpenRouter `:free` suffix convention). */
export function freeModelFor(model: string): string {
  return `${model}:free`
}

export interface SpecialistBudget {
  maxCalls: number
  maxUsd: number
  maxTokens: number
}

const DEFAULT_BUDGET: SpecialistBudget = {
  maxCalls: 2,
  maxUsd: 0.02,
  maxTokens: 13000,
}

function finiteOr(
  value: number,
  fallback: number,
): number {
  return Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/**
 * Budget caps from the environment. Zero is a valid explicit cap
 * (blocks all calls); unset/invalid/negative falls back to the small
 * defaults so money is guarded even on typos.
 */
export function resolveSpecialistBudget(
  env: NodeJS.ProcessEnv = process.env,
): SpecialistBudget {
  const rawCalls = env.FACTORY_SPECIALIST_MAX_CALLS?.trim() || ''
  const rawUsd = env.FACTORY_SPECIALIST_MAX_USD?.trim() || ''
  const rawTokens = env.FACTORY_SPECIALIST_MAX_TOKENS?.trim() || ''
  return {
    maxCalls: finiteOr(
      rawCalls === '' ? Number.NaN : Number(rawCalls),
      DEFAULT_BUDGET.maxCalls,
    ),
    maxUsd: finiteOr(
      rawUsd === '' ? Number.NaN : Number(rawUsd),
      DEFAULT_BUDGET.maxUsd,
    ),
    maxTokens: finiteOr(
      rawTokens === '' ? Number.NaN : Number(rawTokens),
      DEFAULT_BUDGET.maxTokens,
    ),
  }
}

const VISION_KEYWORDS =
  /(image|screenshot|\.png\b|\.jpe?g\b|\.gif\b|\.webp\b|\.svg\b|\bui\b|mockup|diagram|chart|photo|picture|vision|pixel|layout|design|icon)/i

/**
 * Factory trigger (pure): vision tasks route to the vision specialist,
 * everything else returns null (Factory decides — a model request alone
 * never fires a call). Inspects objective + stack + role together.
 */
export function shouldTriggerSpecialist(task: {
  objective?: string
  stack?: string
  role?: string
}): SpecialistKind | null {
  const text = `${task.objective ?? ''}\n${task.stack ?? ''}\n${task.role ?? ''}`
  return VISION_KEYWORDS.test(text) ? 'vision' : null
}

const PROMPT_CAP = 8000
const MAX_IMAGES = 3

/**
 * Task-only prompt for the specialist (pure). Carries the objective plus
 * capped caller context — never pipeline internals (repair counts,
 * budgets, review verdicts, evidence paths, keys). Per-run internals
 * stay in evidence records, never in specialist calls.
 */
export function buildSpecialistPrompt(
  objective: string,
  context = '',
): string {
  const capped =
    context.length <= PROMPT_CAP
      ? context
      : `${context.slice(0, PROMPT_CAP)}\n\n[truncated ${context.length - PROMPT_CAP} characters]`
  return [
    'You are a specialist consultant. Answer the task below directly with raw material (caption, identification, or short answer).',
    'Do not ask for clarification. Do not describe your process.',
    '',
    `TASK:\n${objective}`,
    capped ? `\nCONTEXT:\n${capped}` : '',
  ].join('\n')
}

export interface SpecialistRequest {
  kind: SpecialistKind
  prompt: string
  images?: string[]
  maxTokens?: number
}

export interface SpecialistResult {
  model: string
  text: string
  freeTier: boolean
  promptTokens: number
  completionTokens: number
}

export interface AskSpecialistOptions {
  fetchFn?: typeof fetch
  apiKey?: string
  budget?: SpecialistBudget
  /** Spend already incurred this run (tokens + USD) — caps apply on top. */
  spentTokens?: number
  spentUsd?: number
  callsMade?: number
}

interface OpenRouterChoice {
  message?: { content?: unknown }
}

function readContent(choice: OpenRouterChoice | undefined): string {
  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content
      .map(part =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

/** Rough token estimate (chars/4) — mechanical, documented, no LLM. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const PRICE_PER_M: Record<string, { input: number; output: number }> = {
  [VISION_MODEL]: { input: 0.3, output: 0.9 },
  // Flash out-price unpublished in the catalog snapshot — price output
  // at the input rate (documented assumption, errs toward the cap).
  [TEXT_MODEL]: { input: 0.06, output: 0.06 },
}

function estimateCallUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = PRICE_PER_M[model] ?? { input: 0.06, output: 0.06 }
  return (
    (promptTokens / 1_000_000) * price.input +
    (completionTokens / 1_000_000) * price.output
  )
}

async function callOnce(
  fetchFn: typeof fetch,
  apiKey: string,
  model: string,
  request: SpecialistRequest,
): Promise<{ text: string; completionTokens: number }> {
  const images = (request.images ?? []).slice(0, MAX_IMAGES)
  const content =
    request.kind === 'vision' && images.length > 0
      ? [
          { type: 'text', text: request.prompt },
          ...images.map(url => ({
            type: 'image_url',
            image_url: { url },
          })),
        ]
      : request.prompt
  const response = await fetchFn(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: request.maxTokens ?? 1024,
      }),
    },
  )
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`Specialist request failed: ${response.status} ${raw.slice(0, 300)}`)
  }
  let data: { choices?: OpenRouterChoice[] }
  try {
    data = JSON.parse(raw) as { choices?: OpenRouterChoice[] }
  } catch {
    throw new Error(`Specialist returned invalid JSON: ${raw.slice(0, 300)}`)
  }
  const text = readContent(data.choices?.[0])
  if (!text) {
    throw new Error(`Specialist returned no usable content: ${raw.slice(0, 300)}`)
  }
  return { text, completionTokens: estimateTokens(text) }
}

/**
 * Factory-dispatched specialist call: free-tier first, paid fallback,
 * all inside budget caps. Throws without touching the network when the
 * budget is already spent, when no key is present, or when both tiers
 * fail. Records usage on success so existing token/USD guards see it.
 */
export async function askSpecialist(
  request: SpecialistRequest,
  options: AskSpecialistOptions = {},
): Promise<SpecialistResult> {
  const budget = options.budget ?? resolveSpecialistBudget()
  const callsMade = options.callsMade ?? 0
  if (callsMade >= budget.maxCalls) {
    throw new Error(
      `Specialist budget exceeded: ${callsMade} calls made (cap ${budget.maxCalls}).`,
    )
  }
  const promptTokens = estimateTokens(request.prompt)
  if (
    (options.spentTokens ?? 0) + promptTokens >= budget.maxTokens
  ) {
    throw new Error(
      `Specialist budget exceeded: token cap ${budget.maxTokens} would be hit.`,
    )
  }
  const apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '').trim()
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set')
  }
  const fetchFn = options.fetchFn ?? fetch
  const paid = resolveSpecialistModel(request.kind)
  const tiers = [
    { model: freeModelFor(paid), freeTier: true },
    { model: paid, freeTier: false },
  ]
  let lastError: unknown = null
  for (const tier of tiers) {
    // Price the attempt before firing: a call that cannot fit the USD
    // cap never leaves the Factory.
    const worstUsd = estimateCallUsd(
      paid,
      promptTokens,
      request.maxTokens ?? 1024,
    )
    if ((options.spentUsd ?? 0) + worstUsd >= budget.maxUsd) {
      throw new Error(
        `Specialist budget exceeded: $${budget.maxUsd} USD cap would be hit.`,
      )
    }
    try {
      const { text, completionTokens } = await callOnce(
        fetchFn,
        apiKey,
        tier.model,
        request,
      )
      recordUsage('openrouter', tier.model, promptTokens, completionTokens)
      return {
        model: tier.model,
        text,
        freeTier: tier.freeTier,
        promptTokens,
        completionTokens,
      }
    } catch (error) {
      lastError = error
      // Free-tier failure falls through to paid; paid failure throws.
      if (!tier.freeTier) throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Specialist request failed on all tiers')
}

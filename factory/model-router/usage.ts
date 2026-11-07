/**
 * Model usage registry - V1.6 benchmark telemetry, extended 2026-11-05.
 *
 * Providers record token usage per request into this module-level registry so
 * the benchmark runner can diff a run's consumption without changing the
 * provider contracts. Cost is only estimated for models listed in
 * PRICE_PER_MILLION_TOKENS; unknown models report null cost (tokens still
 * count). Keys never live here; the registry only holds token counters.
 *
 * THE SEAT ADDITION (2026-11-05). The mission is "small open models, staffed
 * as a coding team", and the registry could not answer the one question a
 * manager of a team asks: "what did the REVIEWER seat cost me?". Usage was
 * keyed on provider+model, so a run that used one model for five roles
 * produced one row. The seat registry below is keyed on the SEAT as well, and
 * it also records WALL-CLOCK time - because for a locally hosted small model
 * the real cost is GPU-minutes, not tokens, and a token meter cannot see it.
 *
 * Two registries, deliberately:
 *  - The main one keeps its provider+model key so the benchmark runner, the
 *    health meter and the existing receipts keep working byte-identically.
 *  - The seat one is additive. Nothing that reads the main registry changes.
 *
 * THE MONEY PATH (2026-11-05). A cost figure is only worth printing if it
 * is TRUE, and the factory cannot know what the operator's contract costs.
 * So the built-in price table stays short (the free tier costs nothing) and
 * the OPERATOR supplies the rest: `FACTORY_PRICE_<MODEL>=<input>,<output>`
 * in USD per million tokens. A model with no price reports "unpriced" and
 * its tokens still count - a made-up dollar figure in a receipt is a claim
 * the factory cannot back.
 */
import { canonicalModelKey } from './model-registry'

export interface UsageRecord {
  provider: string
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  /** Wall-clock milliseconds spent in these calls (0 when not measured). */
  elapsedMs?: number
}

/**
 * One seat's slice of a run: who it was, which model it wore, what it cost
 * in tokens, and how long it took.
 */
export interface SeatUsageRecord {  /** The seat name (planner, coder, tester, reviewer, vision...). */
  seat: string
  provider: string
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  /** Total wall-clock milliseconds across these calls. */
  elapsedMs: number
  /** The slowest single call. */
  maxElapsedMs: number
}

interface UsageCounter {
  calls: number
  promptTokens: number
  completionTokens: number
  elapsedMs: number
}

const records = new Map<string, UsageCounter>()

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export function recordUsage(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  elapsedMs = 0,
): void {
  const id = key(provider, model)
  const current = records.get(id) ?? { calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 }
  records.set(id, {
    calls: current.calls + 1,
    promptTokens: current.promptTokens + promptTokens,
    completionTokens: current.completionTokens + completionTokens,
    elapsedMs: current.elapsedMs + elapsedMs,
  })
}

/* ------------------------------------------------------------------ */
/* The seat registry.                                                    */
/* ------------------------------------------------------------------ */

const seatRecords = new Map<string, SeatUsageRecord>()

function seatKey(seat: string, provider: string, model: string): string {
  return `${seat}\u0000${provider}\u0000${model}`
}

/**
 * Record one seat's call.
 *
 * A blank seat is still recorded (as the unattributed bucket) so the totals
 * always add up: a run that spent tokens somewhere must never be able to
 * hide them by forgetting to name the seat.
 */
export function recordSeatUsage(
  seat: string,
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  elapsedMs = 0,
): void {
  const name = seat.trim() || 'unattributed'
  const id = seatKey(name, provider, model)
  const current = seatRecords.get(id)
  if (current === undefined) {
    seatRecords.set(id, {
      seat: name,
      provider,
      model,
      calls: 1,
      promptTokens,
      completionTokens,
      elapsedMs,
      maxElapsedMs: elapsedMs,
    })
    return
  }
  current.calls += 1
  current.promptTokens += promptTokens
  current.completionTokens += completionTokens
  current.elapsedMs += elapsedMs
  if (elapsedMs > current.maxElapsedMs) current.maxElapsedMs = elapsedMs
}

export function seatUsageSnapshot(): SeatUsageRecord[] {
  return [...seatRecords.values()].map(record => ({ ...record }))
}

export function seatUsageDiff(
  before: SeatUsageRecord[],
  after: SeatUsageRecord[],
): SeatUsageRecord[] {
  const beforeByKey = new Map(
    before.map(record => [seatKey(record.seat, record.provider, record.model), record]),
  )
  return after
    .map(record => {
      const previous = beforeByKey.get(seatKey(record.seat, record.provider, record.model))
      if (previous === undefined) return record
      const calls = record.calls - previous.calls
      const promptTokens = record.promptTokens - previous.promptTokens
      const completionTokens = record.completionTokens - previous.completionTokens
      const elapsedMs = record.elapsedMs - previous.elapsedMs
      if (calls <= 0 && promptTokens <= 0 && completionTokens <= 0 && elapsedMs <= 0) {
        return undefined
      }
      return {
        ...record,
        calls,
        promptTokens,
        completionTokens,
        elapsedMs,
        maxElapsedMs: record.maxElapsedMs,
      }
    })
    .filter((record): record is SeatUsageRecord => record !== undefined)
}

/**
 * The seats of one run, biggest time first - the order an operator reads
 * "where did the run go?" in. Ties break on tokens so the order is stable.
 */
export function seatUsageByCost(records: SeatUsageRecord[]): SeatUsageRecord[] {
  return [...records].sort((a, b) => {
    if (b.elapsedMs !== a.elapsedMs) return b.elapsedMs - a.elapsedMs
    if (b.completionTokens !== a.completionTokens) {
      return b.completionTokens - a.completionTokens
    }
    return a.seat.localeCompare(b.seat)
  })
}

/** Total wall-clock milliseconds across a set of seat records. */
export function seatUsageTotalMs(records: SeatUsageRecord[]): number {
  return records.reduce((sum, record) => sum + record.elapsedMs, 0)
}

/**
 * One honest line per seat for a receipt or a status page.
 *
 * "reviewer - 4 calls - 12.4K tokens - 48s" is what a manager of a team
 * needs. The cost column stays OUT when the model is unpriced, because a
 * made-up dollar figure is worse than no dollar figure.
 */
export function seatUsageLines(
  records: SeatUsageRecord[],
  options: { costUsd?: (record: SeatUsageRecord) => number | null } = {},
): string[] {
  return seatUsageByCost(records).map(record => {
    const tokens = record.promptTokens + record.completionTokens
    const parts = [
      record.seat,
      `${record.calls} call${record.calls === 1 ? '' : 's'}`,
      `${formatTokenCount(tokens)} tokens`,
      `${formatDurationMs(record.elapsedMs)}`,
    ]
    const cost = options.costUsd?.(record)
    if (cost !== undefined && cost !== null) {
      parts.push(`$${cost.toFixed(4)}`)
    }
    return parts.join(' - ')
  })
}

/** 12345 -> "12.3K", 999 -> "999". */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/** 90000 -> "1m 30s", 4500 -> "4.5s", 250 -> "250ms". */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  if (seconds === 60) return `${minutes + 1}m 0s`
  return `${minutes}m ${seconds}s`
}

export function usageSnapshot(): UsageRecord[] {
  return [...records.entries()].map(([id, counter]) => {
    const separator = id.indexOf('\u0000')
    return {
      provider: id.slice(0, separator),
      model: id.slice(separator + 1),
      calls: counter.calls,
      promptTokens: counter.promptTokens,
      completionTokens: counter.completionTokens,
      elapsedMs: counter.elapsedMs,
    }
  })
}

export function usageDiff(
  before: UsageRecord[],
  after: UsageRecord[],
): UsageRecord[] {
  const beforeByKey = new Map(before.map(record => [key(record.provider, record.model), record]))
  return after
    .map(record => {
      const previous = beforeByKey.get(key(record.provider, record.model))
      if (previous === undefined) return record
      const promptTokens = record.promptTokens - previous.promptTokens
      const completionTokens = record.completionTokens - previous.completionTokens
      const calls = record.calls - previous.calls
      const elapsedMs = (record.elapsedMs ?? 0) - (previous.elapsedMs ?? 0)
      if (promptTokens <= 0 && completionTokens <= 0 && calls <= 0) return undefined
      return { ...record, calls, promptTokens, completionTokens, elapsedMs }
    })
    .filter((record): record is UsageRecord => record !== undefined)
}

/**
 * USD per million tokens for production models.
 *
 * The table is deliberately SHORT and deliberately HONEST. A wrong price is
 * worse than no price: a made-up dollar figure in a receipt is a claim the
 * factory cannot back, and the operator's provider page is the only truth
 * about what THEY pay. So the built-in table holds only what is certain
 * (the free tier costs nothing), and everything else is resolved from the
 * operator's own price, or reported as unknown.
 *
 * The operator's price wins over the table: their contract, their number.
 * Set it as `FACTORY_PRICE_<MODEL>=<input>,<output>` (USD per million
 * tokens), e.g. `FACTORY_PRICE_QWEN_QWEN3_CODER=0.30,1.20`. The model name
 * is uppercased and every non-alphanumeric character becomes `_`, so
 * `qwen/qwen3-coder` becomes `FACTORY_PRICE_QWEN_QWEN3_CODER`.
 */
const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  // The free router serves only `:free` models, so a run costs nothing while
  // still recording tokens.
  'openrouter/free': { input: 0, output: 0 },
  // 'stealth/ox-alpha': { input: 1.0, output: 3.0 },
}

/** The env var that carries the operator's own price for a model. */
export function priceEnvName(model: string): string {
  const slug = model
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug ? `FACTORY_PRICE_${slug}` : ''
}

/**
 * Parse an operator's price override: `<input>,<output>` in USD per million
 * tokens (pure).
 *
 * A malformed value returns null rather than a guess. A price of zero is
 * VALID and means "this costs nothing" - which is the truth for a free
 * tier and must not be confused with "unknown".
 */
export function parsePriceOverride(
  raw: string | undefined,
): { input: number; output: number } | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const parts = trimmed.split(',').map(part => part.trim())
  if (parts.length !== 2) return null
  const input = Number(parts[0])
  const output = Number(parts[1])
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0) return null
  return { input, output }
}

/**
 * The price of a model, if we know it (pure over the table + the env).
 *
 * The lookup order is: the operator's own price, the exact model id, the
 * canonical model key (so `openrouter/qwen/qwen3-coder` and
 * `qwen/qwen3-coder` price the same), and finally the free-tier rule.
 *
 * Kept separate from `estimateCostUsd` so the ROUTER can honour a
 * `maxCost` requirement without building a whole usage record first.
 */
export function priceForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { input: number; output: number } | null {
  const override = parsePriceOverride(env[priceEnvName(model)])
  if (override !== null) return override

  const direct = PRICE_PER_MILLION_TOKENS[model]
  if (direct !== undefined) return direct

  // The canonical key: one model under many spellings is one price.
  const canonical = canonicalModelKey(model)
  const byCanonical = PRICE_PER_MILLION_TOKENS[canonical]
  if (byCanonical !== undefined) return byCanonical

  const free = PRICE_PER_MILLION_TOKENS['openrouter/free']
  return model.endsWith(':free') ? free : null
}

export function estimateCostUsd(
  record: UsageRecord,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  // Local models run on the operator's hardware; tokens are still recorded.
  if (record.provider === 'local') return 0
  const price = priceForModel(record.model, env)
  if (price === null) return null
  return (
    (record.promptTokens / 1_000_000) * price.input +
    (record.completionTokens / 1_000_000) * price.output
  )
}

/** The cost of one seat's slice, when the model is priced. */
export function estimateSeatCostUsd(
  record: SeatUsageRecord,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (record.provider === 'local') return 0
  const price = priceForModel(record.model, env)
  if (price === null) return null
  return (
    (record.promptTokens / 1_000_000) * price.input +
    (record.completionTokens / 1_000_000) * price.output
  )
}

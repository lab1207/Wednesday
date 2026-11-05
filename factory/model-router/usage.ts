/**
 * Model usage registry — V1.6 benchmark telemetry.
 *
 * Providers record token usage per request into this module-level registry so
 * the benchmark runner can diff a run's consumption without changing the
 * provider contracts. Cost is only estimated for models listed in
 * PRICE_PER_MILLION_TOKENS; unknown models report null cost (tokens still
 * count). Keys never live here; the registry only holds token counters.
 */

export interface UsageRecord {
  provider: string
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
}

interface UsageCounter {
  calls: number
  promptTokens: number
  completionTokens: number
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
): void {
  const id = key(provider, model)
  const current = records.get(id) ?? { calls: 0, promptTokens: 0, completionTokens: 0 }
  records.set(id, {
    calls: current.calls + 1,
    promptTokens: current.promptTokens + promptTokens,
    completionTokens: current.completionTokens + completionTokens,
  })
}

export function usageSnapshot(): UsageRecord[] {
  return [...records.entries()].map(([id, counter]) => {
    const separator = id.indexOf('\u0000')
    return {
      provider: id.slice(0, separator),
      model: id.slice(separator + 1),
      ...counter,
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
      if (promptTokens <= 0 && completionTokens <= 0) return undefined
      return { ...record, calls, promptTokens, completionTokens }
    })
    .filter((record): record is UsageRecord => record !== undefined)
}

/**
 * USD per million tokens for production models. Add an entry per model as
 * soon as the production model/pricing is finalized; until then cost is
 * reported as null with tokens still captured.
 */
const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  // The free router serves only `:free` models, so a run costs nothing while
  // still recording tokens.
  'openrouter/free': { input: 0, output: 0 },
  // 'stealth/ox-alpha': { input: 1.0, output: 3.0 },
}

export function estimateCostUsd(record: UsageRecord): number | null {
  // Local models run on the operator's hardware; tokens are still recorded.
  if (record.provider === 'local') return 0
  const price = PRICE_PER_MILLION_TOKENS[record.model]
  if (price === undefined) return null
  return (
    (record.promptTokens / 1_000_000) * price.input +
    (record.completionTokens / 1_000_000) * price.output
  )
}
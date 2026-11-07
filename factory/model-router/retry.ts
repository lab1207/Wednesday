/**
 * Shared retry + throttle for the live HTTP providers (2026-09-23).
 *
 * Free pools flap 429s and trial keys carry RPM caps, so both OpenRouter
 * and NVIDIA funnel through here: `throttleShared` spaces one request
 * behind the previous call, `fetchWithRetry` replays retryable statuses
 * with deterministic exponential backoff. Pure helpers stay unit-tested;
 * sleeps and clocks inject so tests never wait on real timers.
 */

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BASE_DELAY_MS = 1000
export const DEFAULT_MAX_DELAY_MS = 8000
export const DEFAULT_THROTTLE_MS = 1000

function intOr(value: number, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

/** Retry/attempt knobs from the environment (pure, guarded). */
export function resolveRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
  const raw = (name: string): number =>
    Number(String(env[name] ?? '').trim() || 'NaN')
  return {
    maxAttempts: intOr(raw('FACTORY_RETRY_ATTEMPTS'), DEFAULT_MAX_ATTEMPTS, 1, 5),
    baseDelayMs: intOr(raw('FACTORY_RETRY_BASE_MS'), DEFAULT_BASE_DELAY_MS, 0, 60000),
    maxDelayMs: intOr(raw('FACTORY_RETRY_MAX_MS'), DEFAULT_MAX_DELAY_MS, 0, 120000),
  }
}

/** Minimum gap between live calls from the environment (pure, guarded). */
export function resolveThrottleMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intOr(
    Number(String(env.FACTORY_THROTTLE_MS ?? '').trim() || 'NaN'),
    DEFAULT_THROTTLE_MS,
    0,
    60000,
  )
}

/** Retryable statuses (pure): rate limits + transient gateway failures. */
export function shouldRetryStatus(status: number): boolean {
  return RETRYABLE.has(status)
}

/** Deterministic exponential backoff for a 0-based retry index (pure). */
export function computeBackoffMs(
  retryIndex: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, retryIndex), maxDelayMs)
}

export type SleepFn = (ms: number) => Promise<void>

const realSleep: SleepFn = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms))

let lastSentAt = 0

/** Reset the shared throttle clock (tests only). */
export function resetSharedThrottle(): void {
  lastSentAt = 0
}

/**
 * Spaces one live call behind the previous send. Inject the clock and
 * sleeper in tests; production defaults use wall time + real timers.
 */
export async function throttleShared(
  gapMs: number,
  deps: {
    now?: () => number
    sleep?: SleepFn
  } = {},
): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const current = now()
  const wait = lastSentAt + gapMs - current
  if (wait > 0) await sleep(wait)
  lastSentAt = wait > 0 ? lastSentAt + gapMs : current
}

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: SleepFn
}

/**
 * Fetch with retry on 429/502/503/504 (and 408/500/529) and on fetch
 * rejections (flaky tunnels). Returns the first OK / non-retryable / final
 * response; rethrows the last network error only when every attempt fails.
 *
 * The init type is generic so the local route can pass undici's `dispatcher`
 * option (which disables the 300s body timeout for slow CPU hardware)
 * without the shared helper having to know about it.
 */
export async function fetchWithRetry<TInit extends object>(
  fetchFn: (url: string, init: TInit) => Promise<Response>,
  url: string,
  init: TInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const sleep = options.sleep ?? realSleep
  let lastError: unknown = null
  let lastResponse: Response | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchFn(url, init)
      if (response.ok || !shouldRetryStatus(response.status) || attempt === maxAttempts - 1) {
        return response
      }
      lastResponse = response
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error
      lastError = error
    }
    await sleep(computeBackoffMs(attempt, baseDelayMs, maxDelayMs))
  }
  if (lastResponse) return lastResponse
  throw lastError instanceof Error ? lastError : new Error('fetchWithRetry: all attempts failed')
}

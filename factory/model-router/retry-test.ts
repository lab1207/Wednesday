/**
 * Offline test for shared retry + throttle. Injected fake fetches and
 * clocks prove status gating, backoff math, replay counts, and gap
 * spacing — no network, no real timers.
 */
import assert from 'node:assert/strict'

import {
  computeBackoffMs,
  fetchWithRetry,
  resolveRetryConfig,
  resolveThrottleMs,
  resetSharedThrottle,
  shouldRetryStatus,
  throttleShared,
} from './retry'

function response(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response
}

async function main(): Promise<void> {
  // 1. Status gate: the TRANSIENT failures retry; the CLIENT failures do not.
  //
  //    408 (request timeout), 429 (rate limited), 500, 502, 503, 504 and
  //    529 (overloaded) are all things a small-model endpoint returns when
  //    it is busy, restarting or briefly broken — and a replay fixes them.
  //    400, 401 and 404 are the request's fault: a replay sends the same
  //    wrong request and gets the same wrong answer, so retrying only burns
  //    the operator's time and tokens.
  assert.equal(shouldRetryStatus(408), true)
  assert.equal(shouldRetryStatus(429), true)
  assert.equal(shouldRetryStatus(500), true)
  assert.equal(shouldRetryStatus(502), true)
  assert.equal(shouldRetryStatus(503), true)
  assert.equal(shouldRetryStatus(504), true)
  assert.equal(shouldRetryStatus(529), true)
  assert.equal(shouldRetryStatus(400), false)
  assert.equal(shouldRetryStatus(401), false)
  assert.equal(shouldRetryStatus(404), false)
  assert.equal(shouldRetryStatus(422), false)

  // 2. Backoff math: deterministic exponential, capped.
  assert.equal(computeBackoffMs(0, 1000, 8000), 1000)
  assert.equal(computeBackoffMs(1, 1000, 8000), 2000)
  assert.equal(computeBackoffMs(5, 1000, 8000), 8000)

  // 3. Config: guarded defaults, env overrides, junk falls back.
  assert.deepEqual(resolveRetryConfig({}), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
  })
  assert.deepEqual(
    resolveRetryConfig({ FACTORY_RETRY_ATTEMPTS: '2', FACTORY_RETRY_BASE_MS: '250' }),
    { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 8000 },
  )
  assert.deepEqual(resolveRetryConfig({ FACTORY_RETRY_ATTEMPTS: 'junk' }), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
  })
  assert.equal(resolveThrottleMs({}), 1000)
  assert.equal(resolveThrottleMs({ FACTORY_THROTTLE_MS: '250' }), 250)

  const noSleep = async (): Promise<void> => {}

  // 4. Flaky then well: 429,429,200 → 200 in 3 calls.
  {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return calls < 3 ? response(429, 'slow down') : response(200, '{}')
    }) as unknown as typeof fetch
    const result = await fetchWithRetry(fetchFn, 'https://x.test/v1', {}, { sleep: noSleep })
    assert.equal(result.status, 200)
    assert.equal(calls, 3)
  }

  // 5. Non-retryable returns immediately: 400 in 1 call.
  {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return response(400, 'bad')
    }) as unknown as typeof fetch
    const result = await fetchWithRetry(fetchFn, 'https://x.test/v1', {}, { sleep: noSleep })
    assert.equal(result.status, 400)
    assert.equal(calls, 1)
  }

  // 5b. A transient 500 IS replayed (2026-11-06): a busy small-model box
  //     answers 500 far more often than a big one, and the old gate threw
  //     the answer away on the first refusal.
  {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return calls < 2 ? response(500, 'busy') : response(200, '{}')
    }) as unknown as typeof fetch
    const result = await fetchWithRetry(fetchFn, 'https://x.test/v1', {}, { sleep: noSleep })
    assert.equal(result.status, 200)
    assert.equal(calls, 2)
  }

  // 6. Persistent 429 returns the final response after maxAttempts.
  {
    let calls = 0
    const slept: number[] = []
    const fetchFn = (async () => {
      calls += 1
      return response(429, 'still limited')
    }) as unknown as typeof fetch
    const result = await fetchWithRetry(fetchFn, 'https://x.test/v1', {}, {
      maxAttempts: 2,
      baseDelayMs: 100,
      sleep: async ms => {
        slept.push(ms)
      },
    })
    assert.equal(result.status, 429)
    assert.equal(calls, 2)
    assert.deepEqual(slept, [100])
  }

  // 7. Throttle: second call inside the gap sleeps the remainder.
  {
    resetSharedThrottle()
    const slept: number[] = []
    let clock = 10000
    const deps = { now: () => clock, sleep: async (ms: number) => {
      slept.push(ms)
      clock += ms
    } }
    await throttleShared(1000, deps)
    await throttleShared(1000, deps)
    assert.deepEqual(slept, [1000])
    resetSharedThrottle()
  }

  console.log('RETRY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

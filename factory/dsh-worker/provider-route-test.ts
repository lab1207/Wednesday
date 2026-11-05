/**
 * Offline regression for the worker route (2026-11-05).
 *
 * The coder failed with `no credential for provider route "local"` while the
 * operator had selected an OpenRouter/NVIDIA model. The profile keeps
 * `LOCAL_LLM_BASE_URL` for the tool proxy, and the worker config treated that
 * as "always local", overriding the explicit `DSH_LLM_PROVIDER`.
 *
 * The fix is one pure rule, asserted here; `cordis.yml` mirrors it.
 */
import assert from 'node:assert/strict'

import { workerProvider } from './provider-route'

const env = (patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...patch })

// 1. The regression: a hosted route must win over a leftover local base URL.
assert.equal(
  workerProvider(env({
    DSH_LLM_PROVIDER: 'openrouter',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
  })),
  'openrouter',
  'an explicit OpenRouter route must not be forced onto local',
)
assert.equal(
  workerProvider(env({
    DSH_LLM_PROVIDER: 'nvidia',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
  })),
  'nvidia',
  'an explicit NVIDIA route must not be forced onto local',
)

// 2. An explicit local route still routes local.
assert.equal(
  workerProvider(env({
    DSH_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
  })),
  'local',
)

// 3. No explicit provider: the local base URL is the only signal.
assert.equal(
  workerProvider(env({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1' })),
  'local',
)
assert.equal(workerProvider(env({})), 'openrouter')

// 4. Whitespace/empty values are not a route.
assert.equal(
  workerProvider(env({ DSH_LLM_PROVIDER: '  ', LOCAL_LLM_BASE_URL: 'http://x/v1' })),
  'local',
)

console.log('PROVIDER ROUTE TEST: PASS (explicit route wins, local only as fallback)')

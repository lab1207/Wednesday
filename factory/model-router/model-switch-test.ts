/**
 * Offline test for the model switcher: registry parsing, active
 * resolution, unknown-name error. No network, no profile writes.
 */
import assert from 'node:assert/strict'

import {
  parseModelRegistry,
  resolveActiveModel,
  switchModel,
} from './model-switch'

async function main(): Promise<void> {
  const env = {
    FACTORY_MODELS:
      ' qwen1b:local/qwen-27b-1bit@http://127.0.0.1:8080/v1, pro:openrouter/qwen/qwen3-coder, bit:local/falcon3-10b@http://127.0.0.1:8001/v1, junk, qwen1b:local/other ',
    FACTORY_ACTIVE_MODEL: 'qwen1b',
  } as NodeJS.ProcessEnv

  // 1. Parse: 3 valid, junk dropped, duplicate name keeps first.
  const registry = parseModelRegistry(env)
  assert.deepEqual(registry, [
    { name: 'qwen1b', provider: 'local', id: 'qwen-27b-1bit', baseURL: 'http://127.0.0.1:8080/v1' },
    { name: 'pro', provider: 'openrouter', id: 'qwen/qwen3-coder' },
    { name: 'bit', provider: 'local', id: 'falcon3-10b', baseURL: 'http://127.0.0.1:8001/v1' },
  ])

  // 2. Active resolves by exact name; unset/unknown -> null (no silent swap).
  assert.equal(resolveActiveModel(env)?.id, 'qwen-27b-1bit')
  assert.equal(
    resolveActiveModel({ FACTORY_MODELS: env.FACTORY_MODELS } as NodeJS.ProcessEnv),
    null,
  )
  assert.equal(
    resolveActiveModel({ ...env, FACTORY_ACTIVE_MODEL: 'ghost' } as NodeJS.ProcessEnv),
    null,
  )

  // 3. Switch validates: known returns entry, unknown throws naming it.
  assert.equal(switchModel('bit', registry).baseURL, 'http://127.0.0.1:8001/v1')
  assert.throws(
    () => switchModel('ghost', registry),
    /Unknown model "ghost"\. Saved: qwen1b, pro, bit\./,
  )
  assert.deepEqual(parseModelRegistry({} as NodeJS.ProcessEnv), [])

  console.log('MODEL SWITCH TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

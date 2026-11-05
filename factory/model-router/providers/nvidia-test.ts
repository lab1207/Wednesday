/**
 * Offline test for the NVIDIA provider slice. No network, no key:
 * pure resolvers (defaults, trim, overrides) plus supports/listModels.
 * `complete()` stays live-gated (needs NVIDIA_API_KEY + endpoint).
 */
import assert from 'node:assert/strict'

import {
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  NvidiaProvider,
  resolveNvidiaBaseURL,
  resolveNvidiaKey,
  resolveNvidiaModel,
} from './nvidia'

async function main(): Promise<void> {
  // 1. Defaults when the env is empty.
  assert.equal(resolveNvidiaKey({}), '')
  assert.equal(resolveNvidiaModel({}), NVIDIA_DEFAULT_MODEL)
  assert.equal(resolveNvidiaBaseURL({}), NVIDIA_DEFAULT_BASE_URL)

  // 2. Overrides trim; blanks fall back.
  assert.equal(
    resolveNvidiaModel({ NVIDIA_LLM_MODEL: '  nvidia/llama-3.1-8b-instruct  ' }),
    'nvidia/llama-3.1-8b-instruct',
  )
  assert.equal(resolveNvidiaModel({ NVIDIA_LLM_MODEL: '   ' }), NVIDIA_DEFAULT_MODEL)
  assert.equal(
    resolveNvidiaBaseURL({ NVIDIA_BASE_URL: 'https://example.test/v1/' }),
    'https://example.test/v1',
  )
  assert.equal(
    resolveNvidiaKey({ NVIDIA_API_KEY: '  nv-test  ' }),
    'nv-test',
  )

  // 3. Provider shape: supports everything except localOnly, lists one model.
  const provider = new NvidiaProvider()
  assert.equal(provider.name, 'nvidia')
  assert.equal(provider.supports({}), true)
  assert.equal(provider.supports({ localOnly: true }), false)
  assert.deepEqual(await provider.listModels(), [NVIDIA_DEFAULT_MODEL])

  // 4. Missing key fails fast without touching the network.
  await assert.rejects(provider.complete(NVIDIA_DEFAULT_MODEL, 'hi'), /NVIDIA_API_KEY/)

  console.log('NVIDIA PROVIDER TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

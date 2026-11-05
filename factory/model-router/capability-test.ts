/**
 * Offline test for capability-aware routing (2026-09-23). Stub providers
 * prove the router prefers `selectModel` when present and keeps the
 * legacy `listModels()[0]` path otherwise — no network, no keys.
 */
import assert from 'node:assert/strict'

import { RegistryModelRouter } from './router'
import type { ModelProvider, ModelRequirements } from './types'

class CapabilityProvider implements ModelProvider {
  readonly name = 'capability-stub'

  supports(_requirements: ModelRequirements): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    return ['legacy-model']
  }

  selectModel(requirements: ModelRequirements): string {
    if (requirements.capability === 'reasoning') return 'planner-model'
    if (requirements.capability === 'vision') return 'vision-model'
    return 'coder-model'
  }

  async complete(model: string, prompt: string): Promise<string> {
    return `${model}:${prompt}`
  }
}

class LegacyProvider implements ModelProvider {
  readonly name = 'legacy-stub'

  supports(_requirements: ModelRequirements): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    return ['legacy-model']
  }

  async complete(model: string, prompt: string): Promise<string> {
    return `${model}:${prompt}`
  }
}

async function main(): Promise<void> {
  // 1. Capability-aware provider: reasoning → planner, coding → coder.
  {
    const router = new RegistryModelRouter()
    router.register(new CapabilityProvider())
    assert.deepEqual(await router.select({ capability: 'reasoning' }), {
      provider: 'capability-stub',
      model: 'planner-model',
    })
    assert.deepEqual(await router.select({ capability: 'coding' }), {
      provider: 'capability-stub',
      model: 'coder-model',
    })
    const completion = await router.complete({ capability: 'vision' }, 'hi')
    assert.equal(completion.route.model, 'vision-model')
    assert.equal(completion.text, 'vision-model:hi')
  }

  // 2. Legacy provider without selectModel: listModels head, unchanged.
  {
    const router = new RegistryModelRouter()
    router.register(new LegacyProvider())
    assert.deepEqual(await router.select({ capability: 'reasoning' }), {
      provider: 'legacy-stub',
      model: 'legacy-model',
    })
  }

  console.log('CAPABILITY ROUTING TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

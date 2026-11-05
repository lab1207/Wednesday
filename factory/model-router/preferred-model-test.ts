/**
 * Offline test for the lane pin: `preferredModel` in requirements wins
 * on every route; blank/absent keeps legacy resolution per provider.
 * No network (selectModel is pure; the OpenRouter legacy path runs
 * with the free pool disabled).
 */
import assert from 'node:assert/strict'

import { LocalProvider } from './providers/local'
import { OpenRouterProvider } from './providers/openrouter'
import { NvidiaProvider, resolveNvidiaModel } from './providers/nvidia'
import { ZenProvider } from './providers/zen'
import { clearModelFit } from './model-capabilities'

async function main(): Promise<void> {
  const saved = { ...process.env }
  process.env.FACTORY_CREW_PLANNER_MODEL = 'pool-r1'
  process.env.FACTORY_CREW_CODER_MODEL = 'pool-coder'
  process.env.FACTORY_CREW_VISION_MODEL = 'pool-vl'
  process.env.FACTORY_FREE_POOL = '0'
  process.env.DSH_LLM_MODEL = 'test-openrouter-model'
  process.env.NVIDIA_LLM_MODEL = 'test-nvidia-model'
  process.env.ZEN_MODEL = 'test-zen-model'
  clearModelFit()
  try {
    const provider = new LocalProvider()
    // Pin wins for every capability, even across roles.
    assert.equal(
      provider.selectModel({ capability: 'coding', preferredModel: 'lane-2-model' }),
      'lane-2-model',
    )
    assert.equal(
      provider.selectModel({ capability: 'reasoning', preferredModel: ' lane-0-model ' }),
      'lane-0-model',
    )
    // Blank pin = legacy slot routing, byte-identical.
    assert.equal(
      provider.selectModel({ capability: 'reasoning', preferredModel: '   ' }),
      'pool-r1',
    )
    assert.equal(provider.selectModel({ capability: 'coding' }), 'pool-coder')
    assert.equal(provider.selectModel({ capability: 'vision' }), 'pool-vl')

    // Every route honors pins (R-BM-21): same pin, same winner.
    // e2e R-BM-21: pins on every route
    for (const route of [new OpenRouterProvider(), new NvidiaProvider(), new ZenProvider()]) {
      assert.equal(
        await route.selectModel!({ capability: 'coding', preferredModel: 'lane-x-model' }),
        'lane-x-model',
        `${route.name} must honor the lane pin`,
      )
    }
    // Unpinned legacy per route, byte-identical.
    assert.equal(
      await new OpenRouterProvider().selectModel!({ capability: 'coding' }),
      'test-openrouter-model',
    )
    assert.equal(
      await new NvidiaProvider().selectModel!({ capability: 'coding' }),
      resolveNvidiaModel(),
    )
    assert.equal(
      await new ZenProvider().selectModel!({ capability: 'coding' }),
      'test-zen-model',
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value
    }
  }

  console.log('PREFERRED MODEL TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

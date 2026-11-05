/**
 * Provider-agnostic crews (2026-10-31): a `provider/model` pin whose prefix
 * names a registered provider routes straight to it (prefix stripped); a pin
 * whose prefix is not a registered provider (vendor part of an OpenRouter
 * id) falls through to legacy supports()-based selection. createModelRouter
 * registers the route provider first plus every credentialed provider, so
 * nothing is locked to one provider. Offline: pinned selects never call the
 * network.
 */
import assert from 'node:assert/strict'

import { RegistryModelRouter } from './router'
import { createModelRouter } from './create-router'
import { seatModelPin } from './crew-routing'
import type { ModelProvider } from './types'

function stub(name: string, supports = true): ModelProvider & { completes: string[] } {
  const completes: string[] = []
  return {
    name,
    completes,
    supports: () => supports,
    listModels: async () => [`${name}-default`],
    selectModel: (req) => (req.preferredModel ?? '').trim() || `${name}-default`,
    complete: async (model) => { completes.push(model); return `${name}_OK` },
  }
}

async function main(): Promise<void> {
  // 1. prefix routing on a hand-built registry
  const router = new RegistryModelRouter()
  const openrouter = stub('openrouter')
  const nvidia = stub('nvidia')
  const local = stub('local')
  router.register(openrouter)
  router.register(nvidia)
  router.register(local)

  assert.deepEqual(await router.select({ preferredModel: 'nvidia/meta/llama-3.1-8b-instruct' }), { provider: 'nvidia', model: 'meta/llama-3.1-8b-instruct' })
  assert.deepEqual(await router.select({ preferredModel: 'openrouter/deepseek/deepseek-chat' }), { provider: 'openrouter', model: 'deepseek/deepseek-chat' })
  assert.deepEqual(await router.select({ preferredModel: 'local/qwen2.5-coder-3b-instruct' }), { provider: 'local', model: 'qwen2.5-coder-3b-instruct' })

  // vendor-prefixed OpenRouter id is NOT a provider pin -> legacy first-supporting
  assert.deepEqual(await router.select({ preferredModel: 'deepseek/deepseek-chat' }), { provider: 'openrouter', model: 'deepseek/deepseek-chat' })
  // no pin -> legacy
  assert.deepEqual(await router.select({}), { provider: 'openrouter', model: 'openrouter-default' })

  // complete() strips the prefix before the provider sees the model id
  const done = await router.complete({ preferredModel: 'nvidia/meta/x' }, 'hi')
  assert.equal(done.text, 'nvidia_OK')
  assert.deepEqual(nvidia.completes, ['meta/x'])

  // 2. createModelRouter: route first + every credentialed provider, no lock
  const multi = createModelRouter({
    FACTORY_LLM_PROVIDER: 'local',
    OPENROUTER_API_KEY: 'k-openrouter',
    NVIDIA_API_KEY: 'k-nvidia',
    ZEN_API_KEY: 'k-zen',
  } as NodeJS.ProcessEnv)
  assert.deepEqual(await multi.select({ preferredModel: 'zen/z-model' }), { provider: 'zen', model: 'z-model' })
  assert.deepEqual(await multi.select({ preferredModel: 'nvidia/n-model' }), { provider: 'nvidia', model: 'n-model' })
  assert.deepEqual(await multi.select({ preferredModel: 'openrouter/o-model' }), { provider: 'openrouter', model: 'o-model' })
  // unpinned still follows the route provider (legacy byte-identical)
  assert.equal((await multi.select({})).provider, 'local')

  // route without any other keys: only route + local (local needs no key)
  const solo = createModelRouter({ FACTORY_LLM_PROVIDER: 'nvidia' } as NodeJS.ProcessEnv)
  assert.equal((await solo.select({})).provider, 'nvidia')
  assert.deepEqual(await solo.select({ preferredModel: 'local/any-model' }), { provider: 'local', model: 'any-model' })

  // 3. seat pins come from the crew slot env only when set
  assert.equal(seatModelPin('coder', { FACTORY_CREW_CODER_MODEL: 'nvidia/meta/x' } as NodeJS.ProcessEnv), 'nvidia/meta/x')
  assert.equal(seatModelPin('planner', { FACTORY_CREW_PLANNER_MODEL: '  ' } as NodeJS.ProcessEnv), undefined)
  assert.equal(seatModelPin('vision', {} as NodeJS.ProcessEnv), undefined)

  // 3b. a bare seat id with its own local endpoint is a LOCAL pin, even when
  // the session route is hosted. Without this the seat id was sent to the
  // route provider and the worker force-routed it to a keyless local profile.
  assert.equal(
    seatModelPin('coder', {
      FACTORY_CREW_CODER_MODEL: 'qwen2.5-coder-3b-instruct',
      FACTORY_CREW_CODER_BASE_URL: 'http://127.0.0.1:18090/v1',
    } as NodeJS.ProcessEnv),
    'local/qwen2.5-coder-3b-instruct',
  )
  assert.equal(
    seatModelPin('coder', {
      FACTORY_CREW_CODER_MODEL: 'qwen2.5-coder-3b-instruct',
    } as NodeJS.ProcessEnv),
    'qwen2.5-coder-3b-instruct',
    'no local endpoint leaves a bare id to the route provider',
  )
  assert.equal(
    seatModelPin('coder', {
      FACTORY_CREW_CODER_MODEL: 'nvidia/meta/x',
      FACTORY_CREW_CODER_BASE_URL: 'http://127.0.0.1:18090/v1',
    } as NodeJS.ProcessEnv),
    'nvidia/meta/x',
    'an explicit pin is never rewritten',
  )
  assert.equal(
    seatModelPin('coder', {
      FACTORY_CREW_CODER_MODEL: 'qwen2.5-coder-3b-instruct',
      FACTORY_LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
    } as NodeJS.ProcessEnv),
    'local/qwen2.5-coder-3b-instruct',
    'the local route qualifies a bare seat too',
  )

  // 4. chat route honors a provider-pinned seat id over the ambient route
  const { resolveChatRoute } = await import('./chat-stream')
  const pinned = resolveChatRoute('nvidia/meta/llama-x', {
    FACTORY_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
    NVIDIA_API_KEY: 'k',
  } as NodeJS.ProcessEnv)
  assert.ok('route' in pinned && pinned.route.name === 'nvidia' && pinned.route.model === 'meta/llama-x')
  const unpinned = resolveChatRoute('qwen2.5-coder-3b-instruct', {
    FACTORY_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
  } as NodeJS.ProcessEnv)
  assert.ok('route' in unpinned && unpinned.route.name === 'local' && unpinned.route.model === 'qwen2.5-coder-3b-instruct')

  console.log('ROUTER PREFIX TEST: PASS (provider pins route per call, legacy unpinned, multi-provider registry, seat pins, chat-route pins)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

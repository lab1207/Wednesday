/**
 * Offline test for ask_specialist. No network, no key: injected fake
 * fetch proves free-first success, paid fallback on free failure, budget
 * blocks without fetch, image cap, trigger routing, and prompt hygiene
 * (task-only, never pipeline internals).
 */
import assert from 'node:assert/strict'

import {
  askSpecialist,
  buildSpecialistPrompt,
  freeModelFor,
  resolveSpecialistBudget,
  resolveSpecialistModel,
  shouldTriggerSpecialist,
  TEXT_MODEL,
  VISION_MODEL,
} from './ask-specialist'

function fakeFetch(
  handler: (url: string, init: { body?: unknown }) => Promise<Response>,
): typeof fetch {
  return ((url: string, init?: { body?: unknown }) => {
    return handler(url, { body: init?.body })
  }) as unknown as typeof fetch
}

function okResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: text } }] }),
  } as unknown as Response
}

function failResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response
}

async function main(): Promise<void> {
  // 1. Catalog: vision first, free-tier suffix.
  assert.equal(VISION_MODEL, 'z-ai/glm-4.6v')
  assert.equal(TEXT_MODEL, 'z-ai/glm-4.7-flash')
  assert.equal(freeModelFor(VISION_MODEL), 'z-ai/glm-4.6v:free')

  // 1b. Interchangeability: env swaps the whole family, blanks fall back.
  assert.equal(resolveSpecialistModel('vision', {}), VISION_MODEL)
  assert.equal(resolveSpecialistModel('text', {}), TEXT_MODEL)
  assert.equal(
    resolveSpecialistModel('vision', { FACTORY_SPECIALIST_VISION_MODEL: ' my/vision-1 ' }),
    'my/vision-1',
  )
  assert.equal(
    resolveSpecialistModel('text', { FACTORY_SPECIALIST_TEXT_MODEL: '   ' }),
    TEXT_MODEL,
  )

  // 2. Budget resolvers: defaults, env overrides, zero valid, junk → default.
  const defaults = resolveSpecialistBudget({})
  assert.deepEqual(defaults, { maxCalls: 2, maxUsd: 0.02, maxTokens: 13000 })
  assert.deepEqual(
    resolveSpecialistBudget({
      FACTORY_SPECIALIST_MAX_CALLS: '5',
      FACTORY_SPECIALIST_MAX_USD: '0.5',
      FACTORY_SPECIALIST_MAX_TOKENS: '40000',
    }),
    { maxCalls: 5, maxUsd: 0.5, maxTokens: 40000 },
  )
  assert.equal(
    resolveSpecialistBudget({ FACTORY_SPECIALIST_MAX_CALLS: '0' }).maxCalls,
    0,
    'zero is a valid cap',
  )
  assert.deepEqual(
    resolveSpecialistBudget({
      FACTORY_SPECIALIST_MAX_CALLS: 'junk',
      FACTORY_SPECIALIST_MAX_USD: '-3',
    }),
    defaults,
    'junk/negative fall back to guarded defaults',
  )

  // 3. Factory triggers: vision keywords fire, plain tasks stay null.
  assert.equal(
    shouldTriggerSpecialist({ objective: 'Caption this screenshot of the login UI' }),
    'vision',
  )
  assert.equal(
    shouldTriggerSpecialist({ objective: 'Fix the diagram layout in docs/icon.png' }),
    'vision',
  )
  assert.equal(
    shouldTriggerSpecialist({ objective: 'Fix the auth token leak', stack: 'python' }),
    null,
    'model request alone never fires — Factory decides',
  )

  // 4. Prompt hygiene: task carried, internals never leak, context capped.
  const prompt = buildSpecialistPrompt('Caption the login screenshot.', 'x'.repeat(9000))
  assert.ok(prompt.includes('Caption the login screenshot.'))
  assert.ok(prompt.includes('[truncated'), 'context mechanically capped')
  for (const leaked of ['repair', 'budget', 'evidence', 'verdict', 'OPENROUTER', 'profile']) {
    assert.ok(
      !prompt.toLowerCase().includes(leaked.toLowerCase()),
      `specialist prompt must not carry internals: ${leaked}`,
    )
  }

  const budget = { maxCalls: 2, maxUsd: 1, maxTokens: 50000 }

  // 5. Free-first success: paid tier never fires.
  {
    const seen: string[] = []
    const fetchFn = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String((init as { body: string }).body)) as { model: string }
      seen.push(body.model)
      return okResponse('free caption')
    })
    const result = await askSpecialist(
      { kind: 'vision', prompt: 'Caption this.' },
      { fetchFn, apiKey: 'test-key', budget },
    )
    assert.equal(result.freeTier, true)
    assert.equal(result.text, 'free caption')
    assert.deepEqual(seen, [freeModelFor(VISION_MODEL)])
  }

  // 6. Free 429 → paid fallback serves.
  {
    const seen: string[] = []
    const fetchFn = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String((init as { body: string }).body)) as { model: string }
      seen.push(body.model)
      if (body.model.endsWith(':free')) return failResponse(429, 'rate limited')
      return okResponse('paid caption')
    })
    const result = await askSpecialist(
      { kind: 'vision', prompt: 'Caption this.' },
      { fetchFn, apiKey: 'test-key', budget },
    )
    assert.equal(result.freeTier, false)
    assert.equal(result.model, VISION_MODEL)
    assert.deepEqual(seen, [freeModelFor(VISION_MODEL), VISION_MODEL])
  }

  // 7. Text kind routes to the text model family.
  {
    const seen: string[] = []
    const fetchFn = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String((init as { body: string }).body)) as { model: string }
      seen.push(body.model)
      return okResponse('text answer')
    })
    const result = await askSpecialist(
      { kind: 'text', prompt: 'Explain this error.' },
      { fetchFn, apiKey: 'test-key', budget },
    )
    assert.ok(seen[0].startsWith(TEXT_MODEL), `text routes to flash, got ${seen[0]}`)
    assert.equal(result.text, 'text answer')
  }

  // 8. Budget blocks fire zero fetches: call cap, token cap, USD cap, missing key.
  {
    let fired = 0
    const counting = fakeFetch(async () => {
      fired += 1
      return okResponse('never')
    })
    await assert.rejects(
      askSpecialist({ kind: 'text', prompt: 'hi' }, { fetchFn: counting, apiKey: 'k', budget, callsMade: 2 }),
      /call/,
    )
    await assert.rejects(
      askSpecialist({ kind: 'text', prompt: 'hi' }, { fetchFn: counting, apiKey: 'k', budget, spentTokens: 999999 }),
      /token/,
    )
    await assert.rejects(
      askSpecialist({ kind: 'text', prompt: 'hi' }, { fetchFn: counting, apiKey: 'k', budget, spentUsd: 99 }),
      /USD/,
    )
    await assert.rejects(
      askSpecialist({ kind: 'text', prompt: 'hi' }, { fetchFn: counting, apiKey: '', budget }),
      /OPENROUTER_API_KEY/,
    )
    assert.equal(fired, 0, 'budget/key blocks must not touch the network')
  }

  // 9. Image cap: 5 images in, 3 sent (mechanical, raw material untouched).
  {
    let sent = 0
    const fetchFn = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String((init as { body: string }).body)) as {
        messages: Array<{ content: unknown }>
      }
      const content = body.messages[0].content
      assert.ok(Array.isArray(content), 'vision sends multipart content')
      sent = (content as unknown[]).filter(
        part => typeof part === 'object' && part !== null && (part as { type: string }).type === 'image_url',
      ).length
      return okResponse('caption')
    })
    await askSpecialist(
      { kind: 'vision', prompt: 'Caption.', images: ['a', 'b', 'c', 'd', 'e'] },
      { fetchFn, apiKey: 'test-key', budget },
    )
    assert.equal(sent, 3, 'images mechanically capped at 3')
  }

  // 10. Both tiers failing throws (paid error surfaces).
  {
    const fetchFn = fakeFetch(async () => failResponse(500, 'down'))
    await assert.rejects(
      askSpecialist({ kind: 'text', prompt: 'hi' }, { fetchFn, apiKey: 'k', budget }),
      /500/,
    )
  }

  console.log('ASK SPECIALIST TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

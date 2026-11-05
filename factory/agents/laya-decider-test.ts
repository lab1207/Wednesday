/**
 * Offline test for the laya decider. No network, no server, no weights:
 * injected fake fetch proves config, triggers, state hygiene, guard
 * preset, success parse, error paths, call-cap blocks, and the
 * confidence gate.
 */
import assert from 'node:assert/strict'

import {
  askLaya,
  buildLayaGuardQuestions,
  buildLayaRouterQuestions,
  buildLayaState,
  interpretGuard,
  interpretRoute,
  LAYA_DEFAULT_BASE_URL,
  resolveLayaConfig,
  shouldTriggerLaya,
} from './laya-decider'

function fakeFetch(
  handler: (url: string, init: { body?: unknown }) => Promise<Response>,
): typeof fetch {
  return ((url: string, init?: { body?: unknown }) => {
    return handler(url, { body: init?.body })
  }) as unknown as typeof fetch
}

function okResponse(answers: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ answers }),
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
  // 1. Config: disabled by default, opt-in explicit, trims + fallbacks.
  assert.equal(resolveLayaConfig({}).enabled, false)
  assert.equal(resolveLayaConfig({ FACTORY_LAYA_ENABLED: '1' }).enabled, true)
  assert.equal(resolveLayaConfig({ FACTORY_LAYA_ENABLED: 'true' }).enabled, true)
  assert.equal(
    resolveLayaConfig({}).baseURL,
    LAYA_DEFAULT_BASE_URL,
  )
  assert.equal(
    resolveLayaConfig({
      FACTORY_LAYA_ENABLED: '1',
      FACTORY_LAYA_BASE_URL: 'http://127.0.0.1:8000/',
    }).baseURL,
    'http://127.0.0.1:8000',
  )
  assert.equal(resolveLayaConfig({}).maxCalls, 2)
  assert.equal(
    resolveLayaConfig({ FACTORY_LAYA_MAX_CALLS: '0' }).maxCalls,
    0,
    'zero is a valid cap',
  )
  assert.equal(resolveLayaConfig({ FACTORY_LAYA_MAX_CALLS: 'junk' }).maxCalls, 2)
  assert.equal(resolveLayaConfig({}).minConfidence, 0.85)
  assert.equal(
    resolveLayaConfig({ FACTORY_LAYA_MIN_CONFIDENCE: '0.9' }).minConfidence,
    0.9,
  )
  assert.equal(
    resolveLayaConfig({ FACTORY_LAYA_MIN_CONFIDENCE: '99' }).minConfidence,
    0.85,
    'out-of-range falls back',
  )

  // 2. Trigger: non-empty objective fires guard, empty stays null.
  assert.equal(
    shouldTriggerLaya({ objective: 'Build a calculator.' }),
    'guard',
  )
  assert.equal(shouldTriggerLaya({ objective: '   ' }), null)
  assert.equal(shouldTriggerLaya({}), null)

  // 3. State hygiene: task carried, internals never leak, capped.
  const state = buildLayaState({
    objective: 'Build a calculator.',
    role: 'backend',
    stack: 'python',
    constraints: ['Use pytest'],
  })
  assert.ok(state.includes('Build a calculator.'))
  for (const leaked of ['repair', 'verdict', 'evidence', 'budget', 'API_KEY', 'profile']) {
    assert.ok(
      !state.toLowerCase().includes(leaked.toLowerCase()),
      `laya state must not carry internals: ${leaked}`,
    )
  }
  const long = buildLayaState({ objective: 'x'.repeat(5000) })
  assert.ok(long.includes('[truncated'), 'state mechanically capped')

  // 4. Guard preset: two noul questions, no internals.
  const questions = buildLayaGuardQuestions()
  assert.deepEqual(Object.keys(questions).sort(), ['injection', 'jailbreak'])
  assert.ok(Object.values(questions).every(question => question.type === 'noul'))

  // 5. Success: answers parsed, URL + body correct.
  {
    let seenUrl = ''
    const fetchFn = fakeFetch(async (url, init) => {
      seenUrl = url
      const body = JSON.parse(String((init as { body: string }).body)) as {
        state: string
        questions: unknown
      }
      assert.ok(body.state.includes('calculator'))
      assert.ok(body.questions)
      return okResponse({
        jailbreak: { type: 'noul', noul: 0.02 },
        injection: { type: 'noul', noul: 0.01 },
      })
    })
    const result = await askLaya('calculator task', questions, {
      fetchFn,
      baseURL: 'http://127.0.0.1:8000/',
    })
    assert.equal(seenUrl, `${LAYA_DEFAULT_BASE_URL}/v1/systemone`)
    assert.equal(typeof result.answers.jailbreak.noul, 'number')
  }

  // 6. Call cap blocks with zero fetches.
  {
    let fired = 0
    const counting = fakeFetch(async () => {
      fired += 1
      return okResponse({})
    })
    await assert.rejects(
      askLaya('s', questions, { fetchFn: counting, callsMade: 2, maxCalls: 2 }),
      /budget/,
    )
    assert.equal(fired, 0)
  }

  // 7. Question-count bounds enforced without network.
  {
    let fired = 0
    const counting = fakeFetch(async () => {
      fired += 1
      return okResponse({})
    })
    await assert.rejects(askLaya('s', {}, { fetchFn: counting }), /bounds/)
    assert.equal(fired, 0)
  }

  // 8. Server error + invalid JSON + missing answers all throw.
  {
    await assert.rejects(
      askLaya('s', questions, {
        fetchFn: fakeFetch(async () => failResponse(500, 'down')),
      }),
      /500/,
    )
    await assert.rejects(
      askLaya('s', questions, {
        fetchFn: fakeFetch(async () => ({ ok: true, status: 200, text: async () => 'not-json' }) as unknown as Response),
      }),
      /invalid JSON/,
    )
    await assert.rejects(
      askLaya('s', questions, {
        fetchFn: fakeFetch(async () => okResponse(undefined)),
      }),
      /no answers/,
    )
  }

  // 9. Confidence gate: below passes, at-threshold blocks.
  assert.deepEqual(
    interpretGuard(
      { jailbreak: { noul: 0.02 }, injection: { noul: 0.01 } },
      0.85,
    ),
    { blocked: false, hits: [] },
  )
  assert.deepEqual(
    interpretGuard({ jailbreak: { noul: 0.97 }, injection: { noul: 0.01 } }, 0.85),
    { blocked: true, hits: ['jailbreak'] },
  )

  // 10. Router preset: one choice question, pure route read.
  {
    const routerQuestions = buildLayaRouterQuestions()
    assert.deepEqual(Object.keys(routerQuestions), ['complexity'])
    assert.equal(routerQuestions.complexity.type, 'choice')
    assert.equal(interpretRoute({ complexity: { choice: 'trivial' } }), 'trivial')
    assert.equal(interpretRoute({ complexity: { choice: 'complex' } }), 'complex')
    assert.equal(interpretRoute({ complexity: { noul: 0.9 } }), null)
    assert.equal(interpretRoute({}), null)
  }

  console.log('LAYA DECIDER TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

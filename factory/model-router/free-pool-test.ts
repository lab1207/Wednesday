/**
 * Offline test for the free-pool resolver. Injected fake catalogs prove
 * parsing, preference order, pool-head fallback, and the opt-out flag —
 * no network, no key.
 */
import assert from 'node:assert/strict'

import {
  isFreePoolEnabled,
  listFreeModels,
  parseFreeModels,
  pickFreeModel,
  preferredFreeModels,
} from './free-pool'

function catalogResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

async function main(): Promise<void> {
  // 1. Enabled unless explicitly opted out.
  assert.equal(isFreePoolEnabled({}), true)
  assert.equal(isFreePoolEnabled({ FACTORY_FREE_POOL: '0' }), false)
  assert.equal(isFreePoolEnabled({ FACTORY_FREE_POOL: 'false' }), false)
  assert.equal(isFreePoolEnabled({ FACTORY_FREE_POOL: '1' }), true)

  // 2. Preferences parse in rank order, blanks dropped.
  assert.deepEqual(preferredFreeModels({}), [])
  assert.deepEqual(
    preferredFreeModels({ FACTORY_FREE_POOL_MODELS: ' a:free ,, b:free ' }),
    ['a:free', 'b:free'],
  )

  // 3. Parser keeps :free ids only, deduped, malformed-safe.
  assert.deepEqual(
    parseFreeModels({
      data: [
        { id: 'x/alpha:free' },
        { id: 'x/beta' },
        { id: 'x/alpha:free' },
        { id: 42 },
        'junk',
      ],
    }),
    ['x/alpha:free'],
  )
  assert.deepEqual(parseFreeModels({}), [])
  assert.deepEqual(parseFreeModels(null), [])

  // 4. Picker: preferred hit first, else pool head, else null.
  assert.equal(pickFreeModel(['a:free', 'b:free'], ['b:free']), 'b:free')
  assert.equal(pickFreeModel(['a:free'], []), 'a:free')
  assert.equal(pickFreeModel([], []), null)
  assert.equal(pickFreeModel(['a:free'], ['missing:free']), 'a:free')

  // 5. Live read with injected fetch resolves end to end.
  {
    const fetchFn = (async () => catalogResponse({
      data: [{ id: 'x/alpha:free' }, { id: 'x/paid' }],
    })) as unknown as typeof fetch
    assert.deepEqual(await listFreeModels({ fetchFn }), ['x/alpha:free'])
  }

  // 6. Catalog failure throws (the provider, not this module, falls back).
  {
    const fetchFn = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as Response as unknown as typeof fetch
    await assert.rejects(listFreeModels({ fetchFn }), /500/)
  }

  console.log('FREE POOL TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

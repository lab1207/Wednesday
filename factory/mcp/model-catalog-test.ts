import assert from 'node:assert/strict'

import {
  buildModelCatalogue,
  credentialState,
  type CatalogueProvider,
} from './model-catalog'

/**
 * The model catalogue's keyless regression.
 *
 * Stubs only: no real provider, no network, no real credential. The rules
 * pinned here are the ones that keep the catalogue honest — a route with no
 * credential is never queried, one broken route never breaks the rest, a
 * slow route never hangs the catalogue, and no credential value ever
 * reaches the result.
 */
async function main(): Promise<void> {
  // 1. a route with no credential is reported missing and NEVER queried.
  let missingCalled = false
  const missing: CatalogueProvider = {
    name: 'openrouter',
    listModels: async () => {
      missingCalled = true
      throw new Error('must not be called')
    },
  }
  const missingCatalogue = await buildModelCatalogue([missing], {})
  assert.equal(missingCalled, false, 'a missing-credential route must never be queried')
  assert.deepEqual(missingCatalogue, [{ provider: 'openrouter', credential: 'missing' }])

  // 2. a route with a credential is queried and its models are returned.
  const zen: CatalogueProvider = {
    name: 'zen',
    listModels: async () => ['zen/model-a', 'zen/model-b'],
  }
  const zenCatalogue = await buildModelCatalogue([zen], { ZEN_API_KEY: 'fake-zen-key' })
  assert.equal(zenCatalogue.length, 1)
  assert.equal(zenCatalogue[0]?.credential, 'present')
  assert.deepEqual(zenCatalogue[0]?.models, ['zen/model-a', 'zen/model-b'])

  // 3. the local route needs no credential and IS queried.
  let localCalled = false
  const local: CatalogueProvider = {
    name: 'local',
    listModels: async () => {
      localCalled = true
      return ['local/model']
    },
  }
  const localCatalogue = await buildModelCatalogue([local], {})
  assert.equal(localCalled, true, 'the local route needs no credential and must be queried')
  assert.equal(localCatalogue[0]?.credential, 'not-needed')
  assert.deepEqual(localCatalogue[0]?.models, ['local/model'])

  // 4. one broken route does not break the others.
  const broken: CatalogueProvider = {
    name: 'nvidia',
    listModels: async () => {
      throw new Error('boom')
    },
  }
  const mixed = await buildModelCatalogue([broken, local], { NVIDIA_API_KEY: 'fake-nvidia-key' })
  assert.equal(mixed.length, 2)
  assert.equal(mixed[0]?.credential, 'present')
  assert.match(String(mixed[0]?.error), /boom/)
  assert.equal(mixed[0]?.models, undefined)
  assert.deepEqual(mixed[1]?.models, ['local/model'])

  // 5. a route that never settles hits the deadline, and the catalogue still returns.
  const hanging: CatalogueProvider = {
    name: 'zen',
    listModels: () => new Promise<string[]>(() => {}),
  }
  const timedOut = await buildModelCatalogue([hanging], { ZEN_API_KEY: 'fake-zen-key' }, 50)
  assert.equal(timedOut.length, 1)
  assert.equal(timedOut[0]?.error, 'timeout after 50ms')

  // 6. no secret leaks: an error that carries a credential is scrubbed.
  // The fake is deliberately shorter than a real key shape: the leak scan
  // treats any `sk-` token of 20+ characters as a credential in the public
  // export, and this file ships there.
  const leaked = 'sk-fake-secret-abcdef'
  const leaky: CatalogueProvider = {
    name: 'openrouter',
    listModels: async () => {
      throw new Error(`request failed with key ${leaked}`)
    },
  }
  const scrubbed = await buildModelCatalogue([leaky], { OPENROUTER_API_KEY: leaked })
  assert.doesNotMatch(JSON.stringify(scrubbed), new RegExp(leaked))
  assert.equal(scrubbed[0]?.error !== undefined, true)

  // 7. the three credential words.
  assert.equal(credentialState('local', {}), 'not-needed')
  assert.equal(credentialState('nvidia', {}), 'missing')
  assert.equal(credentialState('nvidia', { NVIDIA_API_KEY: 'x' }), 'present')
  assert.equal(credentialState('openrouter', {}), 'missing')
  assert.equal(credentialState('openrouter', { OPENROUTER_API_KEY: 'x' }), 'present')
  assert.equal(credentialState('zen', {}), 'missing')
  assert.equal(credentialState('zen', { ZEN_API_KEY: 'x' }), 'present')
  assert.equal(credentialState('unknown-route', { OPENROUTER_API_KEY: 'x' }), 'missing')

  // 8. the entries come back in the order the providers were passed in.
  const ordered = await buildModelCatalogue(
    [local, zen, missing],
    { ZEN_API_KEY: 'fake-zen-key' },
  )
  assert.deepEqual(
    ordered.map(entry => entry.provider),
    ['local', 'zen', 'openrouter'],
  )

  console.log('MODEL CATALOGUE TEST: PASS (missing route never queried, throwing route degrades, hanging route times out, secret scrubbed, order kept)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

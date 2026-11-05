import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDefinition } from './definitions'

/**
 * C4 Phase C harder-fixture test — snippetbox-repair, offline.
 *
 * Proves the red starting state without a model: the definition resolves,
 * the buggy notes module exists and boots (unlike the base variant, which
 * cannot boot), the leak/miss defects are demonstrable, and `node --test`
 * exits non-zero. A live run must turn this red green.
 */

async function main(): Promise<void> {
  const definition = resolveDefinition('snippetbox-repair')
  assert.equal(definition.variant, 'snippetbox-repair-v1')
  assert.equal(definition.probes.length, 7)
  assert.deepEqual(definition.requiredFiles, [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ])

  const base = await mkdtemp(join(tmpdir(), 'snippetbox-repair-test-'))
  try {
    // The buggy module boots: health 200 (base variant ERR_MODULE_NOT_FOUND).
    process.env.SNIPPETBOX_STORE = join(base, 'data', 'notes.json')
    const app = await import(
      pathToFileURL(join(definition.fixtureDir, 'server', 'app.js')).href
    )
    const port = await app.start(0)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
      assert.equal(health.status, 200)
    } finally {
      await new Promise(resolve => app.server.close(resolve))
    }

    // Defects demonstrable without a model.
    const notes = await import(
      pathToFileURL(join(definition.fixtureDir, 'server', 'notes.js')).href
    )
    const data = { users: [], notes: [], tokens: [] }
    const created = notes.createNote(data, 'alice', 'hello')
    assert.ok(created.id, 'created note must have an id')
    const leaked = notes.listNotes(data, 'bob')
    assert.ok(
      leaked.length === 1,
      'buggy listNotes must leak alice\'s note to bob',
    )
    assert.equal(
      notes.getNote(data, created.id, 'alice'),
      null,
      'buggy getNote must miss on the string/Number mismatch',
    )

    // Deterministic red: `node --test` fails (auth stub → register 501).
    const child = spawnSync(process.execPath, ['--test'], {
      cwd: definition.fixtureDir,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      env: {
        ...process.env,
        SNIPPETBOX_STORE: join(base, 'data', 'notes-test.json'),
      },
    })
    assert.notEqual(
      child.status,
      0,
      'repair fixture must be red before a Factory run',
    )

    console.log('REPAIR FIXTURE TEST: PASS (definition, boots, defects shown, red)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

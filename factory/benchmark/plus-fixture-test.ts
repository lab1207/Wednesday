import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDefinition } from './definitions'

/**
 * R3 Relentless harder-fixture test — snippetbox-plus, offline.
 *
 * Proves the red starting state without a model: the definition resolves
 * with 10 probes (7 reused + 3 new), the app boots, the five defects are
 * demonstrable at the module level (leak, miss, unfiltered search, phantom
 * delete), and `node --test` exits non-zero. A live run must turn this
 * red green - its loop count is the relentlessness measure.
 */

async function main(): Promise<void> {
  const definition = resolveDefinition('snippetbox-plus')
  assert.equal(definition.variant, 'snippetbox-plus-v1')
  assert.equal(definition.probes.length, 10)
  assert.deepEqual(definition.requiredFiles, [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ])

  const base = await mkdtemp(join(tmpdir(), 'snippetbox-plus-test-'))
  try {
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

    const notes = await import(
      pathToFileURL(join(definition.fixtureDir, 'server', 'notes.js')).href
    )
    const data = { users: [], notes: [], tokens: [] }
    notes.createNote(data, 'alice', 'buy milk')
    notes.createNote(data, 'alice', 'read book')
    const leaked = notes.listNotes(data, 'bob')
    assert.ok(
      leaked.length === 2,
      'buggy listNotes must leak alice\u2019s notes to bob',
    )
    const unfiltered = notes.searchNotes(data, 'alice', 'milk')
    assert.ok(
      unfiltered.length === 2,
      'buggy searchNotes must ignore the query',
    )
    assert.equal(
      notes.deleteNote(data, '0', 'alice'),
      true,
      'buggy deleteNote must report success',
    )
    assert.equal(
      data.notes.length,
      2,
      'buggy deleteNote must delete nothing',
    )

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
      'plus fixture must be red before a Factory run',
    )

    console.log('PLUS FIXTURE TEST: PASS (definition, boots, defects shown, red)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

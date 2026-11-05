import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { resolveDefinition } from './definitions'

/**
 * New-shape fixture test — snippetbox-refactor + snippetbox-logs, offline.
 *
 * Proves the starting states without a model:
 * - refactor resolves with 9 probes (7 reused base + 2 validation); the app
 *   boots; behavior is CORRECT at the module level (isolation holds, ids
 *   unique) while validation is absent (empty content storable); the two
 *   validation tests fail so `node --test` exits non-zero (red).
 * - logs resolves with 7 base probes; LOGS.md ships beside the buggy code;
 *   the app boots; the leak defect is demonstrable; `node --test` is red.
 * A live run must turn each red green.
 */

function runTests(fixtureDir: string, storeName: string) {
  return spawnSync(process.execPath, ['--test'], {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: {
      ...process.env,
      SNIPPETBOX_STORE: join(tmpdir(), storeName),
    },
  })
}

async function bootHealth(fixtureDir: string, storeName: string): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'newshape-test-'))
  try {
    process.env.SNIPPETBOX_STORE = join(base, 'data', 'notes.json')
    const app = await import(
      pathToFileURL(join(fixtureDir, 'server', 'app.js')).href
    )
    const port = await app.start(0)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
      assert.equal(health.status, 200)
    } finally {
      await new Promise(resolve => app.server.close(resolve))
    }
  } finally {
    await rm(base, { recursive: true, force: true })
    void storeName
  }
}

async function main(): Promise<void> {
  // --- 1. Refactor: working behavior, missing validation. ---
  const refactor = resolveDefinition('snippetbox-refactor')
  assert.equal(refactor.variant, 'snippetbox-refactor-v1')
  assert.equal(refactor.probes.length, 9)
  assert.deepEqual(refactor.requiredFiles, [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ])
  await bootHealth(refactor.fixtureDir, 'notes-refactor-test.json')

  const refactorNotes = await import(
    pathToFileURL(join(refactor.fixtureDir, 'server', 'notes.js')).href
  )
  const rdata = { users: [], notes: [], tokens: [] }
  refactorNotes.createNote(rdata, 'alice', 'buy milk')
  refactorNotes.createNote(rdata, 'alice', 'read book')
  const own = refactorNotes.listNotes(rdata, 'alice')
  assert.equal(own.length, 2, 'working listNotes must isolate alice’s notes')
  assert.equal(
    refactorNotes.listNotes(rdata, 'bob').length,
    0,
    'working listNotes must leak nothing to bob',
  )
  const ids = new Set(rdata.notes.map((n: { id: string }) => n.id))
  assert.equal(ids.size, 2, 'working ids must be unique')

  const refactorChild = runTests(refactor.fixtureDir, 'notes-refactor-test.json')
  assert.notEqual(
    refactorChild.status,
    0,
    'refactor fixture must be red (validation missing) before a Factory run',
  )

  // --- 2. Logs: buggy code plus captured diagnosis source. ---
  const logs = resolveDefinition('snippetbox-logs')
  assert.equal(logs.variant, 'snippetbox-logs-v1')
  assert.equal(logs.probes.length, 7)
  assert.ok(
    existsSync(join(logs.fixtureDir, 'LOGS.md')),
    'LOGS.md must ship beside the buggy code',
  )
  await bootHealth(logs.fixtureDir, 'notes-logs-test.json')

  const logsNotes = await import(
    pathToFileURL(join(logs.fixtureDir, 'server', 'notes.js')).href
  )
  const ldata = { users: [], notes: [], tokens: [] }
  logsNotes.createNote(ldata, 'alice', 'buy milk')
  logsNotes.createNote(ldata, 'alice', 'read book')
  assert.equal(
    logsNotes.listNotes(ldata, 'bob').length,
    2,
    'buggy listNotes must leak alice’s notes to bob (matches LOGS.md)',
  )

  const logsChild = runTests(logs.fixtureDir, 'notes-logs-test.json')
  assert.notEqual(
    logsChild.status,
    0,
    'logs fixture must be red before a Factory run',
  )

  console.log('NEW SHAPES FIXTURE TEST: PASS (refactor + logs: definition, boots, defects shown, red)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

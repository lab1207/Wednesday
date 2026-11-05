import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDefinition } from './definitions'

/**
 * Website-build benchmark test — sitebuild-landing, offline.
 *
 * Proves the red starting state without a model: the definition resolves
 * with 4 probes, the static server boots (/ → 200), the content markers
 * are absent from the shell page, and `node --test` exits non-zero. A
 * live run must turn this red green - and the result opens straight from
 * disk (relative paths, no backend).
 */

async function main(): Promise<void> {
  const definition = resolveDefinition('sitebuild-landing')
  assert.equal(definition.variant, 'sitebuild-landing-v1')
  assert.equal(definition.probes.length, 4)
  assert.deepEqual(definition.requiredFiles, [
    'server/app.js',
    'public/index.html',
    'public/styles.css',
    'public/app.js',
  ])

  const base = await mkdtemp(join(tmpdir(), 'sitebuild-test-'))
  try {
    const app = await import(
      pathToFileURL(join(definition.fixtureDir, 'server', 'app.js')).href
    )
    const port = await app.start(0)
    try {
      const home = await fetch(`http://127.0.0.1:${port}/`)
      assert.equal(home.status, 200)
      const text = await home.text()
      assert.ok(text.includes('<title>PedalWorks</title>'))
      for (const marker of ['id="hero"', 'id="features"', 'id="pricing"', 'id="contact"']) {
        assert.ok(!text.includes(marker), `shell page must lack ${marker}`)
      }
      const css = await (await fetch(`http://127.0.0.1:${port}/styles.css`)).text()
      assert.ok(css.length <= 200, 'stub stylesheet must stay trivial')
    } finally {
      await new Promise(resolve => app.server.close(resolve))
    }

    // Relative paths only - the page must work from disk.
    const html = await readFile(join(definition.fixtureDir, 'public', 'index.html'), 'utf8')
    assert.ok(!/https?:\/\//.test(html), 'no absolute URLs allowed')

    const child = spawnSync(process.execPath, ['--test'], {
      cwd: definition.fixtureDir,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    })
    assert.notEqual(
      child.status,
      0,
      'sitebuild fixture must be red before a Factory run',
    )

    console.log('SITEBUILD TEST: PASS (definition, boots, shell shown, red)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

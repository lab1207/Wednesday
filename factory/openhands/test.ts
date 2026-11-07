import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeRepository } from './connector'

// Must be set before createFactoryService() selects the provider.
process.env.FACTORY_EXECUTION_MODE = 'deterministic'

/**
 * THE TEST MUST NOT WRITE INTO THE OPERATOR'S REAL STATE (2026-11-07).
 *
 * This suite ran a real Factory run against the default state home, so
 * its events landed in the operator's own
 * `~/.wednesday/state/events.jsonl` - 396 fake events from this suite
 * alone. The state home is set BEFORE the service module is imported:
 * `paths.ts` resolves the paths at import time.
 */
const stateHome =
  mkdtempSync(
    join(
      tmpdir(),
      'openhands-test-',
    ),
  )

process.env.WEDNESDAY_STATE_HOME =
  stateHome
process.env.FACTORY_EVENTS_PATH =
  join(stateHome, 'events.jsonl')
process.env.HERMES_TASKS_PATH =
  join(stateHome, 'tasks.json')

const { createFactoryService } = await import('../service')

// The service is held here so the exit path can dispose it (see the bottom
// of this file).
let activeService: { dispose(): Promise<void> } | undefined

/**
 * V1.4 OpenHands connector test — repository understanding.
 *
 * Real fixture workspace on disk (not mocked): the connector must profile
 * actual files, and the profile must flow into a real Factory run that
 * completes. Deterministic execution, no model calls.
 */

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'openhands-'))
  try {
    // -- fixture: a small real repo -------------------------------------
    await mkdir(join(directory, 'src'), { recursive: true })
    await writeFile(join(directory, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', main: 'src/index.ts', dependencies: { undici: '^8.10.2' } }))
    await writeFile(join(directory, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic>=2",\n]\n')
    await writeFile(join(directory, 'Cargo.toml'),
      '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n')
    await writeFile(join(directory, 'src/index.ts'), "import { id } from './util'\nexport const main = () => id(1)\n")
    await writeFile(join(directory, 'src/util.ts'), 'export const id = <T>(x: T) => x\n')
    await writeFile(join(directory, 'src/index.test.ts'), "import assert from 'node:assert'\nassert.equal(1, 1)\n")
    await writeFile(join(directory, 'README.md'), '# demo\n')

    // -- connector: profile the real workspace --------------------------
    const profile = await analyzeRepository(directory)
    assert.equal(profile.workspace, directory)
    assert.equal(profile.exists, true)
    assert.equal(profile.fileCount, 7)
    assert.ok(profile.languages.includes('TypeScript'), `languages: ${profile.languages}`)
    assert.ok(profile.keyFiles.includes('package.json'))
    assert.ok(profile.keyFiles.includes('pyproject.toml'), `keys: ${profile.keyFiles}`)
    assert.ok(profile.keyFiles.includes('Cargo.toml'), `keys: ${profile.keyFiles}`)
    assert.ok(profile.keyFiles.includes('README.md'))
    assert.ok(profile.entryCandidates.includes('src/index.ts'))
    // C1 depth (static-only): deps + test mapping + import edges
    assert.ok(profile.dependencies.includes('undici'), `deps: ${profile.dependencies}`)
    assert.ok(profile.dependencies.includes('httpx'), `pyproject deps: ${profile.dependencies}`)
    assert.ok(profile.dependencies.includes('serde'), `cargo deps: ${profile.dependencies}`)
    assert.ok(profile.testFiles.includes('src/index.test.ts'), `tests: ${profile.testFiles}`)
    assert.ok(profile.importEdgeCount >= 1, `edges: ${profile.importEdgeCount}`)
    const constraints = profile.toConstraints()
    assert.ok(constraints.length > 0)
    assert.ok(constraints.every(line => line.startsWith('Repository context:')),
      `constraints: ${constraints}`)
    assert.ok(constraints.some(line => line.includes('undici')), `constraints: ${constraints}`)
    assert.ok(constraints.some(line => line.includes('src/index.test.ts')), `constraints: ${constraints}`)

    // -- empty/missing workspace degrades honestly ----------------------
    const missing = await analyzeRepository(join(directory, 'no-such-dir'))
    assert.equal(missing.exists, false)
    assert.equal(missing.fileCount, 0)

    // -- repeat analysis stays full (module walk counter resets per call;
    // long-lived service/harness processes analyze many workspaces) -------
    for (let round = 0; round < 3; round++) {
      const again = await analyzeRepository(directory)
      assert.equal(again.fileCount, 7, `round ${round}: profile must not degrade`)
    }

    // -- end-to-end: profile feeds a real Factory run -------------------
    const service = await createFactoryService()
    activeService = service
    const result = await service.run({
      id: 'openhands-e2e-001',
      workspace: directory,
      objective: `Summarize the repository at ${directory}.`,
      role: 'backend',
      stack: profile.languages.join(', '),
      constraints: constraints,
      acceptanceCriteria: ['Repository context reflects the real workspace.'],
      verification: { setupCommands: [], testCommands: ['cmd /c exit 0'] },
      modelRequirements: { capability: 'coding' },
    })
    assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics))

    console.log('OPENHANDS CONNECTOR TEST: PASS (real workspace profiled, Factory e2e completed)')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  // THE SERVICE MUST BE DISPOSED (2026-11-07).
  //
  // The service's skill filesystem watches every skill root it discovers
  // (about twenty-three open handles). A forced `process.exit()` tears
  // those handles down mid-close, and libuv asserts on it: the process
  // died with 0xC0000409 instead of exiting 0. Disposing closes the
  // watchers properly, and the process ends on its own.
  try {
    await activeService?.dispose()
  } catch {
    // Best effort: the proof has already been printed.
  }
  rmSync(
    stateHome,
    {
      recursive: true,
      force: true,
    },
  )
})

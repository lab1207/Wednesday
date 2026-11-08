/**
 * Zero-config detection test — the harness must work with zero flags.
 *
 * Real temp workspaces (no model, no network): node / python / rust / go
 * projects pick their own test command; an empty directory falls back to
 * node defaults AND reports why, so the operator is never silently
 * wrong. Explicit --test always wins (asserted at the call site).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectDefaults,
  hasProjectMarker,
  NONEMPTY_WORKSPACE_CHECK,
  packageGateCommands,
  packageHasTestScript,
  packageScripts,
} from './defaults'

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'wednesday-defaults-'))
  try {
    // 1. node project: the test script, and nothing else when no gate exists.
    const node = join(base, 'node-app')
    await mkdir(node, { recursive: true })
    await writeFile(join(node, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')
    const nodeDefaults = detectDefaults(node)
    assert.deepEqual(nodeDefaults.tests, ['npm test'])
    assert.equal(nodeDefaults.stack, 'node')
    assert.equal(nodeDefaults.role, 'backend')
    assert.equal(packageHasTestScript(node), true)
    assert.equal(hasProjectMarker(node), true)

    // 1b. THE TYPE-CHECK GATE (2026-11-08, the third ask). A TypeScript
    //     workspace that declares a gate must get it: a sub-3B model's most
    //     common defect is a syntax slip, and the compiler is the cheapest
    //     reader of one. Before this, the same workspace answered `npm test`
    //     and nothing else, so a missing brace shipped as a passing run.
    const ts = join(base, 'ts-app')
    await mkdir(ts, { recursive: true })
    await writeFile(join(ts, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' },
    }), 'utf8')
    await writeFile(join(ts, 'tsconfig.json'), '{}', 'utf8')
    const tsDefaults = detectDefaults(ts)
    assert.deepEqual(tsDefaults.tests, ['npm test', 'npm run typecheck', 'npm run lint'])
    assert.ok(
      tsDefaults.reason.includes('gate'),
      'the reason must name the gates: ' + tsDefaults.reason,
    )

    // 1c. A manifest with NO test script but a gate: the gate runs, and
    //     `npm test` -- a command that can never pass -- is NOT guessed.
    //     A red-before-it-starts run is the same defect class as a broken
    //     gate (B222), not a product failure.
    const gateOnly = join(base, 'gate-only')
    await mkdir(gateOnly, { recursive: true })
    await writeFile(join(gateOnly, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'tsc --noEmit' },
    }), 'utf8')
    const gateDefaults = detectDefaults(gateOnly)
    assert.deepEqual(gateDefaults.tests, ['npm run typecheck'])
    assert.ok(
      !gateDefaults.tests.includes('npm test'),
      'a manifest with no test script must not be handed a command that cannot pass',
    )

    // 1d. A manifest with neither: the non-empty check, with a reason.
    const bare = join(base, 'bare-pkg')
    await mkdir(bare, { recursive: true })
    await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    assert.deepEqual(detectDefaults(bare).tests, [NONEMPTY_WORKSPACE_CHECK])
    assert.ok(detectDefaults(bare).reason.includes('no "test" script'))

    // 1e. Only the DECLARED scripts are used. A guessed `npx tsc` would
    //     download a toolchain on a machine that has none, which turns a
    //     missing dependency into a failed run.
    const tsNoScripts = join(base, 'ts-no-scripts')
    await mkdir(tsNoScripts, { recursive: true })
    await writeFile(join(tsNoScripts, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5' } }), 'utf8')
    await writeFile(join(tsNoScripts, 'tsconfig.json'), '{}', 'utf8')
    assert.deepEqual(detectDefaults(tsNoScripts).tests, [NONEMPTY_WORKSPACE_CHECK])

    // 1f. A broken manifest is not a crash.
    const broken = join(base, 'broken-pkg')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'package.json'), '{not json', 'utf8')
    assert.deepEqual(detectDefaults(broken).tests, [NONEMPTY_WORKSPACE_CHECK])

    // 2. python project (pyproject wins over requirements)
    const py = join(base, 'py-app')
    await mkdir(py, { recursive: true })
    await writeFile(join(py, 'pyproject.toml'), '[project]\nname="x"\n', 'utf8')
    await writeFile(join(py, 'requirements.txt'), 'pytest\n', 'utf8')
    const pyDefaults = detectDefaults(py)
    assert.deepEqual(pyDefaults.tests, ['python -m pytest -q'])
    assert.equal(pyDefaults.stack, 'python')

    // 3. rust + go
    const rs = join(base, 'rs-app')
    await mkdir(rs, { recursive: true })
    await writeFile(join(rs, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8')
    assert.deepEqual(detectDefaults(rs).tests, ['cargo test'])
    const go = join(base, 'go-app')
    await mkdir(go, { recursive: true })
    await writeFile(join(go, 'go.mod'), 'module x\n', 'utf8')
    assert.deepEqual(detectDefaults(go).tests, ['go test ./...'])

    // 4. python test dir without a manifest
    const testsOnly = join(base, 'tests-only')
    await mkdir(join(testsOnly, 'tests'), { recursive: true })
    const t = detectDefaults(testsOnly)
    assert.deepEqual(t.tests, ['python -m pytest -q'])
    assert.equal(t.reason, 'python test dir found')

    // 5. source dir without a manifest → non-empty check (npm test cannot run without package.json)
    const srcOnly = join(base, 'src-only')
    await mkdir(join(srcOnly, 'src'), { recursive: true })
    const s = detectDefaults(srcOnly)
    assert.deepEqual(s.tests, [NONEMPTY_WORKSPACE_CHECK])
    assert.equal(s.reason, 'source dir found, no manifest — non-empty workspace check')
    assert.equal(hasProjectMarker(srcOnly), false, 'guessed dirs must report no marker')

    // 6. empty dir → non-empty workspace check with a visible reason
    const empty = join(base, 'empty')
    await mkdir(empty, { recursive: true })
    const e = detectDefaults(empty)
    assert.deepEqual(e.tests, [NONEMPTY_WORKSPACE_CHECK])
    assert.equal(e.reason, 'nothing recognisable — non-empty workspace check')
    assert.equal(packageHasTestScript(empty), false)
    assert.equal(hasProjectMarker(empty), false)

    // 6b. the fallback check itself: fails on empty dir, passes once a file exists
    const { execFileSync } = await import('node:child_process')
    assert.throws(() => execFileSync('node', ['-e', "const fs=require('fs');process.exit(fs.readdirSync('.').length===0?1:0)"], { cwd: empty, stdio: 'pipe' }))
    await writeFile(join(empty, 'index.html'), '<h1>hi</h1>', 'utf8')
    execFileSync('node', ['-e', "const fs=require('fs');process.exit(fs.readdirSync('.').length===0?1:0)"], { cwd: empty, stdio: 'pipe' })

    // 6c. The gate detection is readable on its own (pure, exported).
    assert.deepEqual(packageGateCommands(ts), ['npm run typecheck', 'npm run lint'])
    assert.deepEqual(packageGateCommands(node), [])
    assert.deepEqual(packageScripts(ts).typecheck, 'tsc --noEmit')
    assert.deepEqual(packageScripts(broken), {})

    // 7. unreadable path must not throw (never block startup on detection)
    const gone = detectDefaults(join(base, 'does-not-exist'))
    assert.deepEqual(gone.tests, [NONEMPTY_WORKSPACE_CHECK])

    console.log('DEFAULTS TEST: PASS (manifests pick real commands, manifest-less dirs get the non-empty check, never throws)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
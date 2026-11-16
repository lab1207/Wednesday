import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runtimeRoot } from './paths'

/**
 * The runtime resolver's regression (2026-11-16).
 *
 * npm hoists an optional dependency out of the package that asks for it,
 * so the installed runtime normally sits in the scope ABOVE the package.
 * The postinstall learned to find it there (`scripts/link-runtime.js`), and
 * the task runner has to find it there too — otherwise a clean GitHub
 * install is silently degraded: the CLI works and running a task does not.
 *
 * Keyless, offline, and it never touches the operator's real install: every
 * layout is built in a temp directory.
 */
async function main(): Promise<void> {
  const platform = `${process.platform}-${process.arch}`
  const packageDir = `wednesday-runtime-${platform}`
  const base = await mkdtemp(join(tmpdir(), 'wednesday-runtime-paths-'))

  /** Build a runtime closure: <scope>/<packageDir>/runtime/node_modules/@deepseek-ai/dsh-app-boot */
  function buildRuntime(scope: string): string {
    const runtime = join(scope, packageDir, 'runtime')
    mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), '{"name":"dsh-app-boot"}', 'utf8')
    return runtime
  }

  try {
    // 1. the NESTED layout: the runtime package sits inside the package.
    const nestedRoot = join(base, 'nested', 'node_modules', '@lab1207', 'wednesday')
    const nestedRuntime = buildRuntime(join(nestedRoot, 'node_modules', '@lab1207'))
    assert.equal(
      runtimeRoot(nestedRoot, join(nestedRoot, 'factory', 'dsh-worker')),
      nestedRuntime,
      'the nested layout must resolve',
    )

    // 2. the HOISTED layout: the runtime package sits in the scope above.
    // This is what a normal `npm install` produces, and it is the layout
    // that used to be missed.
    const scope = join(base, 'hoisted', 'node_modules', '@lab1207')
    const hoistedInstall = join(scope, 'wednesday')
    mkdirSync(hoistedInstall, { recursive: true })
    const hoistedRuntime = buildRuntime(scope)
    assert.equal(
      runtimeRoot(hoistedInstall, join(hoistedInstall, 'factory', 'dsh-worker')),
      hoistedRuntime,
      'the hoisted layout must resolve',
    )

    // 3. the DEV layout: the provisioned closure under the worker directory.
    // The dev closure is the runtime directory ITSELF (`deploy/runtime`),
    // not a packaged runtime.
    const devInstall = join(base, 'dev')
    const devWorker = join(devInstall, 'factory', 'dsh-worker')
    const devRuntime = join(devWorker, 'deploy', 'runtime')
    mkdirSync(join(devRuntime, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    writeFileSync(join(devRuntime, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), '{"name":"dsh-app-boot"}', 'utf8')
    assert.equal(
      runtimeRoot(devInstall, devWorker),
      devRuntime,
      'the provisioned dev closure must resolve',
    )

    // 4. nothing installed: no runtime, no crash.
    const empty = join(base, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(
      runtimeRoot(empty, join(empty, 'factory', 'dsh-worker')),
      undefined,
      'an install without a runtime reports no runtime',
    )

    console.log('RUNTIME ROOT TEST: PASS (nested, hoisted and dev layouts resolve; an empty install reports none)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

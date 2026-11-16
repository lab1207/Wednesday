// Runtime seam backfill — keyless proof (2026-11-16).
//
// The backfill copies a vendored seam package into an installed runtime
// closure that lacks it. The test builds fake closures and extras under a
// temporary directory: nothing here touches the operator's machine state,
// the network or a credential.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillRuntimeExtras, runtimeExtrasRoot } from './runtime-extras'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'wednesday-runtime-extras-'))

try {
  // 1. A package the closure lacks is copied, with identical content.
  const closure = join(temporaryRoot, 'closure')
  const extras = join(temporaryRoot, 'extras')
  const seam = join(extras, '@deepseek-ai', 'dsh-pwsh-local')
  await mkdir(seam, { recursive: true })
  await writeFile(join(seam, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-local' }))
  await mkdir(join(seam, 'lib'), { recursive: true })
  await writeFile(join(seam, 'lib', 'index.js'), 'export const seam = true\n')

  const first = await backfillRuntimeExtras(closure, extras)
  assert.deepEqual(first.copied, ['@deepseek-ai/dsh-pwsh-local'])
  assert.deepEqual(first.skipped, [])
  assert.deepEqual(first.errors, [])
  const copied = join(closure, 'node_modules', '@deepseek-ai', 'dsh-pwsh-local', 'lib', 'index.js')
  assert.equal(await readFile(copied, 'utf8'), 'export const seam = true\n')

  // 2. A package the closure already has is skipped, and its files are NOT
  //    overwritten: the closure's own version always wins.
  const existing = join(closure, 'node_modules', '@deepseek-ai', 'dsh-pwsh-local', 'lib', 'index.js')
  await writeFile(existing, 'the closure owns this file\n')
  const second = await backfillRuntimeExtras(closure, extras)
  assert.deepEqual(second.copied, [])
  assert.deepEqual(second.skipped, ['@deepseek-ai/dsh-pwsh-local'])
  assert.deepEqual(second.errors, [])
  assert.equal(await readFile(existing, 'utf8'), 'the closure owns this file\n')

  // 3. A second run over the same closure copies nothing (idempotent).
  const third = await backfillRuntimeExtras(closure, extras)
  assert.deepEqual(third.copied, [])
  assert.deepEqual(third.skipped, ['@deepseek-ai/dsh-pwsh-local'])

  // 4. A package whose manifest name is not @scope/name is refused.
  const badShape = join(extras, '@deepseek-ai', 'bad-shape')
  await mkdir(badShape, { recursive: true })
  await writeFile(join(badShape, 'package.json'), JSON.stringify({ name: 'not-a-scoped-package' }))
  const refusedShape = await backfillRuntimeExtras(closure, extras)
  assert.deepEqual(refusedShape.copied, [])
  assert.ok(refusedShape.errors.some(error => error.includes('not-a-scoped-package')))
  assert.equal(await exists(join(closure, 'node_modules', 'not-a-scoped-package')), false)

  // 5. A package whose name would leave the closure is refused, and nothing
  //    is written outside it.
  const escaping = join(extras, '@deepseek-ai', 'escaping')
  await mkdir(escaping, { recursive: true })
  await writeFile(join(escaping, 'package.json'), JSON.stringify({ name: '@deepseek-ai/../../escaped' }))
  const refusedEscape = await backfillRuntimeExtras(closure, extras)
  assert.deepEqual(refusedEscape.copied, [])
  assert.ok(refusedEscape.errors.some(error => error.includes('@deepseek-ai/../../escaped')))
  assert.equal(await exists(join(temporaryRoot, 'escaped')), false)
  assert.equal(await exists(join(closure, 'escaped')), false)

  // 6. A missing extras directory is reported, not thrown.
  const missing = await backfillRuntimeExtras(closure, join(temporaryRoot, 'no-such-extras'))
  assert.deepEqual(missing.copied, [])
  assert.deepEqual(missing.skipped, [])
  assert.equal(missing.errors.length, 1)

  // 7. The REAL vendored extras: exactly the two PowerShell seam packages,
  //    each with a manifest and a built entry point.
  const realExtras = runtimeExtrasRoot()
  const scopes = await readdirNames(join(realExtras, '@deepseek-ai'))
  assert.deepEqual(scopes.sort(), ['dsh-pwsh-local', 'dsh-tool-pwsh'])
  for (const name of scopes) {
    const directory = join(realExtras, '@deepseek-ai', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string }
    assert.equal(manifest.name, `@deepseek-ai/${name}`)
    assert.equal(await exists(join(directory, 'lib', 'index.js')), true)
  }

  console.log('RUNTIME EXTRAS TEST: PASS (missing copied, existing skipped and untouched, idempotent, bad name refused, escape refused, missing extras reported, real seam packages present)')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function readdirNames(directory: string): Promise<string[]> {
  return readdir(directory)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

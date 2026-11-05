import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the npm packaging surface. A shipped module that imports a file the
 * `files` allowlist excludes is a release-blocking break: the published TUI
 * would die on `ERR_MODULE_NOT_FOUND` before it printed a prompt.
 *
 * This is the regression for the 2026-11-02 audit finding:
 * `connect.ts` imports `dsh-worker/local-tool-proxy.ts`, but package.json
 * excluded `factory/dsh-worker/local-tool-proxy*.ts` from the tarball.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const pkg = createRequire(import.meta.url)('../../package.json') as {
  files?: string[]
  bin?: Record<string, string>
  scripts?: Record<string, string>
}

const files = pkg.files ?? []
assert.ok(files.includes('factory/'), 'the factory tree is the product')
assert.ok(!files.some(pattern => /local-tool-proxy/.test(pattern)), 'local-tool-proxy must not be excluded')
assert.ok(files.some(pattern => pattern.replace(/\s/g, '') === '!factory/tmp/'), 'factory/tmp probe scripts must be excluded from the tarball')
assert.ok(existsSync(join(root, 'factory', 'dsh-worker', 'local-tool-proxy.ts')), 'proxy source exists')

const connect = readFileSync(join(root, 'factory', 'harness', 'connect.ts'), 'utf8')
assert.match(connect, /from '\.\.\/dsh-worker\/local-tool-proxy'/, 'connect.ts imports the proxy')
assert.ok(existsSync(join(root, pkg.bin?.wednesday ?? 'bin/wednesday.js')), 'bin entry exists')

// install hooks must stay local: no network in postinstall
const postinstall = pkg.scripts?.postinstall ?? ''
assert.ok(!/curl|wget|https?:\/\//i.test(postinstall), 'postinstall must not download anything')
assert.ok(!files.some(pattern => /\.env|\.openhands/.test(pattern)), 'never ship secret files')

console.log('PACKAGE SURFACE TEST: PASS (proxy included, bin present, postinstall offline, no secret files)')

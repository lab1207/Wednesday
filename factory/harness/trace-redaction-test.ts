import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { traceNote } from './screen.js'

/**
 * The WEDNESDAY_TRACE file records typed input, and operators paste keys.
 * Regression: a pasted secret must never land in a trace shared for debugging.
 */
async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wednesday-trace-'))
  const path = join(dir, 'trace.log')
  const previousTrace = process.env.WEDNESDAY_TRACE
  const previousKey = process.env.ACME_API_KEY
  process.env.WEDNESDAY_TRACE = path
  process.env.ACME_API_KEY = 'trace-secret-value-123456'
  try {
    traceNote('dispatch "my key is trace-secret-value-123456 and Bearer abcdefghijklmnop"')
    const text = await readFile(path, 'utf8')
    assert.doesNotMatch(text, /trace-secret-value-123456/)
    assert.doesNotMatch(text, /Bearer abcdefghijklmnop/)
    assert.match(text, /\[REDACTED\]/)
  } finally {
    if (previousTrace === undefined) delete process.env.WEDNESDAY_TRACE
    else process.env.WEDNESDAY_TRACE = previousTrace
    if (previousKey === undefined) delete process.env.ACME_API_KEY
    else process.env.ACME_API_KEY = previousKey
    await rm(dir, { recursive: true, force: true })
  }
  console.log('TRACE REDACTION TEST: PASS (typed secrets never reach the trace file)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

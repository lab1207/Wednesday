import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractFencedToolCalls, runFencedToolCalls } from './fenced-tools'

async function main(): Promise<void> {
  // 1. extraction: flat form the 3B model emits + arguments form + noise
  const text = [
    'Here is the read:',
    '```json {"name":"read","file_path":"index.html"}```',
    'and a write with nested arguments:',
    '```json {"name":"write","arguments":{"file_path":"a.txt","content":"hi"}}```',
    '```json {"not":"a tool call"}```',
    '```python\nprint("not json")\n```',
    'plain text without fences {"name":"read"}',
  ].join('\n')
  const calls = extractFencedToolCalls(text)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { name: 'read', args: { file_path: 'index.html' } })
  assert.deepEqual(calls[1], { name: 'write', args: { file_path: 'a.txt', content: 'hi' } })

  // 2. execution: write then read then bash, confined to the workspace
  const base = await mkdtemp(join(tmpdir(), 'wednesday-fenced-'))
  try {
    const transcript = await runFencedToolCalls(base, [
      { name: 'write', args: { file_path: 'sub/hello.txt', content: 'hello fenced' } },
      { name: 'read', args: { file_path: 'sub/hello.txt' } },
      { name: 'bash', args: { command: 'node -e "console.log(require(\'fs\').readFileSync(\'sub/hello.txt\',\'utf8\').trim())"' } },
    ])
    assert.equal(readFileSync(join(base, 'sub', 'hello.txt'), 'utf8'), 'hello fenced')
    assert.match(transcript, /bytes written/)
    assert.match(transcript, /hello fenced/)
    assert.match(transcript, /\[bash /)

    // 3. path escape is refused, not executed
    const escaped = await runFencedToolCalls(base, [
      { name: 'write', args: { file_path: '../escape.txt', content: 'nope' } },
    ])
    assert.match(escaped, /failed/)
    assert.match(escaped, /escapes workspace/)

    // 4. unknown tool reports failure without throwing
    const unknown = await runFencedToolCalls(base, [{ name: 'teleport', args: {} }])
    assert.match(unknown, /unsupported tool/)

    // 5. `ls` never goes through a shell. A model-written directory name with
    // shell metacharacters must be listed literally, not executed (the old
    // `node -e "... " + JSON.stringify(dir)` form was a command-injection
    // path on POSIX: `$(...)` inside double quotes runs).
    const weird = process.platform === 'win32' ? 'bad & echo PWNED' : 'bad$(echo PWNED)'
    mkdirSync(join(base, weird))
    const listed = await runFencedToolCalls(base, [{ name: 'ls', args: { path: '.' } }])
    assert.match(listed, /bad/, 'the directory name is listed')
    assert.doesNotMatch(listed, /failed|ENOENT/, 'listing must not execute or fail on the name')
    assert.equal(
      listed.split('\n').filter(line => line.includes('PWNED')).length,
      1,
      'a shell would add a second PWNED line from the injected echo',
    )

    console.log('FENCED TOOLS TEST: PASS (extract flat+nested, execute write/read/bash, escape refused, ls shell-free)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

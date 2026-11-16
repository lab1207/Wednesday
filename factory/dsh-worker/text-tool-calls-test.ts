import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractTextToolCalls, runTextToolCalls } from './text-tool-calls'

/** The string delimiter a model puts around a value in a text tool call. */
const DELIM = '<|"|>'

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
  const calls = extractTextToolCalls(text)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { name: 'read', args: { file_path: 'index.html' } })
  assert.deepEqual(calls[1], { name: 'write', args: { file_path: 'a.txt', content: 'hi' } })

  // 2. the DELIMITED pseudo-JSON form: no fences, values wrapped in the
  // delimiter. This is one of the forms pi-ai emits when a model answers
  // with its tool call written out instead of calling the tool, and it is
  // what the crew used to emit for every `write`. A form this module cannot
  // read is a turn that succeeds while the workspace stays untouched.
  const source = [
    "export type CredentialState = 'present' | 'missing'",
    '',
    'export function credentialState(): CredentialState {',
    "  return 'missing'",
    '}',
  ].join('\n')
  const delimited = [
    'Sure, writing the file now.',
    `write{file_path:${DELIM}C:/wednesday/factory/mcp/model-catalog.ts${DELIM},content:${DELIM}${source}${DELIM}}`,
  ].join('\n')
  const delimitedCalls = extractTextToolCalls(delimited)
  assert.equal(delimitedCalls.length, 1)
  assert.deepEqual(delimitedCalls[0], {
    name: 'write',
    args: { file_path: 'C:/wednesday/factory/mcp/model-catalog.ts', content: source },
  })

  // 2a. a delimited EDIT carries old_string/new_string, not a content field
  const editCall = extractTextToolCalls(
    `edit{file_path:${DELIM}a.ts${DELIM},old_string:${DELIM}const x = 1${DELIM},new_string:${DELIM}const x = 2${DELIM}}`,
  )
  assert.equal(editCall.length, 1)
  assert.deepEqual(editCall[0], {
    name: 'edit',
    args: { file_path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
  })

  // 2b. prose that merely looks like a call is not a call
  assert.equal(extractTextToolCalls('the type Record{key:string} is a type').length, 0)
  assert.equal(extractTextToolCalls(`read{file_path:${DELIM}a.ts${DELIM}`).length, 0)

  // 2c. one call written twice runs once
  const twice = extractTextToolCalls(
    `write{file_path:${DELIM}a.txt${DELIM},content:${DELIM}hi${DELIM}}\nwrite{file_path:${DELIM}a.txt${DELIM},content:${DELIM}hi${DELIM}}`,
  )
  assert.equal(twice.length, 1)

  // 3. the PARENTHESISED form: a call with quoted arguments and no fences.
  // The model picks a different encoding from run to run, so every encoding
  // it actually uses has to be readable.
  const paren = [
    `write(file_path='C:/wednesday/factory/mcp/model-catalog.ts', content="${source}")`,
  ].join('\n')
  const parenCalls = extractTextToolCalls(paren)
  assert.equal(parenCalls.length, 1)
  assert.deepEqual(parenCalls[0], {
    name: 'write',
    args: { file_path: 'C:/wednesday/factory/mcp/model-catalog.ts', content: source },
  })

  // 3a. a quoted value may contain its own quote character unescaped: the
  // value ends where the call's own syntax continues, not at the first
  // quote.
  const inner = 'const label = "inside"\nconst other = f("a", b)\n'
  const innerCalls = extractTextToolCalls(`write(file_path='a.ts', content="${inner}")`)
  assert.equal(innerCalls.length, 1)
  assert.equal(innerCalls[0]?.args.content, inner)

  // 3b. an unknown tool name in a heuristic form is not a call
  assert.equal(extractTextToolCalls('teleport(file_path=\'a.ts\')').length, 0)

  // 4. execution: write then read then bash, confined to the workspace
  const base = await mkdtemp(join(tmpdir(), 'wednesday-text-tool-'))
  try {
    const transcript = await runTextToolCalls(base, [
      { name: 'write', args: { file_path: 'sub/hello.txt', content: 'hello fenced' } },
      { name: 'read', args: { file_path: 'sub/hello.txt' } },
      { name: 'bash', args: { command: 'node -e "console.log(require(\'fs\').readFileSync(\'sub/hello.txt\',\'utf8\').trim())"' } },
    ])
    assert.equal(readFileSync(join(base, 'sub', 'hello.txt'), 'utf8'), 'hello fenced')
    assert.match(transcript, /bytes written/)
    assert.match(transcript, /hello fenced/)
    assert.match(transcript, /\[bash /)

    // 4a. a DELIMITED write lands on disk, content byte for byte
    const written = extractTextToolCalls(
      `write{file_path:${DELIM}sub/from-delimited.ts${DELIM},content:${DELIM}${source}${DELIM}}`,
    )
    const writeTranscript = await runTextToolCalls(base, written)
    assert.match(writeTranscript, /bytes written/)
    assert.equal(readFileSync(join(base, 'sub', 'from-delimited.ts'), 'utf8'), source)

    // 4b. a PARENTHESISED write lands on disk, content byte for byte
    const parenWritten = extractTextToolCalls(
      `write(file_path='sub/from-paren.ts', content="${source}")`,
    )
    const parenTranscript = await runTextToolCalls(base, parenWritten)
    assert.match(parenTranscript, /bytes written/)
    assert.equal(readFileSync(join(base, 'sub', 'from-paren.ts'), 'utf8'), source)

    // 4c. an EDIT replaces the old text in place — it does not overwrite the
    // whole file with the replacement.
    const editTranscript = await runTextToolCalls(base, [
      { name: 'edit', args: { file_path: 'sub/hello.txt', old_string: 'hello', new_string: 'goodbye' } },
    ])
    assert.match(editTranscript, /chars replaced/)
    assert.equal(readFileSync(join(base, 'sub', 'hello.txt'), 'utf8'), 'goodbye fenced')

    // 4d. `$&` in the replacement is literal text the model wrote, not a
    // substitution pattern.
    await runTextToolCalls(base, [
      { name: 'write', args: { file_path: 'sub/dollar.txt', content: 'before' } },
      { name: 'edit', args: { file_path: 'sub/dollar.txt', old_string: 'before', new_string: 'a $& b $1 c' } },
    ])
    assert.equal(readFileSync(join(base, 'sub', 'dollar.txt'), 'utf8'), 'a $& b $1 c')

    // 4e. an edit whose old_string is absent fails instead of writing
    const missing = await runTextToolCalls(base, [
      { name: 'edit', args: { file_path: 'sub/hello.txt', old_string: 'not in the file', new_string: 'x' } },
    ])
    assert.match(missing, /old_string not found/)

    // 5. path escape is refused, not executed
    const escaped = await runTextToolCalls(base, [
      { name: 'write', args: { file_path: '../escape.txt', content: 'nope' } },
    ])
    assert.match(escaped, /failed/)
    assert.match(escaped, /escapes workspace/)

    // 6. unknown tool reports failure without throwing
    const unknown = await runTextToolCalls(base, [{ name: 'teleport', args: {} }])
    assert.match(unknown, /unsupported tool/)

    // 7. `ls` never goes through a shell. A model-written directory name with
    // shell metacharacters must be listed literally, not executed (the old
    // `node -e "... " + JSON.stringify(dir)` form was a command-injection
    // path on POSIX: `$(...)` inside double quotes runs).
    const weird = process.platform === 'win32' ? 'bad & echo PWNED' : 'bad$(echo PWNED)'
    mkdirSync(join(base, weird))
    const listed = await runTextToolCalls(base, [{ name: 'ls', args: { path: '.' } }])
    assert.match(listed, /bad/, 'the directory name is listed')
    assert.doesNotMatch(listed, /failed|ENOENT/, 'listing must not execute or fail on the name')
    assert.equal(
      listed.split('\n').filter(line => line.includes('PWNED')).length,
      1,
      'a shell would add a second PWNED line from the injected echo',
    )

    console.log('TEXT TOOL CALLS TEST: PASS (fenced + delimited + parenthesised extraction, write/read/bash/edit execution, escape refused, ls shell-free)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

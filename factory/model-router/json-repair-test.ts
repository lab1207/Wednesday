/**
 * Offline test for the JSON salvage helpers: strict JSON, fenced JSON, a
 * trailing comma, single quotes, prose-wrapped JSON, truncated JSON, the
 * no-JSON case, and the failure description. No network.
 */
import assert from 'node:assert/strict'
import { describeJsonFailure, extractJsonObject, parseJsonLoose, repairJsonSlice } from './json-repair'

async function main(): Promise<void> {
  // 1. Strict JSON passes through untouched.
  assert.deepEqual(parseJsonLoose('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] })

  // 2. A fenced block is unwrapped (closed fence and truncated fence).
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}'), { a: 2 })

  // 3. A trailing comma is dropped (value and nested list).
  assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('{"a":[1,2,],}'), { a: [1, 2] })

  // 4. Single-quoted keys and values become double-quoted.
  assert.deepEqual(parseJsonLoose("{'name':'write','arguments':{'path':'a.txt'}}"), {
    name: 'write',
    arguments: { path: 'a.txt' },
  })

  // 5. Prose around the payload is ignored.
  assert.deepEqual(parseJsonLoose('Here is the JSON: {"a":3} -- hope that helps.'), { a: 3 })

  // 6. A truncated payload is closed and retried.
  assert.deepEqual(parseJsonLoose('{"a":4'), { a: 4 })
  assert.deepEqual(parseJsonLoose('{"a":{"b":5'), { a: { b: 5 } })
  assert.deepEqual(parseJsonLoose('[1,2,'), [1, 2])

  // 7. No JSON-ish content -> null (no invented data).
  assert.equal(parseJsonLoose('I cannot answer that.'), null)
  assert.equal(parseJsonLoose(''), null)
  assert.equal(repairJsonSlice('nothing here'), null)
  assert.equal(repairJsonSlice(''), null)

  // 8. The repair yields a string; the extractor yields the raw slice.
  assert.equal(typeof repairJsonSlice('{"a":1,}'), 'string')
  assert.equal(repairJsonSlice('{"a":1,}'), '{"a":1}')
  assert.equal(extractJsonObject('prefix {"a":1} suffix'), '{"a":1}')
  assert.equal(extractJsonObject('no braces here'), null)

  // 9. The failure description is short, non-empty, and actionable.
  const reason = describeJsonFailure('I cannot answer that.')
  assert.ok(reason.length > 0)
  assert.match(reason, /no JSON object found/)
  assert.ok(describeJsonFailure('').length > 0)
  assert.ok(describeJsonFailure('{"a":').length > 0)

  console.log('json-repair: PASS')
}
main().catch((err) => { console.error(err); process.exit(1) })

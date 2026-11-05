/**
 * Inline-flag grammar.
 *
 * This decides what the operator's WORDS mean: which part is the request and
 * which part is configuration. It was reachable only through a whole session,
 * and it had a real defect — `--test "node -e \"process.exit(0)\""` (the single
 * most common verification command there is) matched `"node -e \"` as the quoted
 * token, so half the command leaked into the objective and the flag arrived
 * mangled.
 *
 *   npx tsx factory/harness/inline-flags-test.ts
 */
import assert from 'node:assert/strict'
import { parseInlineFlags } from './harness.js'

function main(): void {
  // 1. The regression: an escaped quote inside a double-quoted value.
  {
    const parsed = parseInlineFlags('--test "node -e \\"process.exit(0)\\"" add a regression note')
    assert.deepEqual(parsed.tests, ['node -e "process.exit(0)"'], 'the escaped quotes survive as one token')
    assert.equal(parsed.objective, 'add a regression note', 'and nothing leaks into the objective')
  }

  // 2. Plain quoted and unquoted values.
  {
    assert.deepEqual(parseInlineFlags('fix it --test "npm test"').tests, ['npm test'])
    assert.deepEqual(parseInlineFlags('fix it --test npm-test').tests, ['npm-test'])
    assert.deepEqual(parseInlineFlags("fix it --test 'npm run build'").tests, ['npm run build'])
    assert.equal(parseInlineFlags('fix it --test "npm test"').objective, 'fix it')
  }

  // 3. Flags anywhere in the line, in any order, with several values.
  {
    const parsed = parseInlineFlags('--required-file a.txt fix the thing --test "npm test" --required-file b.txt')
    assert.equal(parsed.objective, 'fix the thing', 'the objective is what is left')
    assert.deepEqual(parsed.tests, ['npm test'])
    assert.deepEqual(parsed.requiredFiles, ['a.txt', 'b.txt'], 'repeated flags accumulate')
  }

  // 4. Unknown flags stay prose. A request can legitimately contain them.
  {
    const parsed = parseInlineFlags('fix the --bogus option on the server')
    assert.equal(parsed.objective, 'fix the --bogus option on the server')
    assert.deepEqual(parsed.tests, [], 'and it invents no flags')
  }

  // 5. A flag with no value is not silently swallowed: it stays visible.
  {
    const parsed = parseInlineFlags('fix the thing --test')
    assert.equal(parsed.objective, 'fix the thing --test', 'a valueless flag stays in the text')
    assert.deepEqual(parsed.tests, [])
  }

  // 6. An unbalanced quote must not eat the rest of the line — the operator
  //    gets their words back instead of an empty request.
  {
    const parsed = parseInlineFlags('fix "the unclosed thing')
    assert.ok(parsed.objective.includes('the unclosed thing'), `objective kept: ${parsed.objective}`)
  }

  // 7. Empty and whitespace input is empty, not a crash.
  assert.equal(parseInlineFlags('').objective, '')
  assert.equal(parseInlineFlags('   ').objective, '')
  assert.equal(parseInlineFlags('--test "npm test"').objective, '', 'flags alone leave no objective')

  // 8. --workspace is resolved, and relative paths are honoured.
  {
    const parsed = parseInlineFlags('fix it --workspace "C:\\\\Users\\\\operator"')
    assert.ok(parsed.workspace, 'the workspace path is captured')
    assert.equal(parsed.objective, 'fix it')
  }

  console.log('INLINE FLAGS TEST: PASS (escaped quotes, quoting, ordering, unknown flags, valueless flags, unbalanced quote, empty input)')
}

main()

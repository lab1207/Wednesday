/**
 * Offline test for the content-aware token estimator: prose keeps the old
 * 4-chars-per-token number, code and JSON are charged honestly (about 3
 * chars per token), a mixed prompt lands between the two, and the estimator
 * stays deterministic and never returns 0 for non-empty text. No network.
 */
import assert from 'node:assert/strict'
import {
  estimateMessagesTokens,
  estimateTokens,
  estimateTokensForModel,
} from './tokenizer'

async function main(): Promise<void> {
  // 1. The floor rules: empty is 0, non-empty is at least 1.
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('x') >= 1)
  assert.ok(estimateTokens('a') >= 1)

  // 2. A short prompt stays short (the harness must not trim it).
  const short = estimateTokens('short prompt')
  assert.ok(short > 0 && short <= 4, `short prompt stays small (${short})`)

  // 3. Plain prose keeps the old approximation (4 chars per token).
  const prose =
    'The operator asked for a small change in the factory harness. ' +
    'We looked at the report, compared it with the previous run, and found ' +
    'that the model had read the first half of the request only.'
  const proseTokens = estimateTokens(prose)
  assert.equal(proseTokens, Math.ceil(prose.length / 4), 'prose is still chars/4')

  // 4. A long JSON blob of the SAME length costs more tokens than prose.
  const json =
    '{"id":"wednesday","ok":true,"items":[{"name":"alpha","score":7},' +
    '{"name":"beta","score":11},{"name":"gamma","score":3}],"tags":["a","b","c"]}'
  const proseSameLength = 'a'.repeat(json.length)
  const jsonTokens = estimateTokens(json)
  const proseTokensSameLength = estimateTokens(proseSameLength)
  assert.ok(
    jsonTokens > proseTokensSameLength,
    `JSON must cost more than prose of the same length (${jsonTokens} vs ${proseTokensSameLength})`,
  )
  assert.ok(jsonTokens > Math.ceil(json.length / 4), 'JSON is charged above chars/4')

  // 5. Real code is charged above chars/4 too.
  const code =
    'export function loadModel(id: string): Promise<Model> {\n' +
    '  const found = registry.get(id);\n' +
    '  if (!found) throw new Error("unknown model");\n' +
    '  return Promise.resolve(found);\n' +
    '}\n'
  const codeTokens = estimateTokens(code)
  assert.ok(
    codeTokens > Math.ceil(code.length / 4),
    `code is charged above chars/4 (${codeTokens} vs ${Math.ceil(code.length / 4)})`,
  )

  // 6. A mixed prompt lands between the prose rate and the code rate.
  const mixed = `Here is the task:\n${prose}\n\nAnd the failing file:\n${code}`
  const mixedTokens = estimateTokens(mixed)
  assert.ok(mixedTokens > proseTokens, 'a mixed prompt costs more than its prose')
  assert.ok(mixedTokens < codeTokens * 3, 'a mixed prompt does not cost triple the code')
  const mixedRatio = mixed.length / mixedTokens
  assert.ok(mixedRatio > 3.0 && mixedRatio < 4.0, `mixed ratio ${mixedRatio.toFixed(2)} is between`)

  // 7. The model-aware estimate uses that model's tokenizer family.
  const llamaProse = estimateTokensForModel(prose, 'llama-3.2-3b')
  assert.ok(llamaProse >= proseTokens, 'the llama tokenizer is not more generous than generic')
  assert.equal(
    estimateTokensForModel(prose, 'unknown-model-xyz'),
    estimateTokens(prose),
    'an unknown model is charged at the generic rate',
  )
  assert.equal(
    estimateTokensForModel('', 'qwen2.5-coder-3b'),
    0,
    'empty stays empty for a known model too',
  )

  // 8. Messages are the sum of their contents; an empty conversation is 0.
  const messages = [
    { content: 'first message' },
    { content: code },
  ]
  const messageTokens = estimateMessagesTokens(messages)
  assert.equal(
    messageTokens,
    estimateTokens(messages[0]!.content) + estimateTokens(messages[1]!.content),
  )
  assert.equal(estimateMessagesTokens([]), 0)
  assert.equal(estimateMessagesTokens([{ content: '' }]), 0)

  // 9. Deterministic: the same input always gives the same number.
  assert.equal(estimateTokens(code), codeTokens)
  assert.equal(estimateTokensForModel(code, 'qwen3-8b'), estimateTokensForModel(code, 'qwen3-8b'))

  console.log('tokenizer: PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

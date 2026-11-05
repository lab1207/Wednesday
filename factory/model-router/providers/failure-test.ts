/**
 * `describeBody`: what an upstream sent INSTEAD of a completion, as one line.
 *
 * The reported screen: a free model's 502 came back as Cloudflare's HTML
 * document, the error carried the whole body, and the operator's stream filled
 * with markup over the one line that said what failed. The providers now pass
 * every `response.text()` through this helper, so the shapes below are the
 * contract they rely on — no newline, no markup, and the page's title kept.
 *
 *   npx tsx factory/model-router/providers/failure-test.ts
 */
import assert from 'node:assert/strict'

import { describeBody, looksLikeHtml } from './failure.js'

const HTML = [
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head>',
  '<body>',
  '<p class="text-13">Ray ID: 8f2a1c</p>',
  '</body></html>',
].join('\n')

assert.equal(looksLikeHtml(HTML), true, 'a document is recognised')
assert.equal(looksLikeHtml('{"error":{"message":"rate limited"}}'), false, 'a JSON error payload is not a document')
assert.equal(looksLikeHtml('Too many requests'), false, 'a plain-text error is not a document')

const described = describeBody(HTML)
assert.ok(!described.includes('<'), `no markup survives: ${described}`)
assert.ok(!described.includes('\n'), 'and it is ONE line')
assert.match(described, /an HTML page, not a model reply/, 'it says what the thing is')
assert.match(described, /502 Bad Gateway/, 'it keeps the page title, the one useful fact')

// A JSON error payload keeps its message; whitespace is flattened.
assert.equal(describeBody('{"error":{"message":"rate limited"}}'), '{"error":{"message":"rate limited"}}')
assert.equal(describeBody('line one\n   line two'), 'line one line two')

// A title-less document still reads; a wall of text is cut to the budget.
assert.match(describeBody('<html><body>proxy login</body></html>'), /an HTML page/, 'no title, still one line')
const long = describeBody('y'.repeat(1000))
assert.ok(long.length <= 201, `clipped to the budget (got ${long.length})`)
assert.ok(long.endsWith('…'), 'and says it was cut')

assert.equal(describeBody('   '), '(empty body)', 'an empty body is named as such')

console.log('FAILURE TEST: PASS (HTML page collapses to a titled one-liner, JSON and text keep their message, budget enforced)')

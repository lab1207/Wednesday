/**
 * Offline test for the chat content builder. Pure asserts: imageless
 * prompts stay strings (legacy wire shape byte-identical), attachments
 * become text+image_url parts, blanks dropped.
 */
import assert from 'node:assert/strict'

import { userContent } from './chat'

async function main(): Promise<void> {
  // 1. No images: plain string, exactly as before.
  assert.equal(userContent('hello'), 'hello')
  assert.equal(userContent('hello', []), 'hello')
  assert.equal(userContent('hello', ['  ']), 'hello')
  assert.equal(userContent('hello', undefined), 'hello')

  // 2. With images: text part first, then one image_url part each.
  // e2e R-BM-28: image_url wire shape
  assert.deepEqual(userContent('what color?', ['data:image/png;base64,AAA', '  ', 'https://x/y.png']), [
    { type: 'text', text: 'what color?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'image_url', image_url: { url: 'https://x/y.png' } },
  ])

  console.log('CHAT CONTENT TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

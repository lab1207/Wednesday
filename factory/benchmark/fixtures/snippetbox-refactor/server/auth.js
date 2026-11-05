/**
 * SnippetBox authentication helpers — WORKING implementation for the
 * snippetbox-refactor variant (auth is not the task here; shape is).
 *
 * Tokens are `tok_<username>_<random>` strings kept in the store's
 * `tokens` array; lookup parses the prefix and verifies membership.
 */

/** Deterministic, non-cryptographic hash — benchmark fixture only, NOT safe for real credentials. */
export function hashPassword(password) {
  let hash = 0
  for (const char of password) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return `h${hash.toString(16)}`
}

export function issueToken(username) {
  const random = Math.floor(Math.random() * 0xffffffff).toString(16)
  return `tok_${username}_${random}`
}

export function lookupToken(store, token) {
  if (!token || typeof token !== 'string') return null
  if (!store.tokens.includes(token)) return null
  const match = /^tok_(.+)_[0-9a-f]+$/.exec(token)
  return match ? match[1] : null
}

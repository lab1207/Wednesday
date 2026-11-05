/**
 * SnippetBox authentication helpers.
 *
 * Task: implement `issueToken` and `lookupToken` so register/login and the
 * note routes can authenticate users. Tokens should be bound to a username,
 * and `lookupToken` must verify against the store's `tokens` array.
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
  return `t-${username}-${Math.random().toString(36).slice(2, 10)}`
}

export function lookupToken(store, token) {
  if (!token || !token.startsWith('t-')) return null
  const parts = token.split('-')
  if (parts.length < 3) return null
  const username = parts[1]
  return store.tokens.includes(token) ? username : null
}

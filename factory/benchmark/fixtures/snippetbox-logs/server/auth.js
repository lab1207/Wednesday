/**
 * SnippetBox authentication helpers — STUBBED for the benchmark.
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
  // TODO(benchmark): issue a token bound to the given username.
  return null
}

export function lookupToken(store, token) {
  // TODO(benchmark): return the username the token belongs to, or null.
  return null
}
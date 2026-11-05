import assert from 'node:assert/strict'

import { redactSensitiveText, secretValues } from './redaction.js'
import { redactSecrets } from '../dsh-worker/secret-redaction.js'
import { safeError } from '../harness/config.js'

const env = {
  ACME_API_KEY: 'acme-secret-value-xyz-789',
  LOCAL_TOOL_PROXY_UPSTREAM: 'https://tunnel-abc123.invalid/v1',
  WEDNESDAY_NO_UPDATE_CHECK: '1',
}

// 1. env values are scrubbed by value, short flags are not mangled
assert.equal(redactSensitiveText('failure acme-secret-value-xyz-789', env), 'failure [REDACTED]')
assert.equal(redactSensitiveText('flag=1 stays', env), 'flag=1 stays')

// 2. the tunnel URL's HOST is scrubbed even when only the host appears
assert.equal(
  redactSensitiveText('GET https://tunnel-abc123.invalid/v1/models -> 530', env),
  'GET [REDACTED]/models -> 530',
)
assert.equal(
  redactSensitiveText('connect ECONNREFUSED tunnel-abc123.invalid:443', env),
  'connect ECONNREFUSED [redacted-host]:443',
)
// ...and the full URL is scrubbed when it is printed whole
assert.equal(
  redactSensitiveText('upstream https://tunnel-abc123.invalid/v1 is dead', env),
  'upstream [REDACTED] is dead',
)

// 3. credential shapes are caught even when they are not in our env
assert.equal(redactSensitiveText('Authorization: Bearer abcdefghijklmnop', env), 'Authorization: Bearer [REDACTED]')
assert.equal(redactSensitiveText('key sk-proj-abcdefgh12345 leaked', env), 'key [REDACTED] leaked')
assert.equal(redactSensitiveText('token ghp_abcdefgh12345 leaked', env), 'token [REDACTED] leaked')
assert.equal(redactSensitiveText('aws AKIAABCDEFGHIJKLMNOP leaked', env), 'aws [REDACTED] leaked')
assert.equal(redactSensitiveText('google AIzaSyA1234567890abcdefghij leaked', env), 'google [REDACTED] leaked')
assert.equal(redactSensitiveText('nvidia nvapi-abcdefgh12345 leaked', env), 'nvidia [REDACTED] leaked')
// identifiers that merely contain the letters are untouched
assert.equal(redactSensitiveText('task-abcdefghij done', env), 'task-abcdefghij done')

// 4. secret-named query parameters keep the name and lose the value
assert.equal(
  redactSensitiveText('POST /v1?api_key=super-secret-value&stream=1', env),
  'POST /v1?api_key=[REDACTED]&stream=1',
)

// 5. safeError uses the same rule (the harness/CLI exit)
process.env.ACME_API_KEY = 'acme-secret-value-xyz-789'
try {
  assert.equal(safeError(new Error('boom acme-secret-value-xyz-789')), 'boom [REDACTED]')
} finally {
  delete process.env.ACME_API_KEY
}

// 6. the dsh-worker copy must not drift from the shared rule
for (const text of [
  'failure acme-secret-value-xyz-789',
  'GET https://tunnel-abc123.invalid/v1/models',
  'Authorization: Bearer abcdefghijklmnop',
  'key sk-proj-abcdefgh12345 leaked',
  'POST /v1?api_key=super-secret-value&stream=1',
]) {
  assert.equal(redactSecrets(text, env), redactSensitiveText(text, env), `redactors disagree on: ${text}`)
}

// 7. only secret-shaped names are collected
assert.deepEqual(secretValues({ ACME_API_KEY: '12345678', NORMAL_VALUE: '12345678' }), ['12345678'])

console.log('REDACTION TEST: PASS (env values, tunnel host, bearer/key shapes, query params, dsh parity)')

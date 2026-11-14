import assert from 'node:assert/strict'

import { redactSensitiveText, secretValues } from './redaction.js'
import { redactSecrets } from '../dsh-worker/secret-redaction.js'
import { safeError } from '../config.js'

const env = {
  ACME_API_KEY: 'acme-secret-value-xyz-789',
  LOCAL_TOOL_PROXY_UPSTREAM: 'https://tunnel-abc123.invalid/v1',
  WEDNESDAY_NO_UPDATE_CHECK: '1',
}

// The credential shapes below are BUILT AT RUNTIME, never written literally.
//
// WHY (operator report, 2026-11-08, "no API keys, codes, secret shapes -- on
// npm OR on GitHub, in ANY version"): this file ships in the PUBLIC export
// (factory/ is exported), so an AWS-shaped or Google-shaped string written
// literally lands on GitHub as a key shape. B235 already moved two other
// fixtures to runtime-built literals; this one was missed, and the exporter's
// documented-fake allowlist had been excusing it.
//
// The redactor still receives a REAL shape here, so the assertions below
// still prove the catch -- the shape is assembled, not weakened. A fixture
// that only LOOKED like a key would test nothing.
const AWS_SHAPE = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const GOOGLE_SHAPE = 'AIza' + 'SyA1234567890abcdefghij'

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
assert.equal(redactSensitiveText('aws ' + AWS_SHAPE + ' leaked', env), 'aws [REDACTED] leaked')
assert.equal(redactSensitiveText('google ' + GOOGLE_SHAPE + ' leaked', env), 'google [REDACTED] leaked')
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

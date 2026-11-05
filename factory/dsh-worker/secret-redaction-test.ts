import assert from 'node:assert/strict'
import { redactSecrets, secretValues } from './secret-redaction.js'

const env: NodeJS.ProcessEnv = {
  OPENROUTER_API_KEY: 'test-secret-value-123456',
  NVIDIA_API_KEY: 'test-secret-nv-abcdef',
  LOCAL_TOOL_PROXY_UPSTREAM: 'https://tunnel-abc123.invalid/v1',
  SOME_TOKEN: 'tok_super_secret_999',
  PATH: 'C:\\bin', // short-ish but name does not match — must survive
  WEDNESDAY_NO_UPDATE_CHECK: '1', // short value, secret-shaped name — must survive (len < 8)
}

// values collected by name shape + length
assert.deepEqual(
  secretValues(env).sort(),
  ['test-secret-nv-abcdef', 'test-secret-value-123456', 'https://tunnel-abc123.invalid/v1', 'tok_super_secret_999'].sort(),
)

// full values scrubbed
assert.equal(
  redactSecrets('auth failed for test-secret-value-123456 on request', env),
  'auth failed for [REDACTED] on request',
)
// upstream URL value scrubbed AND its bare host (ECONNREFUSED-style errors)
assert.equal(
  redactSecrets('connect ECONNREFUSED tunnel-abc123.invalid:443', env),
  'connect ECONNREFUSED [redacted-host]:443',
)
assert.equal(
  redactSecrets('POST https://tunnel-abc123.invalid/v1/chat/completions -> 530', env),
  'POST [REDACTED]/chat/completions -> 530',
)
// non-secrets untouched
assert.equal(redactSecrets('listening on 127.0.0.1:18090', env), 'listening on 127.0.0.1:18090')
assert.equal(redactSecrets('value is 1', env), 'value is 1')
// malformed upstream does not throw
assert.equal(redactSecrets('x not-a-url y', { LOCAL_TOOL_PROXY_UPSTREAM: 'not-a-url' }), 'x [REDACTED] y')
// real process env in this test run must not leak either
for (const name of ['OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'LOCAL_TOOL_PROXY_UPSTREAM']) {
  const value = process.env[name]
  if (value && value.length >= 8) {
    assert.equal(redactSecrets(`leak ${value}`), 'leak [REDACTED]', `${name} must be redacted`)
  }
}

console.log('SECRET REDACTION TEST: PASS (name-shape scan, value+host scrub, short values kept, malformed URL safe)')

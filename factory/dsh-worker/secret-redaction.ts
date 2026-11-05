// Secret redaction for logs, stderr receipts and debug output.
// Rule: any env var whose NAME looks secret-bearing (key/token/password/
// upstream/credential) is scrubbed by VALUE from anything we print, plus the
// host of the tunnel upstream. Lives in dsh-worker because host.ts and
// local-tool-proxy.ts are deployed as their own unit and must not import from
// factory/harness (layer rule). Keep the credential shapes in sync with
// factory/security/redaction.ts (the harness/CLI side); both are covered by
// tests so they cannot drift silently.

const SECRET_NAME = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|UPSTREAM|CREDENTIAL|PRIVATE_KEY)/i
// Short values are almost certainly not secrets ("1", "true") — scrubbing
// them would mangle normal log lines.
const MIN_SECRET_LEN = 8

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LEN && SECRET_NAME.test(name)) {
      values.push(value)
    }
  }
  return values
}

// Well-known credential shapes, for keys that are not in our env (pasted into
// a prompt, echoed by a provider, or printed by a proxy).
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]'],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
]

const SECRET_QUERY =
  /([?&](?:api[_-]?key|key|token|access_token|refresh_token|auth|secret|password)=)[^&\s"']+/gi

/** Replace every secret-shaped env value (and the upstream host) in text. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const value of secretValues(env)) {
    out = out.split(value).join('[REDACTED]')
    const encoded = encodeURIComponent(value)
    if (encoded !== value) out = out.split(encoded).join('[REDACTED]')
  }
  const upstream = env.LOCAL_TOOL_PROXY_UPSTREAM
  if (typeof upstream === 'string' && upstream.length > 0) {
    try {
      out = out.split(new URL(upstream).host).join('[redacted-host]')
    } catch {
      // not a parseable URL — the raw value is already scrubbed above
    }
  }
  for (const [pattern, replacement] of TOKEN_SHAPES) {
    out = out.replace(pattern, replacement)
  }
  return out.replace(SECRET_QUERY, '$1[REDACTED]')
}

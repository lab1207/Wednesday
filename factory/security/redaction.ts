/**
 * One redaction rule for every operator-visible error line.
 *
 * Why a module instead of a helper in one layer: errors travel through the
 * CLI, Hermes, the orchestrator, the harness and the dsh host. A secret that
 * appears in a thrown message (a tunnel URL, an API key echoed by a provider,
 * a token in a proxy error) must be scrubbed at every one of those exits, not
 * only in the interactive REPL.
 *
 * Two passes:
 *  1. env values whose NAME looks secret-bearing (key/token/password/upstream/
 *     credential/private key), in raw and URL-encoded form, plus the HOST of a
 *     URL-shaped secret (an error that prints only the hostname must not leak
 *     the tunnel);
 *  2. well-known credential shapes and secret-named query parameters, so a key
 *     pasted into a prompt or returned by a provider is caught even when it is
 *     not in our environment.
 *
 * This is deliberately conservative: false positives only hide text in an
 * error line, while a false negative prints a live credential.
 */

const SECRET_NAME = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|UPSTREAM|CREDENTIAL|PRIVATE_KEY)/i

// Short values are almost certainly flags ("1", "true", "local"); scrubbing
// them would mangle normal log lines without protecting a real secret.
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

const TOKEN_SHAPES: Array<[RegExp, string]> = [
  // Authorization headers, even when the token is not in our env.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]'],
  // OpenAI / Anthropic / OpenRouter style keys. The lookbehind keeps
  // identifiers such as `task-abcdefgh` from being treated as `sk-` keys.
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
]

// `?api_key=...`, `&token=...`, etc. Keep the parameter name (useful in an
// error) and drop the value.
const SECRET_QUERY =
  /([?&](?:api[_-]?key|key|token|access_token|refresh_token|auth|secret|password)=)[^&\s"']+/gi

function scrubValue(out: string, value: string): string {
  let text = out.split(value).join('[REDACTED]')
  const encoded = encodeURIComponent(value)
  if (encoded !== value) text = text.split(encoded).join('[REDACTED]')
  return text
}

/** Redact secrets from any text that is about to reach stdout/stderr/a log. */
export function redactSensitiveText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const value of secretValues(env)) {
    out = scrubValue(out, value)
    try {
      const host = new URL(value).host
      if (host.length > 0) out = out.split(host).join('[redacted-host]')
    } catch {
      // Not a URL: the value itself was already scrubbed.
    }
  }
  for (const [pattern, replacement] of TOKEN_SHAPES) {
    out = out.replace(pattern, replacement)
  }
  out = out.replace(SECRET_QUERY, '$1[REDACTED]')
  return out
}

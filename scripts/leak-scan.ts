/**
 * The ONE rule set for "nothing private ships, and nothing phones home".
 *
 * WHY ONE FILE (2026-11-08, the operator's hard rule: no API keys, codes or
 * secret shapes -- and no Google-analytics-style tracking code -- in the npm
 * release OR on GitHub, in ANY version): the public exporter and the release
 * regression each carried their own pattern list, so the two could drift,
 * and so a "known fake" allowlist could sit between the scan and the
 * answer. One table, no exemptions, and the same table is what the
 * regression uses to re-check the tree after the export.
 *
 * WHY THE PATTERNS ARE WRITTEN ESCAPED: a rule that names a tracker must
 * not NAME that tracker in this file, or the file flags itself and the
 * export aborts on its own detector. Writing "google-analytics\.com" keeps
 * the literal host out of the tree while the regex still matches the real
 * thing at scan time. This is the same discipline as the runtime-built
 * credential fixtures (see factory/security/redaction-test.ts).
 *
 * WHAT IS AND IS NOT A HIT: the scan is about things that could leak a
 * secret or phone home -- a tracker HOST, a tracker CALL, a tracker IMPORT,
 * a credential SHAPE. It is deliberately NOT about a vendor name in prose
 * or in somebody else's dependency resolution record: a name in a lockfile
 * is a record of a graph, not code that sends anything. The crewai layer
 * ships the opt-out that turns that upstream telemetry off before crewai is
 * imported (crewai/src/crew/telemetry.py).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Credential shapes. A match here is a leak, wherever it is found. */
export const KEY_SHAPES: Array<[string, RegExp]> = [
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['xAI key', /\bxai-[A-Za-z0-9_-]{16,}/],
  ['NVIDIA key', /\bnvapi-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['private key block', /BEGIN [A-Z ]*PRIVATE KEY/],
]

/** Tracker hosts, tracker calls and tracker imports. */
export const TRACKERS: Array<[string, RegExp]> = [
  ['a GA-style host', /\bgoogle-analytics\.com\b/i],
  ['a tag-manager host', /\bgoogletagmanager\.com\b/i],
  ['a tag call', /\bgtag\s*\(/i],
  ['the legacy analytics loader', /\banalytics\.js\b/i],
  ['a Mixpanel host', /\bapi\.mixpanel\.com\b/i],
  ['a Mixpanel call', /\bmixpanel\.init\s*\(/i],
  ['a Segment host', /\bapi\.segment\.io\b/i],
  ['an Amplitude host', /\bapi\.amplitude\.com\b/i],
  ['an Amplitude call', /\bamplitude\.init\s*\(/i],
  ['a Plausible host', /\bplausible\.io\b/i],
  ['a Clarity host', /\bclarity\.ms\b/i],
  ['a PostHog host', /\bapp\.posthog\.com\b/i],
  ['a PostHog call', /\bposthog\.capture\s*\(/i],
  ['a PostHog import', /\bimport\s+posthog\b/i],
  ['a PostHog require', /\brequire\(\s*['"]posthog\b/i],
  ['a Cloudflare Insights host', /\bcloudflareinsights\.com\b/i],
  ['a Fathom host', /\busefathom\.com\b/i],
  ['a Heap host', /\bheapanalytics\.com\b/i],
  ['a Hotjar host', /\bhotjar\.com\b/i],
  ['the upstream crewai telemetry host', /\btelemetry\.crewai\.com\b/i],
]

/** Private paths and internal references -- personal, not publishable. */
export const PRIVACY: Array<[string, RegExp]> = [
  ['a real tunnel host', /\b[a-z0-9][a-z0-9-]{4,}\.ngrok(-free)?\.(dev|app|io)\b/],
  ['a personal Windows profile', /C:\\Users\\(?!operator\b|you\b|me\b|example\b|Public\b|<)/i],
  ['a personal POSIX home', /\/home\/(?!you\b|user\b|runner\b)[a-z][a-z0-9_-]{2,}\//i],
  ['an internal doc reference', /\bWEDNESDAY_(BUSINESS|MONEY|SECURITY_AUDIT|SNAPSHOT|BUILD_HISTORY)/],
]

/** Everything, in one list, so a caller cannot pick a favourite subset. */
export const ALL_RULES: Array<[string, RegExp]> = [...KEY_SHAPES, ...TRACKERS, ...PRIVACY]

/** Files that are binary or near-binary: a regex over them is noise. */
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|so|dll|exe|pyc|zip|gz|tgz|whl)$/i

/**
 * Scan one piece of text. Returns one human-readable line per hit.
 *
 * WHY A PURE FUNCTION: the regression needs to prove the net still CATCHES
 * a real shape, not just that the tree is quiet. A pure scanner can be
 * handed a synthetic secret and must report it.
 */
export function scanText(text: string): string[] {
  const hits: string[] = []
  for (const [name, rx] of ALL_RULES) {
    const match = text.match(rx)
    if (match) hits.push(`${name} -> ${match[0].slice(0, 60)}`)
  }
  return hits
}

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

/**
 * Scan a directory tree, the way the exporter scans its staging tree.
 *
 * WHY THIS IS SHARED: the exporter scans what it is about to publish, and
 * the regression scans what WAS published. If they used different rules,
 * one of the two answers would be about a different question.
 */
export function scanTree(root: string): string[] {
  const hits: string[] = []
  for (const full of walk(root)) {
    const rel = full.slice(root.length + 1).replace(/\\/g, '/')
    if (rel === '.gitignore') continue
    if (BINARY.test(rel)) continue
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const hit of scanText(text)) hits.push(`${rel}: ${hit}`)
  }
  return hits
}

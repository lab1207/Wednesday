import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Auto-update (B7): stale installs detect a newer release.
// Startup = notify-only, TTY-only, cached daily, silent on any failure. Never
// blocks: every error path resolves to null. No auth, no telemetry — one
// public registry metadata GET, the same thing `npm view` does.
// `/update` goes further: with the operator's explicit yes it runs
// `npm install -g @lab1207/wednesday@<exact-version>` (see updater.ts) —
// pinned to the version the registry just reported, over HTTPS, via npm's
// own checksum verification. No silent auto-install of a tool that runs code.

export const REGISTRY_URL = 'https://registry.npmjs.org/@lab1207%2fwednesday'
const CACHE_FILE = 'update-check.json'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2500

export function channelOf(version: string): string {
  const dash = version.indexOf('-')
  if (dash < 0) return 'latest'
  const tag = version.slice(dash + 1).split('.')[0] ?? ''
  return tag || 'latest'
}

function splitIdent(value: string): Array<number | string> {
  return value.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
}

/** Minimal semver compare: -1 | 0 | 1. Unknown shapes compare as equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: Array<number | string> | null } => {
    const [core = '', ...preParts] = v.split('-')
    const nums = core.split('.').map(n => Number(n))
    if (nums.some(n => !Number.isInteger(n) || n < 0)) return { nums: [], pre: null }
    return { nums, pre: preParts.length ? splitIdent(preParts.join('-')) : null }
  }
  const x = parse(a)
  const y = parse(b)
  if (x.nums.length === 0 || y.nums.length === 0) return 0
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (x.pre === null && y.pre === null) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1
    if (typeof p === 'number') return -1
    if (typeof q === 'number') return 1
    return p < q ? -1 : 1
  }
  return 0
}

export interface UpdateCheckDeps {
  version: string
  registryUrl?: string
  stateDir?: string
  now?: number
  /** Bypass the daily cache read (used by `/update`). The cache is still written. */
  force?: boolean
}

export interface UpdateAvailable {
  current: string
  remote: string
  channel: string
}

/**
 * Fetch the registry and return the newer release for this install's channel,
 * or null. Shared by the startup notice and `/update`. The remote version is
 * returned EXACTLY as the registry states it — the installer pins it, so the
 * tag cannot move between check and install (TOCTOU).
 */
export async function resolveUpdate(deps: UpdateCheckDeps): Promise<UpdateAvailable | null> {
  const { version, registryUrl = REGISTRY_URL, stateDir, now = Date.now(), force = false } = deps
  // Cache: at most one registry hit per day per profile. The cache also stores
  // the last seen remote version, so a cache-hit day still reports the update
  // (the home-screen banner) without another fetch.
  if (stateDir && !force) {
    try {
      const cached = JSON.parse(await readFile(join(stateDir, CACHE_FILE), 'utf8')) as { at?: number; remote?: string | null }
      if (typeof cached.at === 'number' && now - cached.at < CHECK_INTERVAL_MS) {
        if (typeof cached.remote === 'string' && compareVersions(version, cached.remote) < 0) {
          return { current: version, remote: cached.remote, channel: channelOf(version) }
        }
        return null
      }
    } catch { /* missing/corrupt cache = check now */ }
  }
  let remote: string | null = null
  try {
    const response = await fetch(registryUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    const meta = (await response.json()) as { 'dist-tags'?: Record<string, string> }
    const tags = meta['dist-tags'] ?? {}
    const channel = channelOf(version)
    // Follow this install's channel, but never miss a stable release because a
    // dev build only watches the `dev` tag: for a prerelease, consider `latest`
    // too and take the highest newer version (a prerelease compares BELOW its
    // release, so a dev user is correctly offered 0.2.0 when it ships). A
    // stable install never opts into a newer prerelease by accident.
    const wanted = channel === 'latest' ? [tags.latest] : [tags[channel], tags.latest]
    const candidates = wanted.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    remote = candidates.sort(compareVersions).at(-1) ?? null
  } catch {
    return null
  } finally {
    // Cache every attempt (even failures): worst case is one slow start
    // per day on a machine with no network; a transient failure just
    // delays the notice until the next check.
    if (stateDir) {
      try {
        await mkdir(stateDir, { recursive: true })
        await writeFile(join(stateDir, CACHE_FILE), JSON.stringify({ at: now, remote }), 'utf8')
      } catch { /* cache is best-effort */ }
    }
  }
  if (!remote || compareVersions(version, remote) >= 0) return null
  return { current: version, remote, channel: channelOf(version) }
}

export async function checkForUpdates(deps: UpdateCheckDeps): Promise<string | null> {
  const found = await resolveUpdate(deps)
  if (!found) return null
  // One good message, used by the stream line AND the home-screen banner:
  // both version names plus the verb to run. The install command pins the
  // EXACT remote version, not the moving tag.
  return `Update available: ${found.current} → ${found.remote} — type /update to install it (or: npm i -g @lab1207/wednesday@${found.remote})`
}

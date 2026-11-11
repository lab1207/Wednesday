import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Update checks that tell the operator the TRUTH (2026-11-07).
 *
 * WHY THIS WAS REWRITTEN (operator report: "the /update command does not
 * work"). The old check answered with ONE bit — "is there a newer release?" —
 * and the command turned every other outcome into the same sentence:
 * "up to date". That sentence was a lie in three distinct situations:
 *
 *   1. the registry check FAILED (dead network, 2.5 s cap, a 500) — the
 *      operator was told the install was current when nothing was checked;
 *   2. the local build is AHEAD of the published release — the developer
 *      link says "0.2.0-beta.4" while npm still serves "0.2.0-beta.3", so
 *      "up to date" hid the fact that the two are different things;
 *   3. the global install is a LINK to a working tree — the version the
 *      operator sees is their own source tree, not a published release.
 *
 * So the check now returns a DISCRIMINATED result and the command says
 * which one it is. A failed check NEVER reports "up to date".
 *
 * The registry fetch also got cheaper and more patient:
 *   - the ABBREVIATED packument (`application/vnd.npm.install-v1+json`) is
 *     ~6 KB instead of ~30 KB and still carries `dist-tags`; it is a third
 *     of the time on a cold connection;
 *   - a startup notice still uses the short 2.5 s cap (it is silent and
 *     cached daily), but an EXPLICIT `/update` gets 12 s, because there the
 *     operator is watching and a slow network is not a failure.
 *
 * Nothing here installs anything: the consent-gated, pinned installer lives
 * in updater.ts and is only reached from the "available" branch.
 */

export const REGISTRY_URL = 'https://registry.npmjs.org/@lab1207%2fwednesday'
const CACHE_FILE = 'update-check.json'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Startup notice: short, silent, cached daily. */
const FETCH_TIMEOUT_MS = 2500
/** `/update`: the operator is watching the screen, so the check may wait. */
export const EXPLICIT_CHECK_TIMEOUT_MS = 12_000
/** The abbreviated packument: same `dist-tags`, a third of the bytes. */
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json'

/**
 * A registry version must LOOK like a version.
 *
 * The remote version is printed on the operator's screen and embedded in the
 * install command, so a registry answer carrying control characters (or a
 * quote) would be both a terminal-injection and a command-display problem.
 * Anything that is not version-shaped is not trusted: the check fails and
 * says so.
 */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

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
  /** Override the fetch cap. `/update` passes a longer one. */
  timeoutMs?: number
}

export interface UpdateAvailable {
  current: string
  remote: string
  channel: string
}

/**
 * The four outcomes a registry check can actually have.
 *
 * `available` is the only one that may lead to an install. `current` means
 * the published release IS this version. `ahead` means the local build is
 * NEWER than anything published (a developer link, or an unpublished
 * build) — there is nothing to install and saying "up to date" would hide
 * the difference. `failed` means nothing was learned; the command must say
 * so instead of guessing.
 */
export type UpdateStatus =
  | { kind: 'available'; current: string; remote: string; channel: string }
  | { kind: 'current'; current: string; remote: string; channel: string }
  | { kind: 'ahead'; current: string; remote: string; channel: string }
  | { kind: 'failed'; current: string; channel: string; reason: string }

/** How this install got onto the machine. */
export interface LocalInstall {
  kind: 'published' | 'linked'
  /** The working tree a linked install points at (absolute path). */
  target?: string
}

/**
 * Is the running install a published package or a LINK to a working tree?
 *
 * WHY (operator report: "/update does not work"). The operator's global
 * install is `npm i -g` from a local folder, so npm put a JUNCTION at
 * `.../npm/node_modules/@lab1207/wednesday` pointing at the working tree.
 * The launcher resolves that junction, so the harness reports the source
 * tree's version — which is normally NEWER than the published one. Without
 * this check the command cannot explain why it refuses to "update".
 *
 * The launcher path is the evidence: npm's shim runs
 * `<npm-root>/node_modules/@lab1207/wednesday/bin/wednesday.js`, so the
 * nearest ancestor with a package.json is the install directory, and a
 * junction there is a link.
 */
export function detectLocalInstall(argv1: string | undefined = process.argv[1]): LocalInstall {
  try {
    if (!argv1) return { kind: 'published' }
    let dir = resolve(argv1)
    for (let depth = 0; depth < 5; depth++) {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
      try {
        lstatSync(join(dir, 'package.json'))
      } catch {
        continue
      }
      const stat = lstatSync(dir)
      if (stat.isSymbolicLink()) {
        return { kind: 'linked', target: realpathSync(dir) }
      }
      return { kind: 'published' }
    }
  } catch {
    // An unreadable path is not evidence of a link.
  }
  return { kind: 'published' }
}

function statusFromVersions(version: string, remote: string, channel: string): UpdateStatus {
  const cmp = compareVersions(version, remote)
  if (cmp < 0) return { kind: 'available', current: version, remote, channel }
  if (cmp > 0) return { kind: 'ahead', current: version, remote, channel }
  return { kind: 'current', current: version, remote, channel }
}

/**
 * Fetch the registry and say exactly what was learned.
 *
 * The remote version is returned EXACTLY as the registry states it — the
 * installer pins it, so the tag cannot move between check and install
 * (TOCTOU).
 */
export async function checkUpdate(deps: UpdateCheckDeps): Promise<UpdateStatus> {
  const {
    version,
    registryUrl = REGISTRY_URL,
    stateDir,
    now = Date.now(),
    force = false,
    timeoutMs,
  } = deps
  const channel = channelOf(version)
  const budget = timeoutMs ?? (force ? EXPLICIT_CHECK_TIMEOUT_MS : FETCH_TIMEOUT_MS)

  // Cache: at most one registry hit per day per profile. The cache also
  // stores the last seen remote version, so a cache-hit day still reports
  // the update (the home-screen banner) without another fetch.
  if (stateDir && !force) {
    try {
      const cached = JSON.parse(await readFile(join(stateDir, CACHE_FILE), 'utf8')) as {
        at?: number
        remote?: string | null
        failed?: string
      }
      if (typeof cached.at === 'number' && now - cached.at < CHECK_INTERVAL_MS) {
        if (typeof cached.remote === 'string') return statusFromVersions(version, cached.remote, channel)
        return {
          kind: 'failed',
          current: version,
          channel,
          reason: cached.failed ?? 'the last registry check failed',
        }
      }
    } catch { /* missing/corrupt cache = check now */ }
  }

  let remote: string | null = null
  let failure: string | null = null
  try {
    const response = await fetch(registryUrl, {
      headers: { accept: REGISTRY_ACCEPT },
      signal: AbortSignal.timeout(budget),
    })
    if (!response.ok) {
      failure = `the registry answered HTTP ${response.status}`
    } else {
      const meta = (await response.json()) as { 'dist-tags'?: Record<string, string> }
      const tags = meta['dist-tags'] ?? {}
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
      if (!remote) failure = `npm has no release for channel "${channel}"`
      else if (!VERSION_SHAPE.test(remote)) {
        failure = 'the registry returned a version string that is not a version'
        remote = null
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  // Cache every attempt (even failures): worst case is one slow start
  // per day on a machine with no network; a transient failure just
  // delays the notice until the next check.
  if (stateDir) {
    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(
        join(stateDir, CACHE_FILE),
        JSON.stringify({ at: now, remote, failed: failure ?? undefined }),
        'utf8',
      )
    } catch { /* cache is best-effort */ }
  }

  if (!remote) {
    return {
      kind: 'failed',
      current: version,
      channel,
      reason: failure ?? 'the registry check failed',
    }
  }
  return statusFromVersions(version, remote, channel)
}

/**
 * The older, quieter API: the newer release for this install's channel, or
 * null. Kept for the startup notice, which stays silent when there is
 * nothing to say.
 */
export async function resolveUpdate(deps: UpdateCheckDeps): Promise<UpdateAvailable | null> {
  const status = await checkUpdate(deps)
  if (status.kind !== 'available') return null
  return { current: status.current, remote: status.remote, channel: status.channel }
}

export async function checkForUpdates(deps: UpdateCheckDeps): Promise<string | null> {
  const found = await resolveUpdate(deps)
  if (!found) return null
  // One good message, used by the stream line AND the home-screen banner:
  // both version names plus the verb to run. The install command pins the
  // EXACT remote version, not the moving tag.
  return `Update available: ${found.current} → ${found.remote} — type /update to install it (or: npm i -g @lab1207/wednesday@${found.remote} --foreground-scripts)`
}

/**
 * The words the `/update` command shows, for each outcome.
 *
 * Every branch names what was actually learned. The failure branch never
 * contains "up to date" — that sentence was the original bug.
 */
export function updateStatusLines(status: UpdateStatus, install: LocalInstall = { kind: 'published' }): string[] {
  const linkNote = install.kind === 'linked'
    ? `your global install is a LINK to ${install.target ?? 'a local working tree'} — it runs that source tree, not a published release.`
    : ''
  switch (status.kind) {
    case 'available':
      return [
        `wednesday ${status.current} → ${status.remote} is available (npm channel "${status.channel}")`,
        `install: npm i -g @lab1207/wednesday@${status.remote} --foreground-scripts   (exact pinned version, registry.npmjs.org over HTTPS)`,
        ...(linkNote ? [`note: ${linkNote} installing replaces the link with a published copy.`] : []),
      ]
    case 'current':
      return [
        `wednesday ${status.current} is the newest release on npm (channel "${status.channel}").`,
        ...(linkNote ? [`note: ${linkNote}`] : []),
      ]
    case 'ahead':
      return [
        `your build ${status.current} is AHEAD of npm's ${status.remote} (channel "${status.channel}").`,
        'npm has nothing newer to install — this build is newer than the published release.',
        ...(linkNote ? [`note: ${linkNote}`] : []),
      ]
    case 'failed':
      return [
        `the npm check FAILED: ${status.reason}`,
        `wednesday ${status.current} — the published version is UNKNOWN; nothing was checked, so this is NOT a statement that you are current.`,
        'retry with: /update   ·   or check by hand: npm view @lab1207/wednesday dist-tags',
      ]
  }
}

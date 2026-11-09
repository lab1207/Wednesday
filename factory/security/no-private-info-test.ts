/**
 * The operator's hard rule, pinned (2026-11-08).
 *
 * The rule, verbatim from the operator: "no private info -- API keys, codes,
 * secret shapes -- in the npm release or on GitHub, in ANY version; and no
 * Google-analytics-style tracking code. make sure dot do this."
 *
 * Two defects were found while verifying beta.5, and this file exists so
 * neither can come back:
 *
 *   1. factory/security/redaction-test.ts carried TWO literal key shapes (an
 *      AWS shape and a Google shape). The npm tarball excludes test files,
 *      so npm was clean -- but the PUBLIC EXPORT ships factory/ whole, so
 *      GitHub carried them. The exporter's own leak scan had a "known fake"
 *      allowlist that excused exactly those strings, so the scan said PASS
 *      while the tree was not clean. A scan with an allowlist is a correct
 *      scan and an incomplete answer: a stranger reading the repo cannot see
 *      that a string was excused.
 *
 *   2. crewai/src/crew/ imported upstream crewai, whose telemetry client
 *      posts spans to a first-party collector and is ON by default; and
 *      chromadb (a REQUIRED dependency of upstream crewai, proven by
 *      crewai/uv.lock) ships a product-analytics client that is also ON by
 *      default. The shipped layer really would phone home unless something
 *      turned it off first.
 *
 * WHY THIS FILE IMPORTS THE RULES INSTEAD OF WRITING THEM: it used to carry
 * its own pattern list, which is how a detector ended up flagging itself --
 * the detector named the very hosts it hunted. Now there is ONE rule table
 * (scripts/leak-scan.ts) and ONE surface definition (scripts/export-surface.ts),
 * and both the exporter and this regression use them. A second copy of the
 * rules is a second answer to the operator's question.
 *
 * WHY THE SURFACES ARE COMPUTED, NOT ASSUMED: this test scans what npm
 * actually packs (`npm pack --dry-run --json`) and what the public export
 * actually carries (the shared surface module), rather than a hand-written
 * list of directories. A hand-written list drifts from the real package --
 * that drift is exactly how the two key shapes reached GitHub.
 *
 * WHAT IS ASSERTED HERE:
 *   - NO key shape, tracker call/host, or personal path in EITHER surface.
 *   - There is NO exemption list anywhere: the table has no allowlist, and
 *     the table still CATCHES a real shape (proved below with runtime-built
 *     fixtures, so a broken regex cannot make this test vacuously pass).
 *   - The exporter uses the shared table rather than a private one.
 *   - Every crewai source file that imports crewai turns the telemetry off
 *     FIRST -- the order is the whole point, because upstream builds its
 *     client at import time and chromadb reads its settings at import time.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALL_RULES, KEY_SHAPES, PRIVACY, TRACKERS, scanText } from '../../scripts/leak-scan.js'
import { publicFiles } from '../../scripts/export-surface.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

/** Files that are binary or near-binary: a regex over them is noise. */
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|so|dll|exe|pyc|zip|gz|tgz|whl)$/i

/**
 * Locate npm's CLI entry point without a shell.
 *
 * WHY NOT `npm` ON THE PATH: on Windows the executable is a .cmd shim, and
 * B222 was exactly this class of defect -- a command that works in one shell
 * and dies in another. Calling node with npm's JS entry point is the same
 * on every platform.
 *
 * WHY SO MANY CANDIDATES: npm's own layout differs per platform and per
 * installer (a Windows node install keeps npm under the node directory; a
 * POSIX one puts it under ../lib; nvm puts it under ../lib too; a distro
 * package puts it under ../share). The last candidate resolves the `npm`
 * shim found on PATH, which covers whatever the host did.
 */
function npmCliPath (): string {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'share', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && candidate.endsWith('npm-cli.js')) return candidate
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const probe = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(probe)) return probe
    // The `npm` shim on PATH is a symlink to the CLI entry on POSIX and a
    // .cmd shim on Windows; resolve it and follow the real layout.
    for (const shim of ['npm', 'npm.cmd', 'npm.exe']) {
      const shimPath = join(dir, shim)
      if (!existsSync(shimPath)) continue
      let real = shimPath
      try {
        real = realpathSync(shimPath)
      } catch {
        // A shim we cannot resolve is still worth following by name.
      }
      if (real.endsWith('npm-cli.js')) return real
      const near = join(dirname(real), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(near)) return near
    }
  }
  throw new Error('cannot locate npm-cli.js -- npm is required to compute the npm surface')
}

/**
 * The files npm actually packs, from npm itself.
 *
 * WHY THE GROUND TRUTH MATTERS: package.json `files[]` is a pattern list
 * with negations and implicit rules; reading it by hand gets the exclusions
 * wrong. npm is the only authority on what an installer receives.
 */
function npmSurface (): string[] {
  const raw = execFileSync(process.execPath, [npmCliPath(), 'pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  // npm's own warnings go to stderr, so stdout is normally pure JSON. If a
  // future npm prints a preamble to stdout, take the JSON array that starts
  // a line rather than the first bracket anywhere.
  let parsed: Array<{ files?: Array<{ path: string }> }>
  try {
    parsed = JSON.parse(raw) as Array<{ files?: Array<{ path: string }> }>
  } catch {
    const start = raw.search(/^\[/m)
    assert.ok(start >= 0, 'npm pack --json did not return a JSON array')
    parsed = JSON.parse(raw.slice(start)) as Array<{ files?: Array<{ path: string }> }>
  }
  const files = parsed[0]?.files?.map(f => f.path) ?? []
  assert.ok(files.length > 0, 'npm pack returned no files')
  return files
}

/** Scan one surface (repository-relative paths) with the shared table. */
function scanSurface (files: string[]): string[] {
  const hits: string[] = []
  for (const rel of files) {
    if (BINARY.test(rel)) continue
    let text: string
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    for (const hit of scanText(text)) hits.push(`${rel}: ${hit}`)
  }
  return hits
}

function main (): void {
  const npmFiles = npmSurface()
  const publicFilesList = publicFiles(root)

  // 1. Nothing private and nothing that phones home in EITHER surface.
  const npmHits = scanSurface(npmFiles)
  const publicHits = scanSurface(publicFilesList)
  assert.equal(
    npmHits.length,
    0,
    'nothing that npm packs may carry a key shape, a tracker, or a personal path:\n  ' + npmHits.join('\n  '),
  )
  assert.equal(
    publicHits.length,
    0,
    'nothing that the public export carries may carry a key shape, a tracker, or a personal path:\n  ' + publicHits.join('\n  '),
  )

  // 2. The npm surface is a SUBSET of the public surface, so one clean
  //    public tree means a clean npm tree. If this ever stops being true,
  //    the scan above is no longer the stronger of the two.
  const publicSet = new Set(publicFilesList)
  const npmOnly = npmFiles.filter(f => !publicSet.has(f))
  assert.equal(
    npmOnly.length,
    0,
    'every file npm packs must also be in the public surface (npm-only: ' + npmOnly.join(', ') + ')',
  )

  // 3. The npm tarball must never carry a test file: that is why a literal
  //    fixture in a test used to reach GitHub but not npm. Pin the reason.
  assert.equal(
    npmFiles.filter(f => /(^|\/)[^/]*-test\.ts$/.test(f) || /_test\.py$/.test(f)).length,
    0,
    'test files must never ship to npm',
  )

  // 4. The rule table still CATCHES. Positive controls, built at runtime so
  //    this file never carries a literal shape (the very defect it pins).
  const awsShape = 'AKIA' + 'ABCDEFGHIJKLMNOP'
  const googleShape = 'AIza' + 'SyA1234567890abcdefghij'
  const trackerHost = 'google-analytics' + '.com'
  assert.ok(
    scanText('leaked ' + awsShape).length > 0,
    'the shared table must still catch an AWS-shaped credential',
  )
  assert.ok(
    scanText('leaked ' + googleShape).length > 0,
    'the shared table must still catch a Google-shaped credential',
  )
  assert.ok(
    scanText('<script src="https://' + trackerHost + '/g.js"></script>').length > 0,
    'the shared table must still catch a tracker host',
  )

  // 5. All three rule families exist. A table that quietly lost its tracker
  //    family would make this test pass for the wrong reason.
  assert.ok(KEY_SHAPES.length > 0, 'the table must keep its credential shapes')
  assert.ok(TRACKERS.length > 0, 'the table must keep its tracker rules')
  assert.ok(PRIVACY.length > 0, 'the table must keep its privacy rules')
  assert.equal(
    ALL_RULES.length,
    KEY_SHAPES.length + TRACKERS.length + PRIVACY.length,
    'the combined table must be exactly the three families',
  )

  // 6. There is NO exemption list in the code that decides what ships, and
  //    none in either shipping surface. The token is built at runtime so
  //    this test does not trip its own rule.
  //
  //    WHY NOT THE WHOLE TREE: the internal build history and the defect
  //    ledger have to NAME the removed allowlist -- that is how a reader
  //    learns the defect existed and what replaced it. Those documents are
  //    not shipped (docs/ and factory/harness/BUGS.md are excluded from
  //    both surfaces). A prose record of a removed mechanism is the
  //    opposite of a live exemption.
  const exemptToken = 'KNOWN_' + 'FAKE'
  const decisionCode = [
    'scripts/public-export.ts',
    'scripts/leak-scan.ts',
    'scripts/export-surface.ts',
  ]
  const exemptions: string[] = []
  for (const rel of [...decisionCode, ...npmFiles, ...publicFilesList]) {
    if (BINARY.test(rel)) continue
    let text: string
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    if (text.includes(exemptToken)) exemptions.push(rel)
  }
  assert.equal(
    exemptions.length,
    0,
    'no exemption list may exist in the export decision code or in either shipping surface (found in: ' + exemptions.join(', ') + ')',
  )

  // 6b. The shared table has no way to exempt anything: scanText takes one
  //     argument (the text) and returns hits. An allowlist would need a
  //     second parameter or a lookup table.
  const table = readFileSync(join(root, 'scripts', 'leak-scan.ts'), 'utf8')
  assert.ok(
    /export function scanText\s*\(\s*text:\s*string\s*\)/.test(table),
    'scanText must take only the text -- an exemption would need a second parameter',
  )

  // 7. The exporter uses the shared table and the shared surface. A second
  //    copy of either is a second answer to the operator's question.
  const exporter = readFileSync(join(root, 'scripts', 'public-export.ts'), 'utf8')
  assert.ok(
    /from '\.\/leak-scan\.js'/.test(exporter),
    'the exporter must scan with the shared rule table',
  )
  assert.ok(
    /from '\.\/export-surface\.js'/.test(exporter),
    'the exporter must build its tree with the shared surface definition',
  )
  for (const family of ['KEY_SHAPES', 'TRACKERS', 'PRIVACY']) {
    assert.ok(
      !new RegExp('const\\s+' + family + '\\b').test(exporter),
      'the exporter must not carry its own ' + family + ' table',
    )
  }

  // 8. Every crewai source file that imports crewai turns the telemetry off
  //    FIRST. Upstream builds its telemetry client while the package graph
  //    is imported, and chromadb reads its settings at import time, so an
  //    opt-out applied afterwards is applied to a client that is already live.
  const crewDir = join(root, 'crewai', 'src', 'crew')
  const crewFiles = ['basic_team.py', 'service.py', 'structured_test.py', 'ecc_integration_test.py']
  for (const file of crewFiles) {
    const text = readFileSync(join(crewDir, file), 'utf8')
    assert.ok(
      text.includes('from crewai import'),
      file + ' is expected to import crewai -- if that changed, update this test',
    )
    const call = text.indexOf('disable_telemetry()')
    const imp = text.indexOf('from crewai import')
    assert.ok(call >= 0, file + ' must disable the telemetry before importing crewai')
    assert.ok(
      call < imp,
      file + ' must call disable_telemetry() BEFORE `from crewai import` -- upstream builds its telemetry client at import time, so an opt-out set afterwards is too late',
    )
  }

  // 9. The opt-out module sets every flag upstream reads, and sets them
  //    unconditionally (setdefault would let an inherited value win).
  //
  //    WHY THE EXACT DICT ENTRIES: the flag NAMES are the contract with
  //    upstream -- a renamed variable is a silently ineffective opt-out.
  //    The VALUES are the contract with the reader: "true" disables, and
  //    an empty collection endpoint collects nowhere.
  const telemetry = readFileSync(join(crewDir, 'telemetry.py'), 'utf8')
  const expected = [
    "'OTEL_SDK_DISABLED': 'true'",
    "'CREWAI_DISABLE_TELEMETRY': 'true'",
    "'CREWAI_DISABLE_TRACKING': 'true'",
    "'ANONYMIZED_TELEMETRY': 'False'",
    "'LITELLM_TELEMETRY': 'False'",
    "'CHROMA_OTEL_COLLECTION_ENDPOINT': ''",
  ]
  for (const entry of expected) {
    assert.ok(telemetry.includes(entry), 'the opt-out must set ' + entry)
  }
  assert.ok(
    /os\.environ\[name\]\s*=\s*value/.test(telemetry),
    'the opt-out must assign the flags directly -- setdefault would let an inherited value win',
  )
  assert.ok(
    !/\.setdefault\s*\(/.test(telemetry),
    'the opt-out must set its flags unconditionally -- a setdefault call would let an inherited value win',
  )

  console.log('no-private-info: PASS (npm ' + npmFiles.length + ' files, public ' + publicFilesList.length + ' files, 0 hits, 0 exemptions)')
}

main()

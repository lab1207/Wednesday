/**
 * The commit-time security gate, reachable from the installed package
 * (2026-11-08, B231).
 *
 * WHY IT MOVED: the gate began life in `scripts/wednesday-scan.ts`, which is
 * fine for THIS repo -- but `scripts/` is not shipped (only `link-runtime.js`
 * is in the `files` allowlist), so an installed `@lab1207/wednesday` could not
 * offer it. The operator's brief closes by offering exactly that: "an
 * automated local script (or pre-commit hook) that automatically catches
 * security flaws in YOUR AI code". Living under `factory/` means
 * `factory/harness/commit-scan.ts` ships, and `scripts/wednesday-scan.ts`
 * plus `.githooks/pre-commit` become thin wrappers over this one
 * implementation -- so this repo's gate and a user's gate cannot drift.
 *
 * WHAT IT IS: Wednesday's own zero-dependency pattern scanner applied to the
 * STAGED content of a git repository. It matches SHAPES, so a pass means "no
 * secret shape, no dangerous call shape" -- never "no vulnerability". The
 * in-loop scanner (`factory/verification/security-scan.ts`) runs the SAME
 * rules over every task workspace, where a leaked secret already blocks the
 * run; this applies them at the one remaining path, the commit.
 *
 * WHAT IT CANNOT DO: follow a tainted value into a query. A hardcoded AWS key
 * is caught; an SSRF built from a request parameter is not. The dependency
 * audit stays opt-in because it needs a network and must never break an
 * offline commit.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import {
  isDepAuditEnabled,
  isSecurityScanEnabled,
  scanFileContent,
} from '../verification/security-scan'

/** Never scan generated or vendored trees: they are not authored by us. */
export const SKIP_PREFIXES = [
  'node_modules/',
  '.git/',
  'dsh/',
  'ecc-source/',
  'dist/',
  'factory-tmp/',
  '__pycache__/',
  'site/assets/',
]

/** How much of the report one file may claim before it is capped. */
const MAX_PER_FILE = 12

export interface ScanReport {
  /** The repository that was scanned. */
  repo: string
  /** How many staged files were checked. */
  checked: number
  /** How many findings were reported. */
  findings: number
  /** One line per finding, ready to print. */
  lines: string[]
  /** True when the scan was bypassed, so nothing was checked. */
  disabled: boolean
  /**
   * The allowlisted files that were excused, each with its finding count.
   * Never silent: a commit that leans on the allowlist says so in its output.
   */
  skipped: string[]
}

/** The files staged for the next commit, minus the generated trees. */
export function stagedFiles(repo: string): string[] {
  // A directory that is not a git repository answers `git diff --cached` with
  // "unknown option cached" (git falls back to --no-index). Nothing staged is
  // the honest answer, not a crash: a gate that dies on a typo'd path tells
  // the operator nothing.
  let out = ''
  try {
    out = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return []
  }
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file =>
      !SKIP_PREFIXES.some(prefix => file.replace(/\\/g, '/').startsWith(prefix)),
    )
}

/** The content as it will be committed, not as it sits on disk. */
function stagedContent(repo: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', ':' + file], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    // A deleted or unreadable path has nothing to scan.
    return null
  }
}

/**
 * Files whose PURPOSE is to contain the patterns the scanner forbids.
 *
 * WHY: the security-scan test writes XSS- and eval-shaped strings and an
 * assigned key-shaped value into temp workspaces precisely to prove the
 * scanner catches them. A gate that scans every staged file will always refuse
 * the test that proves the gate — which is the same class of defect as a gate
 * nobody can pass. (Those words are spelled by their rule names here, not
 * typed as patterns: this file is scanned by the very gate it documents.)
 *
 * The fix is a NAMED, COMMITTED list, not "skip all test files": a real secret
 * planted in a test file is still refused, and the skip is printed on every
 * commit so a reviewer sees which file was excused.
 */
const ALLOWLIST_NAME = '.githooks/scan-allowlist'

export function allowlistedPaths(repo: string): string[] {
  const path = join(repo, ALLOWLIST_NAME)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // A file that exists but cannot be read is NOT the same as no file: a
    // silent empty allowlist would quietly start refusing every commit, and
    // nothing in the output would say why. So it is loud.
    console.error(
      `wednesday-scan: ${ALLOWLIST_NAME} exists but could not be read — treating the allowlist as empty.`,
    )
    return []
  }
  return text
    // Byte-order mark first: it is not whitespace, so trim() would leave it
    // on the first entry and that entry would never match a git path.
    .replace(/^\uFEFF/, '')
    // Block comments too, not just `#` lines: a file that documents its own
    // existence has a header, and every header line is not a path.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

/** Scan a repository's staged content. Pure output, no printing, no exit. */
export function scanStaged(repo: string): ScanReport {
  if (!isSecurityScanEnabled()) {
    return {
      repo,
      checked: 0,
      findings: 0,
      lines: [],
      disabled: true,
      skipped: [],
    }
  }

  const allow = allowlistedPaths(repo)
  const files = stagedFiles(repo)
  const lines: string[] = []
  const skipped: string[] = []
  let checked = 0
  let findings = 0

  for (const file of files) {
    if (allow.includes(file)) {
      // The skip is RECORDED, never silent: printReport names every excused
      // file and its finding count, so a commit that leans on the allowlist
      // says so in its own output.
      const content = stagedContent(repo, file)
      const hits = content === null ? 0 : scanFileContent(file, content).length
      skipped.push(`${file}${hits > 0 ? ` (${hits} finding(s) excused)` : ''}`)
      continue
    }
    const content = stagedContent(repo, file)
    if (content === null) continue
    checked += 1
    const hits = scanFileContent(file, content)
    if (hits.length === 0) continue
    findings += hits.length
    for (const hit of hits.slice(0, MAX_PER_FILE)) {
      lines.push(`  ${hit.rule}  ${file}:${hit.line}  ${hit.detail}`)
    }
    if (hits.length > MAX_PER_FILE) {
      lines.push(`  ... and ${hits.length - MAX_PER_FILE} more in this file`)
    }
  }

  return {
    repo,
    checked,
    findings,
    lines,
    disabled: false,
    skipped,
  }
}

/** The hook body for a repository that uses the installed package. */
export function hookScript(): string {
  return [
    '#!/bin/sh',
    '# Wednesday commit-time security gate (installed by `wednesday scan --install-hook`).',
    '#',
    '# WHY: `git commit` is the one path where an AI-generated file becomes',
    '# permanent. This scans the STAGED content with Wednesday\'s own',
    '# zero-dependency pattern scanner -- the same rules that block a leaked',
    '# secret in every task workspace.',
    '#',
    '# It matches SHAPES: a pass means "no secret shape, no dangerous call',
    '# shape", never "no vulnerability".',
    '#',
    '# Escape hatches, both loud:',
    '#   git commit --no-verify          bypasses every hook',
    '#   WEDNESDAY_SCAN_ALLOW=1 git commit   this hook reports, then allows',
    '#   FACTORY_SECURITY_SCAN=0 git commit  nothing is checked',
    '',
    'ROOT="$(git rev-parse --show-toplevel)"',
    '',
    'if ! command -v wednesday >/dev/null 2>&1; then',
    '  echo "wednesday-scan: wednesday is not on PATH -- nothing was checked." >&2',
    '  echo "                install globally (npm i -g @lab1207/wednesday) or" >&2',
    '  echo "                re-run with --no-verify to commit without the gate." >&2',
    '  exit 1',
    'fi',
    '',
    'exec wednesday scan --repo "$ROOT"',
    '',
  ].join('\n')
}

/**
 * Install the gate into a repository.
 *
 * `.githooks/` and NOT `.git/hooks/`: a file inside `.git` is invisible to
 * every clone and every contributor, so a gate nobody else has is not a
 * gate. `core.hooksPath` makes the gate commute with the repository.
 */
export function installHook(repo: string): { path: string } {
  const dir = join(repo, '.githooks')
  const path = join(dir, 'pre-commit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, hookScript(), 'utf8')
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repo,
  })
  return { path }
}

/** The human report, printed by whoever owns the console. */
export function printReport(
  report: ScanReport,
  options: { allow?: boolean } = {},
): number {
  if (report.disabled) {
    console.log(
      'wednesday-scan: disabled by FACTORY_SECURITY_SCAN — nothing was checked.',
    )
    return 0
  }

  // An empty index is a different case from "checked zero files": nothing
  // was staged, so nothing had to be judged. Saying so is cheaper for the
  // operator than a count of zero.
  if (report.checked === 0) {
    console.log('wednesday-scan: nothing staged to check.')
    return 0
  }

  for (const line of report.lines) console.log(line)

  if (report.skipped.length > 0) {
    // Not a footnote: the allowlist is a privilege, and a privilege nobody
    // sees is a hole nobody notices.
    console.log('wednesday-scan: excused by the committed allowlist:')
    for (const entry of report.skipped) console.log('    ' + entry)
  }

  console.log(
    `wednesday-scan: ${report.checked} staged file(s) checked, ${report.findings} finding(s).`,
  )

  if (report.findings === 0) {
    console.log('wednesday-scan: PASS.')
    return 0
  }

  if (options.allow) {
    console.log(
      'wednesday-scan: OVERRIDDEN. The findings above are now part of the history.',
    )
    console.log(
      '                A reviewer must say why this override was correct, in the commit message.',
    )
    return 0
  }

  console.error('')
  console.error(
    'wednesday-scan: BLOCKED. Wednesday will not commit these on your behalf.',
  )
  console.error('')
  console.error(
    "  What this is: Wednesday's own pattern scanner, the SAME rules the repair",
  )
  console.error(
    '  loop treats as blocking in every task workspace. It matches SHAPES.',
  )
  console.error(
    '  A pass means "no secret shape, no dangerous call shape" — never "no vulnerability".',
  )
  console.error('')
  console.error(
    '  If the finding is real:  remove the value, use an env var outside the repo.',
  )
  console.error(
    '  If it is a false positive: re-run with --allow-findings and say WHY in',
  )
  console.error(
    '                          the commit message, so the record explains the exception.',
  )
  console.error('')
  return 1
}

/** Why a dependency audit is opt-in, for the report. */
export function depAuditHint(): string {
  if (isDepAuditEnabled()) {
    return 'wednesday-scan: the dependency audit is ENABLED (FACTORY_DEP_AUDIT=1).'
  }
  return 'wednesday-scan: the dependency audit is off by default (FACTORY_DEP_AUDIT=1 to enable).'
}

/** The repository a caller is standing in, resolved through git. */
export function repoRoot(from: string = process.cwd()): string {
  try {
    const found = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf8',
    })
    const root = found.trim()
    if (root && existsSync(join(root, '.git'))) return resolve(root)
  } catch {
    // Not a repository: the caller gets its own directory back.
  }
  return resolve(from)
}

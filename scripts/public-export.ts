/**
 * Builds the public repository tree from tracked files — free core only.
 *
 *   node --import tsx scripts/public-export.ts                 # build dist/public-staging + leak scan
 *   node --import tsx scripts/public-export.ts --git            # overlay onto the public master (one commit per release) and push
 *   node --import tsx scripts/public-export.ts --git --fresh    # re-clone the public repo first (recovery)
 *
 * Why this exists: the working repository also holds internal planning docs,
 * business notes, and a dev log. The public repo is never a checkout of it.
 * This exports an allowlisted tree — free core only — and scans it for
 * secrets and personal paths.
 *
 * Since 2026-11-05 the public repo keeps NORMAL history: each export is
 * committed as a child of the current public master and pushed with an
 * ordinary (non-force) push. Internal history never enters it, but real
 * release history accumulates, PR merges stay reachable, and blame/tags
 * work. A merged PR that this tree does not contain aborts the export
 * instead of deleting it.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Always rebuilt: the exact bytes the scan and the commit will carry. */
const staging = join(root, 'dist', 'public-staging')
/** Persistent clone of the public repo — the push lives here, not on a throwaway init. */
const repo = join(root, 'dist', 'public-repo')
const LABS_URL = 'https://github.com/lab1207/Wednesday.git'
const args = new Set(process.argv.slice(2))

/** Files and directories that are allowed into the public repository. */
const ALLOW_FILES = new Set([
  '.gitignore',
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'THIRD_PARTY_LICENSES.md',
  'package.json',
  'package-lock.json',
])
const ALLOW_DIRS = ['bin/', 'factory/', 'crewai/', 'ecc/', 'shared/', 'scripts/', 'media/', '.github/']

/** Never public, even though they are tracked. */
const DENY = [
  /^docs\//,
  /^site\//,
  /^wednesday-theme\//,
  /^AGENTS\.md$/,
  /^factory\/harness\/BUGS\.md$/,
  /^factory\/harness\/yc-demo-test\.ts$/,
  /^factory\/tmp\//,
  /(^|\/)\.env/,
  /(^|\/)state\//,
]

/** Patterns that must not appear anywhere in the export. */
const LEAKS: Array<[string, RegExp]> = [
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['xAI key', /\bxai-[A-Za-z0-9_-]{16,}/],
  ['NVIDIA key', /\bnvapi-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['private key block', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['real ngrok host', /\b[a-z0-9][a-z0-9-]{4,}\.ngrok(-free)?\.(dev|app|io)\b/],
  ['personal Windows profile', /C:\\Users\\(?!operator\b|you\b|me\b|example\b|Public\b|<)/i],
  ['personal POSIX home', /\/home\/(?!you\b|user\b|runner\b)[a-z][a-z0-9_-]{2,}\//i],
  ['internal doc reference', /\bWEDNESDAY_(BUSINESS|MONEY|SECURITY_AUDIT|SNAPSHOT|BUILD_HISTORY)/],
]

function tracked (): string[] {
  // Tracked files plus new files that are not ignored, so a fresh template or
  // page is not silently left out of the export.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

function allowed (file: string): boolean {
  if (DENY.some(rx => rx.test(file))) return false
  if (ALLOW_FILES.has(file)) return true
  return ALLOW_DIRS.some(dir => file.startsWith(dir))
}

function walk (dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

let copied = 0
for (const file of tracked()) {
  if (!allowed(file)) continue
  const src = join(root, file)
  if (!existsSync(src)) continue
  const dest = join(staging, file)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest)
  copied++
}

// Git metadata for a clean public history.
writeFileSync(join(staging, '.gitignore'), [
  '# Generated / runtime — never commit',
  'node_modules/',
  'dist/',
  '*.tgz',
  '.env',
  '.env.*',
  '!.env.example',
  'logs/',
  'shared/state/*',
  '!shared/state/.gitkeep',
  'factory/tmp/',
  'factory/**/*.jsonl',
  '__pycache__/',
  '*.py[cod]',
  '.venv/',
  '.DS_Store',
  '',
].join('\n'))

/** Documented fake fixtures used by the redaction tests — not real credentials. */
const KNOWN_FAKE = /^(AKIAABCDEFGHIJKLMNOP|AKIAIOSFODNN7EXAMPLE|AIzaSyA1234567890abcdefghij)$/

const problems: string[] = []
const files = walk(staging)
for (const full of files) {
  const rel = relative(staging, full).replace(/\\/g, '/')
  if (rel === '.gitignore') continue
  if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|so|dll|exe)$/i.test(rel)) continue
  const text = readFileSync(full, 'utf8')
  for (const [name, rx] of LEAKS) {
    const match = text.match(rx)
    if (match && !KNOWN_FAKE.test(match[0])) {
      problems.push(`${rel}: ${name} -> ${match[0].slice(0, 60)}`)
    }
  }
}

if (problems.length) {
  console.error('PUBLIC EXPORT: FAIL — leak scan found issues:')
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}

/** Remove everything except .git in the export clone. */
function clearClone (): void {
  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    rmSync(join(repo, entry.name), { recursive: true, force: true })
  }
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

if (args.has('--git')) {
  const releaseVersion = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')).version
  if (args.has('--fresh')) rmSync(repo, { recursive: true, force: true })
  if (!existsSync(join(repo, '.git'))) {
    console.log('PUBLIC EXPORT: cloning the public repository…')
    execFileSync('git', ['clone', '-q', LABS_URL, repo], { stdio: 'inherit' })
  }
  git(repo, ['fetch', '-q', 'origin'])
  const theirs = git(repo, ['rev-parse', 'origin/master'])
  const ours = (() => { try { return git(repo, ['config', 'wednesday.lastPushedSha']) } catch { return '' } })()
  git(repo, ['reset', '--hard', '-q', 'origin/master'])
  if (ours) {
    // The normal path: this clone WAS the last thing pushed; if anything landed
    // on top since (a merged PR), this export would delete it — abort instead.
    if (ours !== theirs) {
      const changed = git(repo, ['diff', '--name-only', ours, theirs])
      console.error('PUBLIC EXPORT: ABORT — the public repo moved since the last export.')
      console.error('  A pull request was probably merged on GitHub. Merge it BEFORE re-exporting:')
      console.error('    git fetch labs && git merge --no-edit labs/master')
      console.error('  Files in the way:\n' + changed.split('\n').map(l => '    ' + l).join('\n'))
      process.exit(1)
    }
  } else {
    // Migration / re-cloned: nothing present in the public tip may be missing
    // from the staging tree (that file would be silently deleted from the repo).
    const stagedFiles = new Set(walk(staging).map(full => relative(staging, full).replace(/\\/g, '/')))
    const missing: string[] = []
    for (const full of walk(repo)) {
      if (relative(repo, full).replace(/\\/g, '/').startsWith('.git/')) continue
      const rel = relative(repo, full).replace(/\\/g, '/')
      if (rel === '.gitignore') continue
      if (!stagedFiles.has(rel)) missing.push(rel)
    }
    if (missing.length) {
      console.error('PUBLIC EXPORT: ABORT — files present in the public repo are missing from this tree:')
      for (const file of missing) console.error('  ' + file)
      console.error('  A merged PR would be deleted. Run: git fetch labs && git merge --no-edit labs/master')
      process.exit(1)
    }
    console.log('PUBLIC EXPORT: fresh clone accepted (' + theirs.slice(0, 7) + '); no public file would be deleted.')
  }
  clearClone()
  cpSync(staging, repo, { recursive: true })
  git(repo, ['add', '-A'])
  let changed = true
  try {
    git(repo, ['diff', '--cached', '--quiet'])
    changed = false
  } catch { /* exit 1 = there are staged changes */ }
  if (!changed) {
    git(repo, ['config', 'wednesday.lastPushedSha', theirs])
    console.log('PUBLIC EXPORT: no changes vs the public master — nothing to publish.')
    process.exit(0)
  }
  git(repo, ['-c', 'user.name=lab1207', '-c', 'user.email=hajarevaibhav527@gmail.com',
    'commit', '-q', '-m', `Wednesday ${releaseVersion} - free, open-source core (Apache 2.0)`])
  git(repo, ['push', '-q', 'origin', 'master'])
  const sha = git(repo, ['rev-parse', 'HEAD']).slice(0, 7)
  git(repo, ['config', 'wednesday.lastPushedSha', sha])
  console.log(`PUBLIC EXPORT: pushed ${sha} (normal push — history preserved)`)
}

console.log(`PUBLIC EXPORT: PASS — ${copied} tracked files copied to ${relative(root, staging)}`)
console.log(`  files in export: ${files.length}`)
console.log('  excluded: docs/, site/, wednesday-theme/, AGENTS.md, factory/harness/BUGS.md')
if (!args.has('--git')) console.log('  next: run with --git to overlay-publish one commit to the public repo')

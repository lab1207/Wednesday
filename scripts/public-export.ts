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
 * secrets, tracking code and personal paths.
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

import { publicFiles } from './export-surface.js'
import { scanText } from './leak-scan.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Always rebuilt: the exact bytes the scan and the commit will carry. */
const staging = join(root, 'dist', 'public-staging')
/** Persistent clone of the public repo — the push lives here, not on a throwaway init. */
const repo = join(root, 'dist', 'public-repo')
const LABS_URL = 'https://github.com/lab1207/Wednesday.git'
const args = new Set(process.argv.slice(2))

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
for (const file of publicFiles(root)) {
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

/**
 * The leak rules live in ONE place, shared with the release regression.
 *
 * WHY (operator rule, 2026-11-08: no API keys, codes or secret shapes --
 * and no Google-analytics-style tracking code -- in the npm release OR on
 * GitHub, in ANY version): this exporter used to carry its own pattern
 * list, and the regression carried another one. Two lists drift, and a
 * "known fake" allowlist could sit between the scan and the answer: the
 * scan said PASS while the tree carried a key shape, because the shape was
 * excused. A stranger reading the public repo cannot see an excuse, so
 * there is no excuse any more.
 *
 * WHY NO EXEMPTION LIST: every fixture that used to need one is now BUILT
 * AT RUNTIME in the file that uses it (see
 * factory/security/redaction-test.ts and
 * factory/verification/security-scan-test.ts), so the exported tree carries
 * ZERO key shapes. A literal key shape in the source now aborts the
 * export, which is the point.
 */
const problems: string[] = []
const files = walk(staging)
for (const full of files) {
  const rel = relative(staging, full).replace(/\\/g, '/')
  if (rel === '.gitignore') continue
  if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|so|dll|exe)$/i.test(rel)) continue
  const text = readFileSync(full, 'utf8')
  for (const hit of scanText(text)) {
    problems.push(`${rel}: ${hit}`)
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
  const sha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['config', 'wednesday.lastPushedSha', sha])
  console.log(`PUBLIC EXPORT: pushed ${sha.slice(0, 7)} (normal push — history preserved)`)
}

console.log(`PUBLIC EXPORT: PASS — ${copied} tracked files copied to ${relative(root, staging)}`)
console.log(`  files in export: ${files.length}`)
console.log('  excluded: docs/, site/, wednesday-theme/, AGENTS.md')
if (!args.has('--git')) console.log('  next: run with --git to overlay-publish one commit to the public repo')

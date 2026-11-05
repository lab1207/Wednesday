/**
 * Builds the public repository tree from tracked files — free core only.
 *
 *   node --import tsx scripts/public-export.ts            # build dist/public-repo
 *   node --import tsx scripts/public-export.ts --git      # + fresh git repo, one commit
 *
 * Why this exists: the working repository also holds internal planning docs,
 * business notes, and a dev log. Flipping it public as-is would publish all of
 * that, including its git history. This exports an allowlisted tree with a
 * fresh history, then scans the result for secrets and personal paths. The
 * export is the only thing that may be pushed to the public repository.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'public-repo')
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

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

let copied = 0
for (const file of tracked()) {
  if (!allowed(file)) continue
  const src = join(root, file)
  if (!existsSync(src)) continue
  const dest = join(out, file)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest)
  copied++
}

// Git metadata for a clean public history.
writeFileSync(join(out, '.gitignore'), [
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
const files = walk(out)
for (const full of files) {
  const rel = relative(out, full).replace(/\\/g, '/')
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

if (args.has('--git')) {
  const run = (cmd: string, argv: string[]) => execFileSync(cmd, argv, { cwd: out, stdio: 'pipe' })
  const releaseVersion = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).version
  run('git', ['init', '-q', '-b', 'master'])
  run('git', ['add', '-A'])
  run('git', ['-c', 'user.name=lab1207', '-c', 'user.email=hajarevaibhav527@gmail.com',
    'commit', '-q', '-m', `Wednesday ${releaseVersion} - free, open-source core (Apache 2.0)`])
}

console.log(`PUBLIC EXPORT: PASS — ${copied} tracked files copied to ${relative(root, out)}`)
console.log(`  files in export: ${files.length}`)
console.log('  excluded: docs/, site/, wednesday-theme/, AGENTS.md, factory/harness/BUGS.md')
if (!args.has('--git')) console.log('  next: add --git to create a clean single-commit history')

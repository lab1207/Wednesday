import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * V1.4 OpenHands connector — Layer 3 repository understanding.
 *
 * Profiles a real workspace (file inventory, languages, key files, entry
 * points) and converts it into EngineeringTask constraints, so Factory runs
 * become repository-aware without changing the orchestration contract.
 * Roadmap section 7: strengthens project intelligence; does not replace the
 * orchestrator.
 */

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '__pycache__', '.venv', 'venv', '.DS_Store',
  // The 2026-10-16 freeze: a bare request with no --workspace defaults to the
  // home directory, and the walk descended into AppData — tens of thousands of
  // directories of browser caches and installer temp. AppData is never a
  // source tree for an engineering task on Windows.
  'AppData',
])

/**
 * Time budget for one profile walk.
 *
 * The walk is a HINT engine, not a contract: a truncated profile still names
 * the languages and key files near the root, while an unbounded walk of a
 * home directory is what made "Enter" look like a freeze. The 10k visited
 * directories cap stays as the second bound for pathological trees.
 */
const WALK_BUDGET_MS = 4000
let walkDeadline = 0

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.pyw': 'Python',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.rb': 'Ruby',
  '.php': 'PHP', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.swift': 'Swift', '.kt': 'Kotlin', '.scala': 'Scala', '.sh': 'Shell',
  '.ps1': 'PowerShell', '.bat': 'Batch', '.cmd': 'Batch', '.sql': 'SQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.md': 'Markdown',
}

const KEY_FILES = new Set([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile',
  'README.md', 'Dockerfile', 'docker-compose.yml', 'Makefile',
])

const ENTRY_FILENAMES = new Set([
  'index.ts', 'index.js', 'main.ts', 'main.js', 'main.py', 'app.py', 'app.ts',
])

export interface RepositoryProfile {
  workspace: string
  exists: boolean
  fileCount: number
  languages: string[]
  keyFiles: string[]
  entryCandidates: string[]
  dependencies: string[]
  testFiles: string[]
  importEdgeCount: number
  toConstraints(): string[]
}

/**
 * Repository profiles, memoised per workspace.
 *
 * `analyzeRepository` walks the whole tree, which is the right price once and
 * the wrong price before every request: the CLI asks for a profile per request
 * and a real repo costs about a second of blocked event loop each time, which
 * is what made the approval gate feel late and the screen feel dead.
 *
 * Session-scoped on purpose — the CLI process IS the session. A long-lived
 * caller (service, worker) that needs fresh data calls
 * `clearRepositoryProfileCache()`; concurrent callers share one in-flight walk
 * instead of starting their own.
 */
const profileCache = new Map<string, Promise<RepositoryProfile>>()

export function analyzeRepositoryCached(workspace: string): Promise<RepositoryProfile> {
  const hit = profileCache.get(workspace)
  if (hit) return hit
  const pending = analyzeRepository(workspace).catch(error => {
    // Defensive: the public walk is fail-open today (a broken workspace yields
    // an empty profile), so this branch is unreachable — but if a future walk
    // throws, a rejection must not become a cached rejection that replays for
    // the rest of the session.
    profileCache.delete(workspace)
    throw error
  })
  profileCache.set(workspace, pending)
  return pending
}

export function clearRepositoryProfileCache(): void {
  profileCache.clear()
}

export async function analyzeRepository(workspace: string): Promise<RepositoryProfile> {
  // Module counters must reset per call: long-lived processes (service,
  // harness REPL) analyze many workspaces, and stale counters would
  // silently return empty profiles after ~10k walked dirs or a lapsed
  // deadline.
  walked = 0
  walkDeadline = Date.now() + WALK_BUDGET_MS
  const files = await walk(workspace).catch(() => [] as string[])
  const exists = files.length > 0

  const languages = new Set<string>()
  const keyFiles: string[] = []
  const entryCandidates: string[] = []
  const testFiles: string[] = []

  for (const file of files) {
    const name = file.split('\\').pop() ?? file
    const rel = relative(workspace, file).replaceAll('\\', '/')
    const extension = name.slice(name.lastIndexOf('.'))
    const language = LANGUAGE_BY_EXTENSION[extension]
    if (language) languages.add(language)

    if (KEY_FILES.has(name)) keyFiles.push(rel)
    if (ENTRY_FILENAMES.has(name)) entryCandidates.push(rel)
    if (isTestFile(rel)) testFiles.push(rel)
  }

  const dependencies = [...new Set([
    ...(await readPackageDeps(workspace)),
    ...(await readPyprojectDeps(workspace)),
    ...(await readCargoDeps(workspace)),
    ...(await readGoModDeps(workspace)),
  ])].sort().slice(0, 20)
  const importEdgeCount = await countRelativeImports(files)

  return {
    workspace,
    exists,
    fileCount: files.length,
    languages: [...languages],
    keyFiles,
    entryCandidates,
    dependencies,
    testFiles,
    importEdgeCount,
    toConstraints() {
      if (!exists) return []
      const lines: string[] = []
      lines.push(`Repository context: ${files.length} files, languages: ${languages.size > 0 ? [...languages].join(', ') : 'unknown'}`)
      if (keyFiles.length > 0) lines.push(`Repository context: key files ${keyFiles.slice(0, 8).join(', ')}`)
      if (entryCandidates.length > 0) lines.push(`Repository context: entry candidates ${entryCandidates.slice(0, 5).join(', ')}`)
      if (dependencies.length > 0) lines.push(`Repository context: dependencies ${dependencies.slice(0, 10).join(', ')}`)
      if (testFiles.length > 0) lines.push(`Repository context: tests ${testFiles.slice(0, 10).join(', ')}`)
      if (importEdgeCount > 0) lines.push(`Repository context: internal imports ~${importEdgeCount} edges`)
      return lines
    },
  }
}

/** C1 depth: manifests beyond npm (python/rust/go), still static-only. */
function manifestDepNames(text: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = pattern.exec(line.trim())
    if (match) out.push(match[1])
  }
  return out
}

async function readPyprojectDeps(workspace: string): Promise<string[]> {
  try {
    const raw = await readFile(join(workspace, 'pyproject.toml'), 'utf8')
    // [project] dependencies = ["name>=x", ...] (PEP 508 strings)
    const names = manifestDepNames(raw, /^["']([A-Za-z0-9_.-]+)/)
    return [...new Set(names)].sort().slice(0, 20)
  } catch {
    return []
  }
}

async function readCargoDeps(workspace: string): Promise<string[]> {
  try {
    const raw = await readFile(join(workspace, 'Cargo.toml'), 'utf8')
    // [dependencies] name = "x" lines (section-scoped below)
    const lines = raw.split('\n')
    let inDeps = false
    const names: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^\[.*\]$/.test(trimmed)) {
        inDeps = trimmed === '[dependencies]' || trimmed === '[dev-dependencies]'
        continue
      }
      if (inDeps) {
        const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)
        if (match) names.push(match[1])
      }
    }
    return [...new Set(names)].sort().slice(0, 20)
  } catch {
    return []
  }
}

async function readGoModDeps(workspace: string): Promise<string[]> {
  try {
    const raw = await readFile(join(workspace, 'go.mod'), 'utf8')
    const names = manifestDepNames(raw, /^\S+\s+([a-z0-9.\-]+\/[a-z0-9.\-/]+)/i)
    return [...new Set(names.map(name => name.split('/').slice(0, 3).join('/')))].sort().slice(0, 20)
  } catch {
    return []
  }
}
function isTestFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel
  return (
    /\.test\.[tj]sx?$/.test(base) ||
    /\.spec\.[tj]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /.*_test\.py$/.test(base) ||
    /.*_test\.go$/.test(base) ||
    /.*Test\.java$/.test(base)
  )
}

async function readPackageDeps(workspace: string): Promise<string[]> {
  try {
    const raw = await readFile(join(workspace, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]
    return [...new Set(deps)].sort().slice(0, 20)
  } catch {
    return []
  }
}

const RELATIVE_IMPORT =
  /(?:from\s+['"](\.[^'"]+)['"]|import\s+[^'"]*?from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)|from\s+\.\s+import\s+)/g

async function countRelativeImports(files: string[]): Promise<number> {
  let edges = 0
  const candidates = files
    .filter(f => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(f))
    .slice(0, 50)
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8')
      if (text.length > 65536) continue
      const matches = text.match(RELATIVE_IMPORT)
      if (matches) edges += matches.length
      if (edges > 500) break
    } catch {
      continue
    }
  }
  return edges
}

/** ponytail: depth 6 / 10k files / 4s budget, enough for product repos. */
async function walk(directory: string, depth = 0): Promise<string[]> {
  if (depth > 6 || files_limit_reached() || Date.now() > walkDeadline) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) {
      files.push(join(directory, entry.name))
    } else if (entry.isDirectory() && !IGNORED.has(entry.name)) {
      files.push(...await walk(join(directory, entry.name), depth + 1))
    }
  }
  return files
}

let walked = 0
function files_limit_reached(): boolean {
  return ++walked > 10_000
}

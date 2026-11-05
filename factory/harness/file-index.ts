/**
 * The workspace file index the `@` completion reaches.
 *
 * qwen-code completes `@` against an async file search; Wednesday uses a
 * BOUNDED, LAZY scan of the workspace:
 *
 *  - LAZY: the index is built the first time the operator actually types an
 *    `@`, not on every keystroke and not at startup. A session that never
 *    mentions a file never pays for the walk.
 *  - BOUNDED: the walk stops at a fixed number of files and a fixed depth,
 *    and skips the noise directories. A repository with 200k files must not
 *    be able to hang the composer.
 *  - CACHED: the result is kept for the session. The workspace does not
 *    change under a typing operator, and a re-scan on every `@` would make
 *    the completion slower the longer the session runs.
 *
 * Paths are workspace-relative and use forward slashes, so the same text can
 * be pasted into a shell on any platform. Directories are listed too, with a
 * trailing `/`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** How many files the index may hold. */
export const FILE_INDEX_LIMIT = 4000

/** How deep the walk may go. */
export const FILE_INDEX_DEPTH = 8

/**
 * Directories that never hold something the operator would `@`-mention.
 *
 * `node_modules` alone can be 200k files; `dist` and `.git` are noise. The
 * list is deliberately conservative: a project that keeps its sources in one
 * of these directories would lose them from the completion, so only the
 * unambiguous ones are skipped.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  '.next',
  '.nuxt',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
])

/** One file the index knows about. */
export interface WorkspaceFile {
  /** Workspace-relative path, forward slashes. */
  path: string
}

/**
 * Walk the workspace and return the paths, sorted.
 *
 * DIRECTORIES ARE INCLUDED, with a trailing `/` — pi's rule (MIT): the
 * operator who typed `@factory` is still choosing the folder, so `factory/`
 * must be one of the candidates, and it must be distinguishable from
 * `factory` (a file) at a glance.
 *
 * @param root the workspace directory
 * @param limit the most paths to return
 */
export function scanWorkspaceFiles(root: string, limit = FILE_INDEX_LIMIT): string[] {
  const start = resolve(root)
  const found: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > FILE_INDEX_DEPTH || found.length >= limit) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip it, do not fail the completion
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const name = entry.name
      if (name.startsWith('.') && name !== '.env.example') continue
      const full = join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        const rel = relative(start, full).split(sep).join('/')
        // The directory itself is a candidate, and so is everything under it.
        if (rel && !seen.has(`${rel}/`)) {
          seen.add(`${rel}/`)
          found.push(`${rel}/`)
        }
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(start, full).split(sep).join('/')
      if (!rel || seen.has(rel)) continue
      seen.add(rel)
      found.push(rel)
    }
  }
  walk(start, 0)
  found.sort((a, b) => a.localeCompare(b))
  return found
}

/**
 * A lazy, cached index for one workspace.
 *
 * The returned function is what the completion engine calls: it does the
 * walk on the first call and never again.
 */
export function fileIndex(root: string, limit = FILE_INDEX_LIMIT): () => readonly string[] {
  let cache: string[] | null = null
  return () => {
    if (cache) return cache
    try {
      if (!statSync(root).isDirectory()) {
        cache = []
        return cache
      }
    } catch {
      cache = []
      return cache
    }
    cache = scanWorkspaceFiles(root, limit)
    return cache
  }
}

/**
 * Workspace watcher — what a seat touches, while it touches it.
 *
 * The orchestrator learns the files a run changed only at the END: the
 * executor's change collector walks the workspace after the host child exits.
 * During the run the operator saw nothing, so a coder that spent two minutes
 * rewriting one file looked exactly like a coder that was stuck (operator,
 * 2026-11-04: "stream the file changes, the diffs, the commands").
 *
 * This watcher polls the workspace and reports every file that appeared,
 * changed or disappeared while the run was in flight. It is deliberately
 * simple: a poll of directory metadata, not a platform watcher, because the
 * executor runs the child in a workspace that may be on any filesystem and the
 * watcher must never be the reason a run fails.
 */
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs'
import {
  join,
  relative,
  sep,
} from 'node:path'

/** Directories that are never interesting and are often enormous. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.wednesday',
])

/** How deep the walk goes. A run that writes ten levels down is a bug. */
const MAX_DEPTH = 8

/** The most files one snapshot holds; beyond that the run is a build, not an edit. */
const MAX_FILES = 4000

export interface WorkspaceChange {
  /** The path relative to the workspace root, with forward slashes. */
  path: string
  change: 'created' | 'modified' | 'deleted'
}

/** One file's fingerprint: when it last changed and how big it is. */
type Fingerprints = Map<string, string>

function fingerprint(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

/**
 * Every file under `root`, with its fingerprint. Unreadable entries are
 * skipped: a watcher that throws would take the run down with it.
 */
export function snapshotWorkspace(root: string): Fingerprints {
  const files: Fingerprints = new Map()
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.size >= MAX_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.size >= MAX_FILES) return
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let isDirectory = false
      try {
        isDirectory = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        walk(full, depth + 1)
        continue
      }
      const mark = fingerprint(full)
      if (mark === undefined) continue
      files.set(relative(root, full).split(sep).join('/'), mark)
    }
  }
  if (!existsSync(root)) return files
  walk(root, 0)
  return files
}

/** What changed between two snapshots. */
export function diffWorkspace(
  before: Fingerprints,
  after: Fingerprints,
): WorkspaceChange[] {
  const changes: WorkspaceChange[] = []
  for (const [path, mark] of after) {
    const previous = before.get(path)
    if (previous === undefined) changes.push({ path, change: 'created' })
    else if (previous !== mark) changes.push({ path, change: 'modified' })
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, change: 'deleted' })
  }
  return changes
}

/**
 * A running watcher. `start()` takes the first snapshot; `poll()` returns
 * what changed since the last poll; `stop()` ends the loop.
 */
export class WorkspaceWatcher {
  private previous: Fingerprints = new Map()
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(
    private readonly root: string,
    private readonly onChange: (change: WorkspaceChange) => void,
    private readonly intervalMs = 800,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.previous = snapshotWorkspace(this.root)
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  poll(): WorkspaceChange[] {
    if (!this.running) return []
    const now = snapshotWorkspace(this.root)
    const changes = diffWorkspace(this.previous, now)
    this.previous = now
    for (const change of changes) {
      try {
        this.onChange(change)
      } catch {
        // A watcher that throws must never end the run it watches.
      }
    }
    return changes
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

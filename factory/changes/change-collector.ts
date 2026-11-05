import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

interface FileSnapshot {
  hash: string
}

type Snapshot = Map<string, FileSnapshot>

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
])
export interface ChangeCollectorResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

export class ChangeCollector {
  async snapshot(workspace: string): Promise<Snapshot> {
    const snapshot: Snapshot = new Map()
    await this.walk(workspace, workspace, snapshot)
    return snapshot
  }

  diff(before: Snapshot, after: Snapshot): ChangeCollectorResult {
    const added: string[] = []
    const modified: string[] = []
    const deleted: string[] = []

    for (const [path, current] of after) {
      const previous = before.get(path)

      if (previous === undefined) {
        added.push(path)
        continue
      }

      if (previous.hash !== current.hash) {
        modified.push(path)
      }
    }

    for (const path of before.keys()) {
      if (!after.has(path)) {
        deleted.push(path)
      }
    }

    return {
      added: added.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
    }
  }

  async collect(
    workspace: string,
    before: Snapshot,
  ): Promise<ChangeCollectorResult> {
    const after = await this.snapshot(workspace)
    return this.diff(before, after)
  }

  private async walk(
    root: string,
    directory: string,
    snapshot: Snapshot,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue
      }

      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        await this.walk(root, absolute, snapshot)
        continue
      }

      const content = await readFile(absolute)
      const hash = createHash('sha256').update(content).digest('hex')

      const relativePath = relative(root, absolute).split(sep).join('/')

      snapshot.set(relativePath, { hash })
    }
  }
}
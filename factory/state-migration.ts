import { constants } from 'node:fs'
import { copyFile, mkdir, lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { EVENTS_PATH, INSTALL_ROOT, TASKS_PATH } from './paths'

// First-use copy of install-tree records into the profile state home, not a
// merge. Existing destinations are authoritative; originals are never modified.
export async function copyLegacyState(
  source: string,
  destination: string,
  kind: 'tasks' | 'events',
): Promise<void> {
  if (resolve(source) === resolve(destination)) return
  try {
    await lstat(destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let raw: string
  try {
    raw = await readFile(source, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Refuse damaged legacy data rather than silently starting an empty history.
  if (kind === 'tasks') {
    const parsed = JSON.parse(
      raw.replace(/^\uFEFF/, ''),
    ) as { tasks?: unknown } | null
    if (!parsed || !Array.isArray(parsed.tasks)) {
      throw new Error('Legacy task store has no tasks array.')
    }
  } else {
    for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
      JSON.parse(line)
    }
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

const LEGACY_TASKS = join(INSTALL_ROOT, 'factory', 'hermes', 'tasks.json')
const LEGACY_EVENTS = join(INSTALL_ROOT, 'factory', 'events', 'factory-events.jsonl')

/** Copy legacy checkout records once. Explicit path overrides disable it. */
export async function migrateLegacyState(): Promise<void> {
  if (process.env.HERMES_TASKS_PATH === undefined) {
    await copyLegacyState(LEGACY_TASKS, TASKS_PATH, 'tasks')
  }
  if (process.env.FACTORY_EVENTS_PATH === undefined) {
    await copyLegacyState(LEGACY_EVENTS, EVENTS_PATH, 'events')
  }
}

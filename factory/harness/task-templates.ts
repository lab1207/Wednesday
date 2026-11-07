/**
 * Task templates - saved operator requests the factory can replay.
 *
 * A template is a request the operator already typed, plus the inline flags
 * it was created with. Saving one turns a one-off instruction into a
 * repeatable move: the same request, the same verification command, the same
 * required files - without retyping and without hoping the run before it left
 * a trail.
 *
 * Stored in `~/.wednesday/state/templates.json` - never the repo.
 *
 * Two guarantees the crew store does not make, because a template list is
 * operator-authored history and losing it is losing work:
 *
 * 1. ATOMIC WRITES. The store is written to a sibling `.tmp` file and then
 *    renamed over the target. A crash mid-write leaves the previous file
 *    intact instead of a truncated JSON blob.
 * 2. A CORRUPT FILE IS READ, NEVER DESTROYED. `loadTemplates` returns an
 *    empty list and leaves the bytes on disk alone, so an operator can still
 *    recover the file by hand.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME } from '../paths'

export interface TaskTemplate {
  id: string
  name: string
  /** The plain-language request, exactly as the operator typed it. */
  request: string
  /**
   * Inline flags the request was created with, e.g. { test: 'npm test', 'required-file': 'src/a.ts' }.
   *
   * A value may be an ARRAY, because a request can carry MORE THAN ONE
   * `--test` and a comma-joined string cannot hold them safely: a test
   * command may itself contain a comma (`node -e "..."`).
   */
  flags?: Record<string, string | string[]>
  /** Optional workspace the template is bound to; empty = any workspace. */
  workspace?: string
  createdAt: number
  lastUsedAt?: number
  useCount?: number
}

export function templatesFile(): string { return join(STATE_HOME, 'templates.json') }

function ensureDir(): void { try { mkdirSync(STATE_HOME, { recursive: true }) } catch { /* exists */ } }

function isTemplate(value: unknown): value is TaskTemplate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaskTemplate>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.request === 'string'
}

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function nameKey(name: string): string { return name.trim().toLowerCase() }

/**
 * Every saved template, oldest first. A missing file, unreadable JSON, or a
 * file that is not a list of templates all read the same way: nothing saved
 * yet. The file itself is never rewritten from this path.
 */
export function loadTemplates(): TaskTemplate[] {
  ensureDir()
  if (!existsSync(templatesFile())) return []
  try {
    const raw = JSON.parse(readFileSync(templatesFile(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(isTemplate)
  } catch { return [] }
}

/** Write the list atomically: temp file in the same directory, then rename. */
function writeTemplates(templates: TaskTemplate[]): void {
  ensureDir()
  const target = templatesFile()
  const temp = `${target}.tmp`
  writeFileSync(temp, JSON.stringify(templates, null, 2), 'utf8')
  try {
    renameSync(temp, target)
  } catch (err) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

/**
 * Save a template. A template with the same name (case-insensitive) is
 * REPLACED, keeping the original id and creation time - a renamed request is
 * the same request, and a second row with the same name would make lookup
 * ambiguous.
 */
export function saveTemplate(
  template: Omit<TaskTemplate, 'id' | 'createdAt'> & Partial<Pick<TaskTemplate, 'id' | 'createdAt'>>,
): TaskTemplate {
  const list = loadTemplates()
  const key = nameKey(template.name)
  const byId = template.id ? list.find(t => t.id === template.id) : undefined
  const byName = list.find(t => nameKey(t.name) === key)
  const target = byId ?? byName
  const now = Date.now()

  const record: TaskTemplate = {
    id: target?.id ?? template.id ?? newId(),
    name: template.name,
    request: template.request,
    createdAt: target?.createdAt ?? template.createdAt ?? now,
  }
  if (template.flags !== undefined) record.flags = template.flags
  else if (target?.flags !== undefined) record.flags = target.flags
  if (template.workspace !== undefined) record.workspace = template.workspace
  else if (target?.workspace !== undefined) record.workspace = target.workspace
  if (template.useCount !== undefined) record.useCount = template.useCount
  else if (target?.useCount !== undefined) record.useCount = target.useCount
  if (template.lastUsedAt !== undefined) record.lastUsedAt = template.lastUsedAt
  else if (target?.lastUsedAt !== undefined) record.lastUsedAt = target.lastUsedAt

  // One template per name: drop the row we are replacing and any other row
  // that answers to the same name.
  const kept = list.filter(t => t.id !== record.id && nameKey(t.name) !== key)
  kept.push(record)
  writeTemplates(kept)
  return record
}

/** Patch a saved template. Returns null when no template carries that id. */
export function updateTemplate(
  id: string,
  patch: Partial<Omit<TaskTemplate, 'id' | 'createdAt'>>,
): TaskTemplate | null {
  const list = loadTemplates()
  const index = list.findIndex(t => t.id === id)
  if (index < 0) return null
  const current = list[index]
  const next: TaskTemplate = { ...current }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.request !== undefined) next.request = patch.request
  if (patch.flags !== undefined) next.flags = patch.flags
  if (patch.workspace !== undefined) next.workspace = patch.workspace
  if (patch.lastUsedAt !== undefined) next.lastUsedAt = patch.lastUsedAt
  if (patch.useCount !== undefined) next.useCount = patch.useCount
  list[index] = next
  writeTemplates(list)
  return next
}

/** Remove a template. False when the id was not saved. */
export function deleteTemplate(id: string): boolean {
  const list = loadTemplates()
  const kept = list.filter(t => t.id !== id)
  if (kept.length === list.length) return false
  writeTemplates(kept)
  return true
}

/** Count a replay: bump the use counter and stamp the last replay time. */
export function markTemplateUsed(id: string): void {
  const list = loadTemplates()
  const index = list.findIndex(t => t.id === id)
  if (index < 0) return
  const current = list[index]
  list[index] = {
    ...current,
    useCount: (current.useCount ?? 0) + 1,
    lastUsedAt: Date.now(),
  }
  writeTemplates(list)
}

/** Find a template by exact id, or by case-insensitive exact name. */
export function findTemplate(nameOrId: string): TaskTemplate | null {
  const list = loadTemplates()
  const byId = list.find(t => t.id === nameOrId)
  if (byId) return byId
  const key = nameKey(nameOrId)
  return list.find(t => nameKey(t.name) === key) ?? null
}

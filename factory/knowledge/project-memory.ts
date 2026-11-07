/**
 * Project memory - what the factory already learned about THIS workspace.
 *
 * Every other knowledge adapter in this folder is static doctrine: the same
 * card for every workspace, every run. Project memory is the opposite - it
 * holds the persisted facts of a single workspace (the test command that
 * works here, the lint command, the files a change must touch) so a later
 * run starts from what the earlier runs learned instead of re-deriving it.
 *
 * Stored per workspace under `~/.wednesday/state/project-memory/<hash>/memory.json`,
 * where <hash> is a sha1 of the resolved workspace path. A raw path never
 * becomes a filename: Windows paths contain `:` and `\`, and a workspace name
 * may contain anything at all.
 *
 * Reads are forgiving (a corrupt file reads as "nothing learned yet", and the
 * bytes are left alone). Writes are atomic (temp file, then rename), so a
 * crash mid-write cannot truncate what the factory learned.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { STATE_HOME } from '../paths'
import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export interface ProjectFact { key: string; value: string; updatedAt: number }

export interface ProjectMemory { workspace: string; facts: ProjectFact[]; updatedAt: number }

export const PROJECT_MEMORY_SKILL_NAME = 'project:memory'

/** Hard cap on facts per workspace - the oldest are dropped first. */
const MAX_FACTS = 50

/** Default cap for the rendered block. */
const DEFAULT_MAX_CHARS = 4000

/** Short marker used when even the header plus a note will not fit. */
const TRUNCATION_NOTE = '[truncated]'
const SHORT_TRUNCATION_NOTE = '[cut]'
const TINY_TRUNCATION_NOTE = '...'

const MEMORY_HEADER = 'PROJECT MEMORY (this workspace):'
const EMPTY_MEMORY_LINE = 'PROJECT MEMORY: none yet'

export function memoryDir(): string { return join(STATE_HOME, 'project-memory') }

/** The memory file for a workspace, under a hashed directory name. */
export function memoryFile(workspace: string): string {
  const hash = createHash('sha1').update(resolve(workspace)).digest('hex')
  return join(memoryDir(), hash, 'memory.json')
}

function ensureDir(dir: string): void { try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ } }

function isFact(value: unknown): value is ProjectFact {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ProjectFact>
  return typeof candidate.key === 'string'
    && typeof candidate.value === 'string'
    && typeof candidate.updatedAt === 'number'
}

/**
 * Everything known about a workspace. A workspace with no memory - or with a
 * corrupt memory file - reads as empty. The corrupt file is left on disk so
 * an operator can still recover it by hand.
 */
export function loadProjectMemory(workspace: string): ProjectMemory {
  const resolved = resolve(workspace)
  const file = memoryFile(resolved)
  if (!existsSync(file)) return { workspace: resolved, facts: [], updatedAt: 0 }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { workspace: resolved, facts: [], updatedAt: 0 }
    }
    const facts = Array.isArray(raw.facts) ? raw.facts.filter(isFact) : []
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    return { workspace: resolved, facts, updatedAt }
  } catch {
    return { workspace: resolved, facts: [], updatedAt: 0 }
  }
}

/** Write the memory atomically: temp file in the same directory, then rename. */
function writeProjectMemory(memory: ProjectMemory): void {
  const file = memoryFile(memory.workspace)
  ensureDir(dirname(file))
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(memory, null, 2), 'utf8')
  try {
    renameSync(temp, file)
  } catch (err) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

/**
 * Remember one fact about a workspace. The key is matched case-insensitively,
 * so "Test Command" and "test command" are the same fact - the newer value
 * replaces the old one. At most 50 facts are kept; the oldest go first.
 */
export function rememberFact(workspace: string, key: string, value: string): ProjectMemory {
  const memory = loadProjectMemory(workspace)
  const now = Date.now()
  const normalized = key.trim().toLowerCase()
  const existing = memory.facts.find(f => f.key.trim().toLowerCase() === normalized)
  if (existing) {
    existing.value = value
    existing.updatedAt = now
  } else {
    memory.facts.push({ key, value, updatedAt: now })
  }
  memory.updatedAt = now

  if (memory.facts.length > MAX_FACTS) {
    const byAge = memory.facts
      .map((fact, index) => ({ index, updatedAt: fact.updatedAt }))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.index - b.index)
    const dropped = new Set(
      byAge.slice(0, memory.facts.length - MAX_FACTS).map(entry => entry.index),
    )
    memory.facts = memory.facts.filter((_, index) => !dropped.has(index))
  }

  writeProjectMemory(memory)
  return memory
}

/** Forget one fact. False when the workspace never carried that key. */
export function forgetFact(workspace: string, key: string): boolean {
  const memory = loadProjectMemory(workspace)
  const normalized = key.trim().toLowerCase()
  const kept = memory.facts.filter(f => f.key.trim().toLowerCase() !== normalized)
  if (kept.length === memory.facts.length) return false
  memory.facts = kept
  memory.updatedAt = Date.now()
  writeProjectMemory(memory)
  return true
}

/**
 * The shortest honest "something was cut" marker that fits `maxChars`.
 * A cap of 5 characters cannot spell "truncated", so it says "cut" instead.
 */
function markerFor(maxChars: number): string {
  if (TRUNCATION_NOTE.length <= maxChars) return TRUNCATION_NOTE
  if (SHORT_TRUNCATION_NOTE.length <= maxChars) return SHORT_TRUNCATION_NOTE
  if (TINY_TRUNCATION_NOTE.length <= maxChars) return TINY_TRUNCATION_NOTE
  return '.'.repeat(Math.max(0, maxChars))
}

/**
 * Hard cap: keep the text within `maxChars` and say so when it does not fit.
 * The cap is mechanical - no model in the loop, no judgment.
 */
function capText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const marker = markerFor(maxChars)
  const room = maxChars - marker.length - 1
  if (room < 0) return marker
  return `${text.slice(0, room).trimEnd()}\n${marker}`
}

/**
 * The memory as a compact block the factory can inject:
 *
 *   PROJECT MEMORY (this workspace):
 *   - test command: npm test
 *   - lint: npm run lint
 *
 * Deterministic, never longer than `maxChars`, and it says so when it had to
 * cut. The newest facts survive a cut; the oldest go first.
 */
export function renderProjectMemory(workspace: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const memory = loadProjectMemory(workspace)
  if (memory.facts.length === 0) return capText(EMPTY_MEMORY_LINE, maxChars)

  const lines = memory.facts.map(fact => `- ${fact.key}: ${fact.value}`)
  const full = [MEMORY_HEADER, ...lines].join('\n')
  if (full.length <= maxChars) return full

  // Keep the newest facts, print them in stored order.
  const newestFirst = memory.facts
    .map((fact, index) => ({ index, updatedAt: fact.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.index - b.index)
    .map(entry => entry.index)

  for (let keptCount = lines.length - 1; keptCount >= 0; keptCount--) {
    const dropped = lines.length - keptCount
    const keptIndexes = new Set(newestFirst.slice(0, keptCount))
    const keptLines = lines.filter((_, index) => keptIndexes.has(index))
    const note = `[truncated ${dropped} ${dropped === 1 ? 'fact' : 'facts'}]`
    const candidate = [MEMORY_HEADER, ...keptLines, note].join('\n')
    if (candidate.length <= maxChars) return candidate
  }

  // Even the header plus a note does not fit. Keep the promise first (say
  // that something was cut), keep the cap second: a shorter header, then the
  // bare marker, then the marker itself cut to the cap.
  const marker = markerFor(maxChars)
  const withShortNote = [MEMORY_HEADER, marker].join('\n')
  if (withShortNote.length <= maxChars) return withShortNote
  const withShorterHeader = ['PROJECT MEMORY:', marker].join('\n')
  if (withShorterHeader.length <= maxChars) return withShorterHeader
  return marker
}

/**
 * The adapter shape every knowledge source in this folder uses: one
 * selectable card, and a load that returns the rendered content.
 */
export class ProjectMemoryAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: PROJECT_MEMORY_SKILL_NAME,
        description:
          'What the factory already learned about this workspace: test command, lint command, required files, and other persisted project facts.',
        whenToUse:
          'when planning, building, or verifying in this workspace, so the factory reuses what it already learned about this workspace instead of re-deriving it',
        invocation: { modelInvocable: true },
      },
    ]
  }

  /**
   * The memory for the workspace the CALLER is working in.
   *
   * The workspace argument is honoured (2026-11-05): the adapter used to
   * render `process.cwd()` and ignore the query's workspace, so a run in a
   * different directory was told the facts of wherever the process happened
   * to be started. A workspace is the unit of memory - that is the whole
   * point of hashing the path into the filename.
   */
  async load(name: string, workspace?: string): Promise<KnowledgeSkill | undefined> {
    if (name !== PROJECT_MEMORY_SKILL_NAME) return undefined
    const target = (workspace ?? process.cwd()).trim() || process.cwd()
    return {
      name: PROJECT_MEMORY_SKILL_NAME,
      description: 'Persisted facts about this workspace.',
      whenToUse: 'when working in this workspace',
      source: 'project-memory',
      provider: 'wednesday',
      content: renderProjectMemory(target, DEFAULT_MAX_CHARS),
    }
  }
}

/**
 * What a finished run taught the factory (pure shape).
 *
 * Only facts that stay true are worth remembering. A run's summary is
 * history; the command that PASSED is a fact about the workspace.
 */
export interface RunOutcomeFacts {
  /** The verification command whose tests passed. */
  testCommand?: string
  /** A one-line description of what was built. */
  summary?: string
}

/**
 * Remember what a run taught (2026-11-05).
 *
 * This is the WRITER that makes the factory compound. The knowledge layer
 * was twenty adapters of STATIC doctrine - the same card for every
 * workspace, every run - so the factory forgot everything between runs and
 * re-derived the same test command every time.
 *
 * Two facts are kept, and only two, because a memory full of stale detail
 * is worse than an empty one:
 *  - `test command`: the command that PASSED here. It is a fact about the
 *    workspace, and it saves the next run from guessing (or from failing on
 *    a guess like `npm test` in a repo with no test script).
 *  - `last build`: a trimmed summary of the last thing built, so the next
 *    run knows what state the workspace is in.
 *
 * A failed run teaches nothing here: the command that failed is not the
 * command that works, and remembering it would poison the next run.
 */
export function rememberRunOutcome(
  workspace: string,
  facts: RunOutcomeFacts,
): ProjectMemory {
  let memory = loadProjectMemory(workspace)
  const command = (facts.testCommand ?? '').trim()
  if (command) {
    memory = rememberFact(workspace, 'test command', command)
  }
  const summary = (facts.summary ?? '').replace(/\s+/g, ' ').trim()
  if (summary) {
    memory = rememberFact(
      workspace,
      'last build',
      summary.length > 200 ? `${summary.slice(0, 197)}...` : summary,
    )
  }
  return memory
}

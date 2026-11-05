/**
 * Session store (2026-10-25): the transcript that makes Hermes' exit card true.
 *
 * Hermes ends a session with `Resume this session with: hermes --resume <id>`.
 * Wednesday had no such store, so copying the card verbatim would have printed
 * a command that does not exist — a lie in the last line of the product. This
 * is the smallest honest version: the visible transcript plus the few facts the
 * card needs, one JSON file per session under the state dir (never the repo).
 *
 * Deliberately NOT a conversation database: no history search, no titles, no
 * tool-call replay. It exists so `/exit` can hand the operator a way back to
 * what was on screen, which is exactly what the card promises.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME } from '../paths'
import type { ScreenMessage } from './screen'

export interface StoredSession {
  id: string
  /** Wall clock of the sitting that saved it (the exit card's Duration). */
  startedAt: number
  savedAt: number
  composerLabel: string | null
  crewLabel?: string
  tokens: number
  messages: ScreenMessage[]
}

export function sessionsDir(): string {
  return join(STATE_HOME, 'sessions')
}

/** A session id is a filename; anything else is refused, not sanitised. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

export function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

/** Write the session atomically enough for a goodbye (one small file). */
export function saveSession(session: StoredSession): string | null {
  if (!safeId(session.id)) return null
  const path = sessionPath(session.id)
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...session, savedAt: Date.now() }), 'utf8')
    return path
  } catch {
    // A failed save must never break the exit path; the card then simply says
    // goodbye instead of offering a resume that would not work.
    return null
  }
}

export function loadSession(id: string): StoredSession | null {
  if (!safeId(id)) return null
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(id), 'utf8')) as StoredSession
    if (parsed?.id !== id || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

/** Newest saved session, for a bare `--resume`. */
export function latestSession(): StoredSession | null {
  try {
    const files = readdirSync(sessionsDir())
      .filter(name => name.endsWith('.json'))
      .map(name => ({ name, at: statSync(join(sessionsDir(), name)).mtimeMs }))
      // Two saves in the same millisecond (a test, or a fast restart) tie on
      // mtime; session ids are timestamp-prefixed, so the name breaks the tie
      // in the same direction.
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    const newest = files[0]
    return newest ? loadSession(newest.name.slice(0, -5)) : null
  } catch {
    return null
  }
}

/** `2m 14s` / `1h 2m 3s` / `14s` — Hermes' exit-card duration grammar. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export interface ExitCardFacts {
  id: string
  durationMs: number
  messages: ScreenMessage[]
}

/**
 * The goodbye screen, as plain lines (no colour: it prints after the alternate
 * screen is gone). Empty sessions get Hermes' one-line goodbye; a used session
 * gets the resume block and the four facts.
 */
export function exitCard(facts: ExitCardFacts): string[] {
  if (facts.messages.length === 0) return ['Goodbye! ✦']
  const requests = facts.messages.filter(m => m.text.startsWith('❯ ')).length
  // Only `tool.called` rows are tool calls; the other `┊` rows are stage
  // events, and counting them would inflate the number the card reports.
  const tools = facts.messages.filter(m => m.text.startsWith('┊') && / tool\s+called/.test(m.text)).length
  const count = facts.messages.length
  const label = (name: string): string => `${`${name}:`.padEnd(16)}`
  return [
    'Resume this session with:',
    `  wednesday --repl --resume ${facts.id}`,
    '',
    label('Session') + facts.id,
    label('Duration') + formatDuration(facts.durationMs),
    label('Messages') + `${count} (${requests} request${requests === 1 ? '' : 's'}, ${tools} tool call${tools === 1 ? '' : 's'})`,
  ]
}

/**
 * Shaped views for the inspection commands.
 *
 * Reported as "when you run command /task then so big long response": `/tasks`
 * printed `id status objective` as one long line per task, so a long objective
 * wrapped across three rows with nothing to scan, and `/result` printed the raw
 * stored record — 40 lines of JSON where the operator wanted four facts and a
 * way to the rest.
 *
 * These are pure functions (no TTY, no state) for two reasons: the screen path
 * and the classic path must not disagree about what a task looks like, and a
 * view that cannot be rendered in a test is a view nobody checked. Width is a
 * parameter, never `stdout.columns`, so the tests can pin it.
 *
 * The raw record is still one keystroke away (`--raw`), because a JSON dump is
 * the right answer for a pipe and the wrong answer for a person.
 */
import type { MsgTone } from './screen'

export interface TaskRow {
  id: string
  status: string
  objective: string
  /** Result summary, when the task has one. */
  summary?: string
  filesChanged?: string[]
  testsFailed?: number
  testsPassed?: number
  updatedAt?: string
}

/** One styled line of a view. */
export interface ViewLine {
  text: string
  tone: MsgTone
}

/** Status → tone. Blood for failure, sage for done, amber for waiting. */
export function statusTone(status: string): MsgTone {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'done' || s === 'passed') return 'green'
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'red'
  if (s === 'queued' || s === 'running' || s === 'pending' || s === 'repairing') return 'yellow'
  return 'dim'
}

/**
 * Shorten an id for display without losing its identity: `harness-aaaa1111…`
 * The full id stays one `/result <id>` away, and the visible prefix is enough to
 * tell two runs apart at a glance.
 */
export function shortId(id: string, width = 20): string {
  if (id.length <= width) return id
  const head = id.slice(0, width - 1)
  return `${head}…`
}

/**
 * A stream line the operator can actually read.
 *
 * Provider failures reach this layer as text, and some arrive with the
 * upstream's body attached: a Cloudflare 5xx page is a full HTML document, and
 * a failed free-model call printed one into the stream, burying the single
 * line that said what went wrong under a page of markup (reported from a
 * screenshot). Any text that is plainly an HTML document becomes one line
 * that says so — the raw text stays in the task record, `/result <id>`. Lines
 * are otherwise kept as they are, except that a runaway single line is clipped
 * so it cannot own the whole frame.
 */
export function streamLine(text: string, max = 400): string {
  const trimmed = text.trim()
  if (/<!doctype\s+html|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]/i.test(trimmed)) {
    const title = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i
      .exec(trimmed)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    return `upstream sent an HTML page, not a model reply${title ? ` ("${title}")` : ''} — raw text: /result`
  }
  return trimmed
    .split('\n')
    .map(line => (line.length > max ? `${line.slice(0, max - 1)}…` : line))
    .join('\n')
}

/**
 * The task list. A fixed status column, a fixed id column, and the objective
 * taking whatever is left — so the eye scans a column instead of reading prose.
 * Wraps onto continuation rows rather than clipping, because a clipped objective
 * is how two runs get confused.
 */
export function taskListLines(tasks: TaskRow[], width: number): ViewLine[] {
  if (tasks.length === 0) return [{ text: 'No tasks yet.', tone: 'dim' }]
  const gap = 2
  const statusWidth = Math.max(...tasks.map(t => t.status.length), 6)
  // The id column is bounded by what is LEFT after the status and the objective
  // minimum. Before this it was `min(24, max(id lengths))`, so on a 40-column
  // terminal the fixed columns consumed the whole row and the header alone was
  // 42 characters — wider than the terminal it was drawn for.
  const objectiveMin = 16
  const idBudget = Math.max(8, width - statusWidth - gap * 2 - objectiveMin - 2)
  const idWidth = Math.min(24, idBudget, Math.max(...tasks.map(t => shortId(t.id).length), 8))
  const objectiveWidth = Math.max(12, width - statusWidth - idWidth - gap * 2 - 2)
  const rows: ViewLine[] = []
  rows.push({
    text: `${'status'.padEnd(statusWidth)}${' '.repeat(gap)}${'id'.padEnd(idWidth)}${' '.repeat(gap)}objective`.slice(0, width),
    tone: 'dim',
  })
  const newestFirst = [...tasks].reverse()
  for (const task of newestFirst) {
    const head = `${task.status.padEnd(statusWidth)}  ${shortId(task.id, idWidth).padEnd(idWidth)}  `
    const lines = wrapText(task.objective, objectiveWidth)
    rows.push({ text: head + lines[0]!, tone: statusTone(task.status) })
    for (const extra of lines.slice(1)) rows.push({ text: ' '.repeat(head.length) + extra, tone: 'dim' })
    // One dim line of outcome beats making the operator open the task to learn
    // whether it passed: the list is where you decide what to look at next.
    if (task.summary) {
      for (const part of wrapText(`↳ ${task.summary}`, objectiveWidth)) {
        rows.push({ text: ' '.repeat(head.length) + part, tone: 'dim' })
      }
    }
  }
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  const tally = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(' · ')
  // The footer is the one row a narrow terminal must still be able to show, so
  // it drops the pointer to the widest form that fits rather than wrapping.
  const footers = [
    `${tasks.length} task${tasks.length === 1 ? '' : 's'} (${tally}) · /result <id> for one`,
    `${tasks.length} task${tasks.length === 1 ? '' : 's'} (${tally})`,
    `${tasks.length} (${tally})`,
    String(tasks.length),
  ]
  rows.push({ text: footers.find(line => line.length <= width) ?? '', tone: 'dim' })
  return rows
}

/**
 * One task, shaped: identity, what it was asked to do, what came of it, and the
 * next action. `--raw` still prints the stored record for pipes.
 */
export function taskDetailLines(
  record: {
    id: string
    status: string
    engineeringTask: {
      objective: string
      workspace: string
      role?: string
      stack?: string
      verification?: { testCommands?: string[] }
      acceptance?: { requiredFiles?: string[] }
    }
    result?: {
      summary?: string
      filesChanged?: string[]
      tests?: Array<{ command: string; passed: boolean }>
      acceptanceChecks?: Array<{ criterion: string; passed: boolean }>
      diagnostics?: string
    }
  },
  width: number,
): ViewLine[] {
  const labelWidth = 11
  const valueWidth = Math.max(16, width - labelWidth - 3)
  const field = (label: string, value: string, tone: MsgTone = 'plain'): ViewLine[] => {
    const parts = wrapText(value, valueWidth)
    const rows = [{ text: `${label.padEnd(labelWidth)}  ${parts[0] ?? ''}`, tone }]
    for (const part of parts.slice(1)) rows.push({ text: `${' '.repeat(labelWidth)}  ${part}`, tone: 'dim' })
    return rows
  }
  const rows: ViewLine[] = []
  rows.push({ text: `${record.status}`, tone: statusTone(record.status) })
  rows.push(...field('id', record.id, 'dim'))
  rows.push({ text: '', tone: 'plain' })
  rows.push(...field('objective', record.engineeringTask.objective))
  rows.push(...field('workspace', record.engineeringTask.workspace))
  if (record.engineeringTask.role || record.engineeringTask.stack) {
    rows.push(...field('shape', [record.engineeringTask.role, record.engineeringTask.stack].filter(Boolean).join(' · ')))
  }
  const required = record.engineeringTask.acceptance?.requiredFiles ?? []
  if (required.length) rows.push(...field('must touch', required.join(', '), 'yellow'))
  const tests = record.engineeringTask.verification?.testCommands ?? []
  if (tests.length) rows.push(...field('verify with', tests.join(' · ')))
  if (record.result) {
    rows.push({ text: '', tone: 'plain' })
    if (record.result.summary) rows.push(...field('result', record.result.summary))
    const changed = record.result.filesChanged ?? []
    if (changed.length) {
      rows.push(...field('files', changed.join(', '), 'cyan'))
    }
    for (const test of record.result.tests ?? []) {
      rows.push({ text: `${test.passed ? '✔' : '✘'} ${test.command}`, tone: test.passed ? 'green' : 'red' })
    }
    for (const check of record.result.acceptanceChecks ?? []) {
      rows.push({ text: `${check.passed ? '✔' : '✘'} ${check.criterion}`, tone: check.passed ? 'green' : 'red' })
    }
    if (record.result.diagnostics) rows.push(...field('diagnostics', record.result.diagnostics, 'dim'))
  }
  rows.push({ text: '', tone: 'plain' })
  // The next action, widest form that fits. A wrapped hint is noise: the widest
  // form names the command the operator needs, and a narrow terminal gets the
  // shorter one rather than a hint broken across two rows.
  const runHint = record.status === 'completed'
    ? ['/run <id> to run again · /events <id> for the trail', '/run <id> again · /events <id>', '/run <id>']
    : ['/run <id> to preview and approve · /events <id> for the trail', '/run <id> to approve · /events <id>', '/run <id>']
  rows.push({ text: runHint.find(line => line.length <= width) ?? '/run <id>', tone: 'dim' })
  rows.push({ text: 'add --raw for the stored record (JSON)'.slice(0, width), tone: 'dim' })
  return rows
}

/**
 * The event trail for one task, newest last, as a readable timeline.
 *
 * `--raw` still gives the stored events. This is the shape a person reads while
 * asking "what happened?": one line per event, the role that did it, and the
 * payload summary where there is one. An unknown event type is printed as
 * itself rather than dropped, because hiding an event type is how a bug becomes
 * invisible.
 */
export function eventTrailLines(
  events: Array<{ type: string; role?: string; payload?: Record<string, unknown>; at?: string }>,
  width: number,
): ViewLine[] {
  if (events.length === 0) return [{ text: 'No events recorded for this task.', tone: 'dim' }]
  const rows: ViewLine[] = []
  // The mark is driven by OUTCOME, not by event name: `test.completed` is not
  // a success until its payload says it passed, and marking it ✔ from the name
  // alone is how a red run gets a green tick in the trail.
  const mark = (event: { type: string; payload?: Record<string, unknown> }): string => {
    const passed = event.payload?.passed
    if (typeof passed === 'boolean') return passed ? '✔' : '✘'
    if (event.type.endsWith('.failed') || event.type.endsWith('.error')) return '✘'
    if (event.type.endsWith('.completed')) return '✔'
    if (event.type.endsWith('.started')) return '▸'
    if (event.type.includes('repair')) return '↻'
    return '·'
  }
  // Tone follows the same outcome rule as the mark.
  const toneFor = (event: { type: string; payload?: Record<string, unknown> }): MsgTone => {
    const passed = event.payload?.passed
    if (typeof passed === 'boolean') return passed ? 'green' : 'red'
    if (event.type.endsWith('.failed') || event.type.endsWith('.error')) return 'red'
    if (event.type.includes('repair')) return 'yellow'
    if (event.type.endsWith('.completed')) return 'green'
    return 'plain'
  }
  for (const event of events) {
    const head = `${mark(event)} ${event.type}`
    const detail = eventSummary(event.payload)
    const parts = wrapText([head, detail].filter(Boolean).join('  '), Math.max(16, width))
    rows.push({ text: parts[0]!, tone: toneFor(event) })
    for (const part of parts.slice(1)) rows.push({ text: `  ${part}`, tone: 'dim' })
  }
  const trail = [
    `${events.length} events · newest last · --raw for the stored records`,
    `${events.length} events · newest last`,
    `${events.length} events`,
  ]
  rows.push({ text: trail.find(line => line.length <= width) ?? `${events.length} events`, tone: 'dim' })
  return rows
}

/** Best-effort one-line summary of an event payload. */
function eventSummary(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ''
  const parts: string[] = []
  for (const key of ['command', 'file', 'path', 'summary', 'reason', 'error', 'message']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) { parts.push(value.trim()); break }
  }
  const passed = payload.passed
  if (typeof passed === 'boolean') parts.push(passed ? 'passed' : 'failed')
  const count = payload.count ?? payload.filesChanged
  if (Array.isArray(count) && count.length) parts.push(`${count.length} item${count.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** Greedy word wrap. Exported because the tests assert on it directly. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { out.push(''); continue }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word; continue }
      if (line.length + 1 + word.length <= w) { line += ` ${word}`; continue }
      out.push(line)
      line = word
    }
    if (line) out.push(line)
  }
  // A single word longer than the width (a path, an id) is hard-split rather
  // than left to overflow the frame. Done as its own pass so the word-wrapping
  // loop above stays readable, and so a split row is a whole row — never a
  // continuation the caller has to re-align.
  for (let i = 0; i < out.length; i++) {
    let row = out[i]!
    if (row.length <= w) continue
    const pieces: string[] = []
    while (row.length > w) { pieces.push(row.slice(0, w)); row = row.slice(w) }
    if (row) pieces.push(row)
    out.splice(i, 1, ...pieces)
    i += pieces.length - 1
  }
  return out.length ? out : ['']
}

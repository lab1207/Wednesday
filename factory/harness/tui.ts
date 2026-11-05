import { stdin, stdout } from 'node:process'
import type { EngineeringTask } from '../contracts'
import { THEME } from './theme'
import { MARKS, mark, markFor } from './marks'
import { wrap, visibleWidth } from './screen'
import type { MsgTone } from './screen'

/**
 * B1b stdlib TUI helpers — readline + ANSI only, zero new dependencies.
 * Every helper degrades to plain text when not on a TTY, so piped
 * one-shot runs (and the harness/repl tests) see unchanged output.
 */

export function isTty(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

function paint(code: string, text: string): string {
  return isTty() ? `\x1b[${code}m${text}\x1b[0m` : text
}

/** Brand-toned paint for the classic (non-screen) output path. */
function brand(code: number, text: string, bold = false): string {
  return isTty() ? `\x1b[${bold ? '1;' : ''}38;5;${code}m${text}\x1b[0m` : text
}

export function banner(): string {
  const crest = isTty() ? `\x1b[38;5;${THEME.accent}m❦\x1b[0m ` : ''
  return `${crest}${brand(THEME.fg, 'Wednesday', true)} — interactive mode. Type /help for commands.`
}

export function previewTitle(): string {
  return paint('1', 'Wednesday — Task preview')
}

export function rule(): string {
  if (!isTty()) return '---'
  const columns = stdout.columns ?? 0
  const width = columns > 10 && columns < 200 ? columns : 60
  return '─'.repeat(Math.min(width, 80))
}

/**
 * The approval card, for the classic path.
 *
 * Width-aware, and it was not. Every line used to be built by string
 * concatenation and measured by nothing, so an 88-column workspace path became
 * three terminal rows whose continuation lines started at **column 0** - which
 * destroys the label column and leaves a ragged wall. Measured: 4 of 13 rows
 * exceeded 80 columns, the widest by 200.
 *
 * The screen path learned column-awareness in B83; this one never got the same
 * treatment, so `wrap` is now SHARED rather than reimplemented - one
 * implementation, one set of rules about columns and about not splitting a wide
 * glyph.
 *
 * The label column is uniform where it used to be ragged: `Role ` was five wide
 * and `Required files  ` was sixteen, so nothing lined up even before the
 * wrapping. A uniform column is also what gives a wrapped value a hanging indent
 * to align against, which is the entire point of a card.
 */
/** Minimum label column; the real one is measured from the labels in use. */
const LABEL_COL = 14

/** Columns the card may use: the terminal's, within sane bounds. */
function cardWidth(columns?: number): number {
  const raw = columns ?? stdout.columns ?? 80
  if (!Number.isFinite(raw) || raw < 20) return 60
  return Math.max(40, Math.min(Math.floor(raw), 120))
}

/**
 * Pad the label BEFORE styling it, so the padding is part of the styled span and
 * every label occupies the same columns.
 *
 * The alternative - styling a short label and gluing two spaces after it - is
 * what the first attempt did, and it misaligned every short label's wrapped
 * value by exactly the difference. Visible immediately: `Acceptance`'s value
 * began at column 12 while its continuation began at 14.
 */
function head(label: string, labelWidth: number): string {
  return brand(THEME.muted, label.padEnd(labelWidth))
}

/**
 * One labelled field, wrapped so every continuation line sits under the first.
 *
 * The VALUE is wrapped as plain text and styled afterwards: styling first would
 * make `wrap` count the escape sequences as visible columns.
 */
function field(label: string, value: string, width: number, labelWidth: number, paint: (t: string) => string = t => brand(THEME.fg, t)): string[] {
  const parts = wrap(value, Math.max(8, width - labelWidth))
  const hanging = ' '.repeat(labelWidth)
  if (parts.length === 0) return [head(label, labelWidth)]
  return parts.map((part, i) => `${i === 0 ? head(label, labelWidth) : hanging}${paint(part)}`)
}

/**
 * A list item under a section label.
 *
 * Indented a little, not aligned to the value column: bullets belong to the
 * section, not to the value gutter, and a 16-column indent for `· npm test`
 * reads as a mistake.
 */
function bullet(mark: string, text: string, width: number): string[] {
  const indent = '  '
  const parts = wrap(text, Math.max(8, width - indent.length - 2))
  if (parts.length === 0) return [`${indent}${mark}`]
  return parts.map((part, i) => `${indent}${i === 0 ? `${mark} ` : '  '}${part}`)
}

export function taskCard(task: EngineeringTask, columns?: number): string {
  const width = cardWidth(columns)
  const label = (text: string): string => brand(THEME.muted, text)
  const value = (text: string): string => brand(THEME.fg, text)
  const lines: string[] = []
  const push = (...rows: string[][]): void => { for (const row of rows) lines.push(...row) }

  // The label column is MEASURED from the labels this card actually uses, not a
  // constant. `Required files` is fourteen characters, so a fixed fourteen-wide
  // field left no gutter at all and the card printed `Required filessrc/...`.
  const LABELS = ['Objective', 'Workspace', 'Role', 'Stack', 'Acceptance', 'Required files']
  const labelWidth = Math.max(12, Math.max(...LABELS.map(l => l.length)) + 2)

  push(field('Objective', task.objective, width, labelWidth))
  push(field('Workspace', task.workspace, width, labelWidth))
  push(field('Role', task.role, width, labelWidth))
  push(field('Stack', task.stack, width, labelWidth))

  lines.push(label('Constraints'))
  for (const constraint of task.constraints) push(bullet(brand(THEME.amber, '\u00b7'), constraint, width))

  push(field('Acceptance', (task.acceptanceCriteria ?? []).join('; ') || '(none)', width, labelWidth))

  const requiredFiles = task.acceptance?.requiredFiles ?? []
  push(field(
    'Required files',
    requiredFiles.length ? requiredFiles.join(', ') : '(none)',
    width,
    labelWidth,
    requiredFiles.length ? (t => brand(THEME.amber, t)) : label,
  ))

  lines.push(label('Verification'))
  for (const test of task.verification?.testCommands ?? []) push(bullet(brand(THEME.sage, '$'), test, width))

  // Belt and braces: nothing leaves this function wider than the card, whatever
  // the helpers above believed. Cheap, and it makes the invariant unconditional
  // rather than a property each helper has to remember.
  return lines.map(row => (visibleWidth(row) > width ? row.slice(0, width) : row)).join('\n')
}

/**
 * Live event line. Whole-line styling only, so asserted substrings
 * (`task.completed`, ` (coder)`, …) stay contiguous. Non-TTY output is
 * byte-identical to the classic format.
 *
 * Routed through the decode key (`marks.ts`), so classic TTY and the
 * alt-screen agree on every glyph. Same event, one face — previously classic
 * printed generic ✗✓↻…→ while the screen printed ❦✿◉✧❀☠☞.
 */
const TONE_CODE: Record<MsgTone, number> = {
  plain: THEME.fg,
  dim: THEME.muted,
  green: THEME.sage,
  red: THEME.bloodInk,
  yellow: THEME.amber,
  cyan: THEME.accent,
  bold: THEME.fg,
}

export function formatEvent(type: string, role?: string): string {
  const plain = `  ${type}${role ? ` (${role})` : ''}`
  if (!isTty()) return plain
  // tool.called keeps its arrow: Thing reaching for the tool is a motion mark,
  // not a state, and the decode key assigns it no event face.
  if (type === 'tool.called') return brand(THEME.fg, `→ ${plain.trim()}`)
  const named = markFor(type)
  if (!named) return plain
  const entry = MARKS[named]
  return brand(TONE_CODE[entry.tone], `${mark(named)} ${plain.trim()}`, entry.tone === 'bold')
}

/** TTY-only stage separator for a newly starting role; '' elsewhere. */
export function stageHeader(role: string): string {
  if (!isTty()) return ''
  return `\x1b[38;5;${THEME.accent}m┃\x1b[0m ${brand(THEME.accent, role, true)}`
}

/** Whole-line pass/fail styling; text untouched so `test PASS` keeps matching. */
export function statusLine(text: string, ok: boolean | null): string {
  if (!isTty() || ok === null) return text
  return brand(ok ? THEME.sage : THEME.bloodInk, text)
}

/**
 * `/help` as Hermes prints it (2026-10-25).
 *
 * The plate was Wednesday's own grammar: a floating box over the session with
 * two columns. Hermes answers `/help` with a transcript — a `+---+` header,
 * `── Category ──` sections, `    /cmd  - desc` rows, and a tip block — so a
 * side-by-side comparison showed two different products at the most-used
 * command. This module is that transcript, pure over its inputs: the harness
 * owns which commands exist, this owns how they read.
 *
 * Width is a parameter, never `stdout.columns`, so the fit rules are testable
 * and a 40-column terminal gets a 40-column page instead of a clipped 96.
 */
import type { MsgTone } from './screen'

export interface HelpGroup {
  title: string
  /** Command names in display order; each must exist in `commands`. */
  names: string[]
}

export interface HelpRow {
  text: string
  tone: MsgTone
}

/**
 * A HUD heading in plain characters: star, caps, rail to the edge.
 *
 * No ANSI on purpose — this module feeds `--classic` and the piped path too,
 * where a colour code is garbage in a log. The screen path adds the tone.
 */
function plate(title: string, width: number): string {
  const label = `✦ ${title.toUpperCase()}`
  return `${label} ${'─'.repeat(Math.max(0, width - label.length - 1))}`
}

/** Clip to `room` display columns, marking the cut — never silent truncation. */
function fit(text: string, room: number): string {
  if (text.length <= room) return text
  return `${text.slice(0, Math.max(1, room - 1))}…`
}

export function renderHelp(
  width: number,
  commands: Array<[string, string]>,
  groups: HelpGroup[],
  flags: Array<[string, string]>,
  query = '',
): HelpRow[] {
  const w = Math.max(20, width)
  const q = query.trim().toLowerCase()
  const describe = new Map(commands)
  const matches = ([name, desc]: [string, string]): boolean =>
    !q || name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)

  const rows: HelpRow[] = []
  rows.push({ text: '', tone: 'plain' })

  // The HUD plate, full width: the `+---+` box was Hermes' transcript grammar
  // and read as a second window inside the pager. Star, caps, rail — the same
  // heading the home panel uses. Clamped by `w`, so a 24-column console gets a
  // short honest rule instead of a wrapped box.
  rows.push({ text: plate('Available Commands', w), tone: 'cyan' })

  // The command column is one width for the whole page, like Hermes' 15 — a
  // per-row width turns the reference into a ragged poem.
  const longest = Math.max(8, ...commands.map(([name]) => name.length), ...flags.map(([name]) => name.length))
  const cmdW = Math.min(18, longest + 1)
  const descRoom = Math.max(1, w - 4 - cmdW - 2)
  let printed = 0
  const listed = new Set(groups.flatMap(group => group.names))
  for (const group of groups) {
    const rowsOf = group.names
      .map(name => [name, describe.get(name) ?? ''] as [string, string])
      .filter(([name]) => describe.has(name))
      .filter(matches)
    if (rowsOf.length === 0) continue
    rows.push({ text: '', tone: 'plain' })
    rows.push({ text: `  ${plate(group.title, w - 2)}`, tone: 'cyan' })
    for (const [name, desc] of rowsOf) {
      rows.push({ text: `    ${name.padEnd(cmdW)}- ${fit(desc, descRoom)}`, tone: 'plain' })
      printed++
    }
  }

  // Anything the groups did not name still prints: a command advertised in the
  // palette but missing from /help is the bug the design board flagged, and a
  // hand-maintained grouping is exactly how that happens.
  const extra = commands
    .filter(([name]) => name.startsWith('/') && !listed.has(name))
    .filter(matches)
  if (extra.length > 0) {
    rows.push({ text: '', tone: 'plain' })
    rows.push({ text: `  ${plate('More', w - 2)}`, tone: 'cyan' })
    for (const [name, desc] of extra) {
      rows.push({ text: `    ${name.padEnd(cmdW)}- ${fit(desc, descRoom)}`, tone: 'plain' })
      printed++
    }
  }

  // Flags answer a different question than commands, so they get their own
  // section rather than being buried in the command list.
  const flagRows = flags.filter(matches)
  if (flagRows.length > 0) {
    rows.push({ text: '', tone: 'plain' })
    rows.push({ text: `  ${plate('Flags', w - 2)}`, tone: 'cyan' })
    for (const [name, desc] of flagRows) {
      rows.push({ text: `    ${name.padEnd(cmdW)}- ${fit(desc, descRoom)}`, tone: 'plain' })
      printed++
    }
  }

  if (printed === 0) {
    rows.push({ text: '', tone: 'plain' })
    rows.push({ text: fit(`  No command matches "${query.trim()}".`, w), tone: 'dim' })
  } else if (!q) {
    // Hermes' `Skill Commands: N installed` pointer, for the thing Wednesday
    // actually has: the optional flags that make a request exact.
    rows.push({ text: '', tone: 'plain' })
    rows.push({ text: fit(`  ✦ Request flags: ${flags.map(([name]) => name).join(' · ')}`, w), tone: 'dim' })
  }

  // The tip block is four dim lines in Hermes; each one here names a binding
  // the composer really has, so the page never teaches a key that does nothing.
  // Every line is clipped to the caller's width: a 24-column terminal gets a
  // short honest page, not a wrapped one.
  rows.push({ text: '', tone: 'plain' })
  if (q) {
    rows.push({ text: fit(`  Filtered by "${query.trim()}" — /help for the full list`, w), tone: 'dim' })
  } else {
    rows.push({ text: fit('  Tip: /help <text> filters · Ctrl+P opens the command palette', w), tone: 'dim' })
  }
  rows.push({ text: fit('  Multi-line: Ctrl+J or Shift+Enter inserts a new line', w), tone: 'dim' })
  rows.push({ text: fit('  Approval: 1 runs once, 2 denies — nothing writes before you choose', w), tone: 'dim' })
  return rows
}

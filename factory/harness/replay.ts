/**
 * A very small terminal emulator, used to inspect what the harness actually put
 * on screen.
 *
 * Repaints in this app are INCREMENTAL: only changed rows reach the terminal, so
 * the byte stream is a patch, not a frame. "What is on screen" is the
 * accumulation of every write ever made, and the only honest way to assert
 * against it is to replay the stream through something that behaves like a
 * terminal.
 *
 * Two details decide whether this is worth anything at all, and both were wrong
 * in the first version:
 *
 * 1. **Pending wrap.** Writing the last column of a row does not move the
 *    cursor; it sets a pending wrap. The next printable character wraps; a
 *    control character - the `\n` that joins the frame's rows - just moves down.
 *    Advancing eagerly skips a row after every full-width row and desyncs the
 *    whole grid, which reports a CORRECT renderer as broken.
 *
 * 2. **`CSI J` erases from the CURSOR**, not the whole row. Clearing whole rows
 *    deletes the status line from the bottom of every frame.
 *
 * So this module is itself checked, in `perf-test.ts` case 0, by replaying a
 * plain frame write and comparing the result with `Screen.painted()`. An oracle
 * that is not itself verified is just a second opinion.
 */

import { columnOf } from './screen.js'

/** Replay a written byte stream into a grid of character cells. */
export function replay(text: string | string[], w: number, h: number): string[][] {
  const grid: string[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ' '))
  const source = typeof text === 'string' ? text : text.join('')
  let row = 0
  let col = 0
  let pendingWrap = false
  let i = 0
  while (i < source.length) {
    if (source[i] === '\x1b' && source[i + 1] === '[') {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(source.slice(i))
      if (!m) { i += 1; continue }
      if (m[2] === 'H') {
        const [r, c] = (m[1] ?? '').split(';')
        row = Math.max(1, Number(r || 1)) - 1
        col = Math.max(1, Number(c || 1)) - 1
        pendingWrap = false
      } else if (m[2] === 'K') {
        // Erase in line, from the cursor: mode 0 cursor→end, 1 start→cursor,
        // 2 the whole row. The app writes explicit blanks, but a CONSOLE HOST
        // (ConPTY) emits `EraseLine` when it clears trailing text. Ignoring K
        // made the replayed grid keep text a real terminal had already erased,
        // which turns a correct repaint into a phantom "stuck" row.
        const mode = m[1] ?? '0'
        if (mode === '2') grid[row] = Array.from({ length: w }, () => ' ')
        else if (mode === '1') for (let c = 0; c <= Math.min(col, w - 1); c++) grid[row]![c] = ' '
        else for (let c = Math.max(0, col); c < w; c++) grid[row]![c] = ' '
      } else if (m[2] === 'X') {
        // Erase N characters at the cursor (ECH) — the same host behaviour for
        // an overwrite that shrinks, expressed without moving the cursor.
        const n = Math.max(1, Number(m[1] || 1))
        for (let c = col; c < Math.min(w, col + n); c++) grid[row]![c] = ' '
      } else if (m[2] === 'J') {
        const mode = m[1] ?? '0'
        if (mode === '2') {
          for (let r = 0; r < h; r++) grid[r] = Array.from({ length: w }, () => ' ')
        } else {
          for (let c = col; c < w; c++) grid[row]![c] = ' '
          for (let r = row + 1; r < h; r++) grid[r] = Array.from({ length: w }, () => ' ')
        }
      }
      // Private modes are deliberately inert: they change terminal state, not
      // cells. `K`/`X` above are honoured because a console host uses them.
      i += m[0].length
      continue
    }
    if (source[i] === '\n') { pendingWrap = false; row = Math.min(h - 1, row + 1); col = 0; i += 1; continue }
    if (source[i] === '\r') { col = 0; pendingWrap = false; i += 1; continue }
    if (pendingWrap) { row = Math.min(h - 1, row + 1); col = 0; pendingWrap = false }
    const cp = source.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    const cw = columnOf(cp)
    grid[row]![col] = ch
    if (cw > 1 && col + 1 < w) grid[row]![col + 1] = ''
    if (col + cw >= w) pendingWrap = true
    col += cw
    i += ch.length
  }
  return grid
}

/** Strip SGR/style sequences so rows can be compared as plain text. */
export const visibleOf = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/**
 * Project styled frame rows onto a grid of VISIBLE cells.
 *
 * The rows carry SGR codes, so they cannot be compared to a replayed surface
 * index by index - the escape bytes shift every column. Walking code points and
 * skipping escapes puts both on the same footing: the cells the terminal shows.
 * A wide glyph claims two cells, matching `visibleWidth`.
 */
export function visibleGrid(rows: string[], w: number, h: number): string[][] {
  const grid: string[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ' '))
  rows.forEach((row, r) => {
    if (r >= h) return
    let c = 0
    let i = 0
    while (i < row.length && c < w) {
      if (row[i] === '\x1b' && row[i + 1] === '[') {
        const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(row.slice(i))
        if (m) { i += m[0].length; continue }
      }
      const cp = row.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      const cw = columnOf(cp)
      grid[r]![c] = ch
      if (cw > 1 && c + 1 < w) grid[r]![c + 1] = ''
      c += cw
      i += ch.length
    }
  })
  return grid
}

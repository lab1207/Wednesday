/**
 * Plate renderer — the quadrant engine.
 *
 * A terminal cell is not a pixel; it is roughly 8 × 17 device pixels, and
 * Unicode gives us four of them. U+2596..U+259F each fill one quadrant of a
 * cell and every cell carries an INDEPENDENT foreground and background colour,
 * so a cell is a 2 × 2 block of sub-pixels in two tones. That makes a
 * 52-column plate a 104 × 28 sub-pixel canvas — the resolution at which real
 * artwork still reads instead of turning into noise.
 *
 * Braille (U+2800) doubles the resolution to one colour per cell and sextants
 * and octants were both measured and both render as tofu, so quadrant is the
 * only safe choice: Unicode 2.0, four sub-pixels, two colours.
 *
 * The plate itself is BAKED, not rendered live. scripts/bake-plate.py reads
 * the artwork out of wednesday-theme/tui-design.html, rasterises it with
 * headless Chrome at the sub-pixel size, and runs the quantiser once. The CLI
 * therefore ships no rasteriser and gains no dependency — it only reads
 * strings — and regenerating is an explicit, reviewable step.
 */

import { GATE_COLS, GATE_ROWS, GATE_PLATE, TONE_256, TONE_NAMES, type PlateRun } from './plate-gate-data'
import { BRAND_HEX } from './theme'

/** Tone hexes in the same luma order the baked indices use. */
const TONE_HEX: readonly string[] = [
  BRAND_HEX.voidInk,
  BRAND_HEX.plumInk,
  BRAND_HEX.ironViolet,
  BRAND_HEX.nevermoreDeep,
  BRAND_HEX.nevermore,
  BRAND_HEX.amber,
  BRAND_HEX.bone,
]

export { GATE_COLS, GATE_ROWS, TONE_NAMES }

/** True when the terminal should get real colour rather than 256 approximations. */
function truecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NO_COLOR ?? '') !== '') return false
  const term = (env.TERM ?? '').toLowerCase()
  if (term === 'dumb') return false
  return true
}

function rgbOf(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

const RGB_TONES = TONE_HEX.map(rgbOf)

/** One tone pair for a run: fg and bg, each as a complete SGR sequence. */
function sgrPair(index: number, colour: boolean): string {
  if (colour) {
    const [r, g, b] = RGB_TONES[index] ?? [0, 0, 0]
    return `38;2;${r};${g};${b}m`
  }
  return `38;5;${TONE_256[index] ?? 232}m`
}

/** Background tone pair, mirroring the foreground fallback. */
function bgPair(index: number, colour: boolean): string {
  if (colour) {
    const [r, g, b] = RGB_TONES[index] ?? [0, 0, 0]
    return `48;2;${r};${g};${b}m`
  }
  return `48;5;${TONE_256[index] ?? 232}m`
}

/**
 * Render the baked plate as ANSI rows.
 *
 * Runs are emitted as fg + bg + text + reset, which is one escape pair per run
 * rather than per cell. On a 52 × 14 plate that is 728 runs instead of 728
 * cells × 4 escapes, and the run merge is already baked into the data.
 */
export function gatePlateRows(env: NodeJS.ProcessEnv = process.env): string[] {
  const colour = truecolor(env)
  return GATE_PLATE.map(row =>
    row
      .map((run: PlateRun) =>
        `\x1b[0;${sgrPair(run.f, colour)}\x1b[${bgPair(run.b, colour)}${run.s}\x1b[0m`,
      )
      .join(''),
  )
}

/**
 * The plate scaled to fit `cols`, by choosing how many source columns to show.
 *
 * Fit is DERIVED, never fixed: the caller decides the cell budget and the
 * plate takes the width it can get, cropping the sides evenly rather than
 * squashing the artwork. A squashed gate is a different picture; a cropped one
 * is the same picture with less of it.
 */
export function gatePlateRowsFor(cols: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const rows = gatePlateRows(env)
  if (cols >= GATE_COLS) return rows
  const drop = Math.floor((GATE_COLS - cols) / 2)
  return rows.map(row => clipRow(row, drop, drop + cols))
}

/**
 * Clip an ANSI row to a visible-column window, preserving colour runs.
 *
 * A regex over the escape codes would be wrong here: the same tone can appear
 * in several consecutive runs, and a naive split would either merge cells that
 * are not adjacent or leave a dangling reset. Walking the runs is exact.
 */
function clipRow(row: string, from: number, to: number): string {
  let column = 0
  let out = ''
  // Split into (escape-prefix, text) pairs so styling travels with its glyphs.
  const parts = row.split(/(\x1b\[[0-9;]*m)/)
  let prefix = ''
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('\x1b[')) { prefix += part; continue }
    const length = [...part].length
    const start = column
    const end = column + length
    column = end
    if (end <= from || start >= to) { prefix = ''; continue }
    const cutStart = Math.max(0, from - start)
    const cutEnd = Math.min(length, to - start)
    const slice = [...part].slice(cutStart, cutEnd).join('')
    if (slice) out += `${prefix}${slice}`
    prefix = ''
  }
  return `${out}\x1b[0m`
}

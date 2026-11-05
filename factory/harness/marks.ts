/**
 * Wednesday glyph vocabulary — the DECODE KEY.
 *
 * Every mark the harness can print, the event it belongs to, the tone it
 * wears, and a Tier-A ASCII twin. Transcribed from the glyph table in
 * wednesday-theme/tui-design.html (family "Glyph vocabulary"), which is the
 * design record; this module is the CLI's copy of it.
 *
 * Three rules the table encodes, all enforced here rather than by convention:
 *
 *  1. ONE IDEA PER CELL. `rose` means the house is awake and nothing else.
 *     Two events wanting the same mark means one of them is wrong, so the
 *     table below is the only place a mark is bound to an event.
 *  2. ORNAMENTAL, NEVER GENERIC. `◆ ◇ ◈ ○` belong to every codebase ever
 *     written and carry no meaning, so they appear nowhere. `star` (✦) is the
 *     Nevermore mark and replaces ◇ as the session opener.
 *  3. TIER A IS DESIGNED, NOT A CONSOLATION. The ascii column is chosen so
 *     the line still parses in a cp437 conhost or a raster-font terminal:
 *     `* + o ~ = x > . #` are unambiguous in a log and `#` reads as archived
 *     without a legend. WEDNESDAY_GLYPHS=ascii forces the whole tier down.
 *
 * Tone note (brand-spec rule 3): blood is an ALARM. `--blood-ink` (#ff6470)
 * is the only legal blood as text on void; `--blood` (#b01528) is a fill and
 * measures 2.45:1, which fails. Nothing in this module emits blood as text.
 */

import type { MsgTone } from './screen'

/** Every mark, its ASCII twin, and the tone it wears in the stream. */
export const MARKS = {
  /** Thorn rose — the house. agent.ready. */
  rose: { ornamental: '❦', ascii: '*', tone: 'cyan' },
  /** Rose in bloom — work growing. task.started. */
  bloom: { ornamental: '✿', ascii: '+', tone: 'dim' },
  /** The eye — looking. verification.started. */
  eye: { ornamental: '◉', ascii: 'o', tone: 'cyan' },
  /** Four-point twinkle — a light lit. repair.started. */
  twinkle: { ornamental: '✧', ascii: '~', tone: 'yellow' },
  /** Floret fully open — passed. task.completed. */
  floret: { ornamental: '❀', ascii: '=', tone: 'green' },
  /** Skull — the grave. task.failed. ALARM, never decoration. */
  skull: { ornamental: '☠', ascii: 'x', tone: 'red' },
  /** Pointing index — Thing. Awaiting approval. */
  hand: { ornamental: '☞', ascii: '>', tone: 'yellow' },
  /** Heavy x — severed. Dependency blocked. ALARM. */
  severed: { ornamental: '✖', ascii: '!', tone: 'red' },
  /** Crescent — the halo. Idle. */
  moon: { ornamental: '☾', ascii: '.', tone: 'dim' },
  /** Four-point star — Nevermore. session.started. */
  star: { ornamental: '✦', ascii: '*', tone: 'cyan' },
  /** Dagger — grave marker. task.archived. */
  dagger: { ornamental: '†', ascii: '#', tone: 'dim' },
  /**
   * Black square — the operator's STOP control.
   *
   * A live turn used to be stoppable only with Esc, and the promise lived in
   * a line of prose the operator had to believe. The stop control is a real
   * button: it is drawn on the frame, it is clickable, and it is the same
   * action Esc performs.
   *
   * `■` (U+25A0) is a geometric shape, not a pictograph: no variation
   * selector, no emoji presentation, one cell in every terminal this ships
   * to. The ASCII twin is `x` ("cut"), shared with the skull — the same idea
   * family: this is not alive any more.
   */
  stop: { ornamental: '■', ascii: 'x', tone: 'red' },
} as const satisfies Record<string, { ornamental: string; ascii: string; tone: MsgTone }>

export type MarkName = keyof typeof MARKS

/**
 * Ornamental coverage. WEDNESDAY_GLYPHS=ascii forces the Tier-A twin; every
 * other path assumes the ornamental block, which is what Windows Terminal,
 * modern Unix terminals and OpenTUI all ship. Legacy cp437 conhost callers
 * pass an explicit false.
 */
export function supportsOrnamental(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.WEDNESDAY_GLYPHS ?? '').trim().toLowerCase() !== 'ascii'
}

/** The mark to print, honouring the ASCII tier. */
export function mark(name: MarkName, ornamental = supportsOrnamental()): string {
  const entry = MARKS[name]
  return ornamental ? entry.ornamental : entry.ascii
}

/**
 * Event type → mark. Ordered most-specific first: `task.failed` must beat the
 * generic `/started$/` and `/completed$/` rules, and `verification.*` must be
 * recognisable as "looking" rather than as generic progress.
 *
 * This is the one place a Factory event is given a face. Returning null means
 * the event prints bare — which is correct for types nobody has designed a
 * mark for yet, rather than a silent default.
 */
export function markFor(type: string): MarkName | null {
  if (/(^|\.)failed$/.test(type)) return 'skull'
  if (/(^|\.)blocked$/.test(type)) return 'severed'
  if (type === 'repair.started' || type.startsWith('repair.')) return 'twinkle'
  if (type.startsWith('verification.')) return 'eye'
  if (type === 'agent.ready') return 'rose'
  if (type === 'task.created' || type === 'session.started') return 'star'
  if (/completed$/.test(type)) return 'floret'
  if (/started$/.test(type)) return 'bloom'
  if (/archived$/.test(type)) return 'dagger'
  return null
}

// ── The wordmark ─────────────────────────────────────────────────────────────

/**
 * WEDNESDAY as a 5 × 8 sub-pixel bitmap — a glyph TABLE, not a typeface
 * (design board §4). A terminal has no Cinzel and never will, so anything that
 * needs a font at runtime is a lie inside a `<pre>`. This is data: it ports
 * byte for byte, renders identically everywhere, and costs no font file.
 *
 * Rows are sub-pixels, two per cell, painted with the half-block family
 * (`▀ ▄ █`). That is the whole trick: `█` in a monospace cell is 1 × 2 device
 * pixels (8 × 17), so a half-block cell is a SQUARE pixel. The table this
 * replaced drew its pixels as FULL cells — 8 × 17 each, twice as tall as wide —
 * so every letter came out stretched into bars (the complaint that got this
 * redrawn, 2026-10-16). Square pixels force the geometry instead: 5 columns
 * wide × 8 sub-rows tall is 1:1.6 per letter, the proportion every 5 × 7 pixel
 * font has, and a 5 × 12 grid (the first attempt at this fix) is 1:2.5 —
 * a stretched letter wearing pixel-art colours. Sixteen sub-rows to keep the
 * curves was the wrong trade; square pixels and honest proportions were right.
 *
 * `#` = ink, `.` = void. Five wide, eight tall, one '.' column between
 * glyphs: 9 × 5 + 8 = 53 cells, four cell rows.
 */
const WORDMARK_5X8: Record<string, readonly string[]> = {
  W: [
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#.#.#',
    '#.#.#',
    '.#.#.',
    '..#..',
  ],
  E: [
    '#####',
    '#....',
    '#....',
    '####.',
    '#....',
    '#....',
    '#....',
    '#####',
  ],
  D: [
    '####.',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '####.',
  ],
  N: [
    '#...#',
    '##..#',
    '##..#',
    '#.#.#',
    '#.#.#',
    '#..##',
    '#..##',
    '#...#',
  ],
  S: [
    '.####',
    '##...',
    '#....',
    '#....',
    '###..',
    '....#',
    '....#',
    '####.',
  ],
  A: [
    '..#..',
    '..#..',
    '.#.#.',
    '.#.#.',
    '#...#',
    '#...#',
    '#####',
    '#...#',
  ],
  Y: [
    '#...#',
    '#...#',
    '#...#',
    '.#.#.',
    '.#.#.',
    '..#..',
    '..#..',
    '..#..',
  ],
}

/** One painted row of the wordmark: the cells, and the tone they wear. */
export interface WordmarkRow {
  text: string
  tone: MsgTone
}

/** Cells one standard wordmark row occupies: 9 glyphs of 5 + 8 gaps. */
const WORDMARK_COLS = 53
/** The big size (each sub-pixel a full cell): 9 glyphs of 10 + 8 gaps of 2. */
const WORDMARK_BIG_COLS = 106
/** Ink margin a wordmark needs before it is drawn at all. */
const WORDMARK_MARGIN = 4

/** One glyph row for one letter, `.` for void. */
function glyphRow(letter: string, y: number): string {
  return WORDMARK_5X8[letter]?.[y] ?? '.'.repeat(5)
}

/**
 * The wordmark as rows of half-block cells (standard size), or [] when `cols`
 * cannot hold it.
 *
 * Width is fixed by the table — 53 cells — and there is no fraction of a
 * wordmark worth drawing: below 53 + 4 the caller gets [] and the crest (name
 * + tagline, type) carries the page. Budget BEFORE drawing was the fix for the
 * first pass, which scaled to the frame and clipped an orphaned half-glyph.
 *
 * The last row is the letters' FEET and wears the accent (violet), fading the
 * wordmark into the rule drawn directly beneath it; the body is bold bone.
 */
export function wordmarkRows(cols: number): WordmarkRow[] {
  const big = cols >= WORDMARK_BIG_COLS + WORDMARK_MARGIN
  const width = big ? WORDMARK_BIG_COLS : WORDMARK_COLS
  if (width + WORDMARK_MARGIN > cols) return []
  const letters = [...'WEDNESDAY']
  const rows: WordmarkRow[] = []
  if (big) {
    // Nearest-neighbour 2x, not a stretch: each sub-pixel becomes two cells
    // WIDE and still one row tall, so pixels stay square (16 × 17) and the
    // letterforms keep the standard size's proportions exactly. Scaling pixel
    // art any other way is how it stops being pixel art.
    for (let y = 0; y < 8; y++) {
      const text = letters
        .map(letter => [...glyphRow(letter, y)].map(cell => (cell === '#' ? '██' : '  ')).join(''))
        .join('  ')
      rows.push({ text, tone: y === 7 ? 'cyan' : 'bold' })
    }
    return rows
  }
  // Two sub-pixels per cell, painted with ▀ / ▄ / █: square pixels.
  for (let y = 0; y < 8; y += 2) {
    const top = letters.map(letter => glyphRow(letter, y)).join('.')
    const bottom = letters.map(letter => glyphRow(letter, y + 1)).join('.')
    let text = ''
    for (let x = 0; x < top.length; x++) {
      const t = top[x] === '#'
      const b = bottom[x] === '#'
      text += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
    }
    rows.push({ text, tone: y === 6 ? 'cyan' : 'bold' })
  }
  return rows
}

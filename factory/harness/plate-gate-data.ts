/**
 * The Nevermore gate plate, baked into terminal cells.
 *
 * GENERATED FILE — do not edit. Rebuild with:
 *   python scripts/bake-plate.py
 *
 * Source artwork: the `plate-gate` symbol in wednesday-theme/tui-design.html,
 * the design record. That file is the review surface; this is the CLI's copy,
 * and the two must not drift.
 *
 * 52 x 14 cells, each cell one U+2596..U+259F quadrant glyph with an
 * independent foreground and background tone, so a cell is 2x2 sub-pixels and
 * the whole plate is 104 x 28 at two tones each. Tone indices
 * are positions in TONE_NAMES below (luma order: 0 darkest, 6 brightest).
 *
 * Rows are top to bottom; each row is a list of runs, and a run is a maximal
 * stretch of cells sharing one foreground and one background. Runs, not cells,
 * because a plate is mostly large flat areas and 3,400 individual cells would
 * be 3,400 escape sequences.
 */
export const GATE_COLS = 52
export const GATE_ROWS = 14

export const TONE_NAMES = [
  'voidInk',
  'plumInk',
  'ironViolet',
  'nevermoreDeep',
  'nevermore',
  'amber',
  'bone',
] as const

/** Tone index -> 256-colour code, for terminals without truecolor. */
export const TONE_256 = [
  232,
  16,
  16,
  55,
  98,
  215,
  224,
] as const

export interface PlateRun {
  /** Tone index used as the foreground (the brightest in the cell). */
  f: number
  /** Tone index used as the background (the darkest in the cell). */
  b: number
  /** One glyph per cell; U+2596..U+259F, or a space. */
  s: string
}

export const GATE_PLATE: PlateRun[][] = [
    [{ f: 1, b: 1, s: "███████████████████████████" }, { f: 2, b: 1, s: "▝" }, { f: 1, b: 1, s: "████████████████████████" }],
    [{ f: 1, b: 0, s: "▙" }, { f: 1, b: 1, s: "█████████████████████" }, { f: 2, b: 1, s: "▗" }, { f: 1, b: 1, s: "████" }, { f: 2, b: 2, s: "█" }, { f: 1, b: 1, s: "█████████" }, { f: 2, b: 1, s: "▄" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▖" }, { f: 2, b: 1, s: "▙" }, { f: 1, b: 1, s: "███████████" }],
    [{ f: 1, b: 1, s: "██████████████████████" }, { f: 2, b: 1, s: "▟" }, { f: 1, b: 1, s: "███" }, { f: 2, b: 1, s: "▗▛" }, { f: 1, b: 1, s: "███" }, { f: 2, b: 1, s: "▖" }, { f: 1, b: 1, s: "████" }, { f: 2, b: 1, s: "▗" }, { f: 2, b: 2, s: "█" }, { f: 6, b: 3, s: "▟" }, { f: 6, b: 6, s: "█" }, { f: 6, b: 2, s: "▖" }, { f: 2, b: 1, s: "▙" }, { f: 1, b: 1, s: "█" }, { f: 2, b: 1, s: "▝" }, { f: 1, b: 1, s: "████████" }],
    [{ f: 1, b: 1, s: "████████" }, { f: 5, b: 1, s: "▖" }, { f: 1, b: 1, s: "█████████████" }, { f: 2, b: 1, s: "▀" }, { f: 1, b: 1, s: "█" }, { f: 2, b: 1, s: "▗" }, { f: 1, b: 1, s: "█" }, { f: 2, b: 1, s: "▄▄▄▄▄" }, { f: 2, b: 2, s: "█" }, { f: 2, b: 1, s: "▄▄▄▄▟" }, { f: 3, b: 2, s: "▝" }, { f: 6, b: 6, s: "██" }, { f: 6, b: 2, s: "▌" }, { f: 2, b: 2, s: "██" }, { f: 5, b: 1, s: "▗" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▖▐" }, { f: 2, b: 2, s: "██" }],
    [{ f: 1, b: 1, s: "███" }, { f: 2, b: 1, s: "▄▄▖" }, { f: 2, b: 2, s: "████" }, { f: 2, b: 1, s: "▙▄▄▟▟▟▟" }, { f: 2, b: 2, s: "████" }, { f: 3, b: 2, s: "▗▄▖" }, { f: 2, b: 2, s: "██" }, { f: 3, b: 2, s: "▐" }, { f: 3, b: 3, s: "█" }, { f: 3, b: 2, s: "▌" }, { f: 2, b: 2, s: "█" }, { f: 2, b: 1, s: "▛" }, { f: 1, b: 1, s: "█" }, { f: 2, b: 2, s: "██████" }, { f: 4, b: 2, s: "▝" }, { f: 6, b: 2, s: "▀" }, { f: 3, b: 2, s: "▘" }, { f: 2, b: 2, s: "████████" }, { f: 2, b: 1, s: "▙" }, { f: 2, b: 2, s: "██" }],
    [{ f: 2, b: 2, s: "██████████" }, { f: 2, b: 1, s: "▞" }, { f: 2, b: 2, s: "███████████" }, { f: 4, b: 3, s: "▄" }, { f: 4, b: 2, s: "▖" }, { f: 2, b: 1, s: "▄▟" }, { f: 3, b: 2, s: "▐" }, { f: 5, b: 3, s: "▜" }, { f: 2, b: 2, s: "█" }, { f: 2, b: 1, s: "▀" }, { f: 3, b: 2, s: "▐" }, { f: 3, b: 3, s: "█" }, { f: 2, b: 2, s: "█████████" }, { f: 2, b: 1, s: "▛" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██████" }],
    [{ f: 2, b: 2, s: "█████████" }, { f: 2, b: 1, s: "▛" }, { f: 1, b: 1, s: "█" }, { f: 2, b: 1, s: "▀▀▀▜" }, { f: 2, b: 2, s: "█████" }, { f: 2, b: 1, s: "▄▟" }, { f: 3, b: 2, s: "▀▘" }, { f: 4, b: 3, s: "▗" }, { f: 3, b: 2, s: "▌▗" }, { f: 5, b: 2, s: "▄" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▗▐" }, { f: 4, b: 3, s: "▜" }, { f: 2, b: 2, s: "█" }, { f: 2, b: 1, s: "▛▜" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▛▀▀▀▘" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██████" }],
    [{ f: 2, b: 2, s: "█████████" }, { f: 2, b: 1, s: "▛▌▛" }, { f: 2, b: 2, s: "████" }, { f: 2, b: 1, s: "▄▟" }, { f: 2, b: 2, s: "██" }, { f: 3, b: 2, s: "▗" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▐" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▝" }, { f: 2, b: 2, s: "██" }, { f: 3, b: 2, s: "▀" }, { f: 2, b: 1, s: "▟" }, { f: 3, b: 2, s: "▞" }, { f: 2, b: 2, s: "████" }, { f: 2, b: 1, s: "▙▄▄▟" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██████" }],
    [{ f: 2, b: 2, s: "█████████" }, { f: 2, b: 1, s: "▌▘▘▀▛" }, { f: 2, b: 2, s: "██████" }, { f: 4, b: 2, s: "▝" }, { f: 2, b: 1, s: "▜▟▐" }, { f: 3, b: 2, s: "▝" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▗" }, { f: 3, b: 1, s: "▄" }, { f: 2, b: 1, s: "▌▛" }, { f: 2, b: 2, s: "█" }, { f: 4, b: 2, s: "▌" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▜" }, { f: 4, b: 2, s: "▌" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▛▀▝▝" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██████" }],
    [{ f: 2, b: 2, s: "█████████" }, { f: 2, b: 1, s: "▌" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▙▟▄▟" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▟▟▜▄▗▟" }, { f: 3, b: 2, s: "▝" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▖▖▖" }, { f: 2, b: 2, s: "█" }, { f: 2, b: 1, s: "▙▄▄▄▄▟" }, { f: 2, b: 2, s: "██████" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██████" }],
    [{ f: 3, b: 2, s: "▗▄▄▄" }, { f: 3, b: 3, s: "██" }, { f: 3, b: 2, s: "▖" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▌" }, { f: 2, b: 2, s: "█" }, { f: 3, b: 2, s: "▌▖▖" }, { f: 2, b: 2, s: "██" }, { f: 3, b: 2, s: "▗▐▐▐▐▐▐▗▗" }, { f: 3, b: 3, s: "██" }, { f: 3, b: 2, s: "▌▌▌▌▌▌▌▖▌▖▗▐▐▐" }, { f: 2, b: 2, s: "███" }, { f: 2, b: 1, s: "▙" }, { f: 3, b: 1, s: "▐" }, { f: 3, b: 3, s: "█████" }, { f: 3, b: 2, s: "▙" }],
    [{ f: 3, b: 2, s: "▝▀▀▀▀▀▘" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▌▀" }, { f: 3, b: 1, s: "▀▀" }, { f: 3, b: 2, s: "▘▀▀▀▝▝▝" }, { f: 3, b: 1, s: "▝▝▝▝▝" }, { f: 4, b: 2, s: "▀▀" }, { f: 3, b: 1, s: "▀▀▀▘" }, { f: 3, b: 2, s: "▘▘▘▘▘▀▀▝" }, { f: 3, b: 1, s: "▀▝" }, { f: 2, b: 1, s: "▜" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▛" }, { f: 3, b: 1, s: "▝" }, { f: 3, b: 2, s: "▀▀▀▀▀▀" }],
    [{ f: 1, b: 1, s: "██████" }, { f: 2, b: 1, s: "▐" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▌" }, { f: 1, b: 1, s: "████████████████████████████████" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▙" }, { f: 1, b: 1, s: "███████" }],
    [{ f: 2, b: 1, s: "▄▄▄▄▄▄▟" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▖" }, { f: 1, b: 1, s: "██" }, { f: 2, b: 1, s: "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖" }, { f: 1, b: 1, s: "█████████████" }, { f: 2, b: 0, s: "▄" }, { f: 2, b: 2, s: "██" }, { f: 2, b: 1, s: "▙▗▄▄▄▄▄▄" }],
]

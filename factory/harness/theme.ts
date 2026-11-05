/**
 * Wednesday theme — single source of colour truth.
 *
 * The terminal is MONOCHROME VIOLET ON BLACK (operator decision 2026-11-04):
 * one family, from near-black surfaces through ash greys to Nevermore violet,
 * with lavender / orchid / periwinkle carrying success, alarm and links.
 * There is no red, green, amber or blue anywhere in the TUI — semantic tone
 * names (`red`, `green`, `yellow`) survive as API names, not as hues.
 */

export interface TuiTheme {
  /** Void ink — app background (RGB 7 7 12). */
  readonly bg: number
  /** Plum ink — panels, code blocks (RGB 20 16 32). */
  readonly surface: number
  /** Plum ink raised one step (RGB 27 22 48). */
  readonly surface2: number
  /** Bone — primary text (RGB 236 230 218). */
  readonly fg: number
  /** Ash violet — meta, timestamps (RGB 154 144 176). */
  readonly muted: number
  /** Wrought iron — 1px panel borders (RGB 43 35 64). */
  readonly border: number
  /**
   * Depth ladder for a RAISED panel — light above, cast edge below.
   *
   * A panel with one border colour on all four edges reads FLAT: there is no
   * cue for which way the light falls, so the box looks like a printed
   * rectangle rather than a surface standing off the page. These three steps
   * are what make an input box read as raised and a floating plate read as
   * floating. `border` alone was defined in the brand spec and never used.
   */
  readonly edgeTop: number
  readonly edgeSide: number
  readonly edgeBottom: number
  /** One step ABOVE the panel fill: the lit inner edge of a raised surface. */
  readonly surfaceHi: number
  /**
   * Cast shadow under a floating panel. The 256 ramp bottoms out at 232 (the
   * page's own ink), so a shadow cannot be drawn darker — it is drawn as a
   * faint texture one step off the page instead, which is how terminal UIs
   * fake a drop shadow.
   */
  readonly shadow: number
  /** Nevermore violet — focus + titles only (RGB 139 111 212). */
  readonly accent: number
  /**
   * Alarm — failed/blocked. The terminal palette is monochrome violet on
   * purpose (operator decision 2026-11-04: purple and black only), so the
   * alarm is the hottest orchid in the family, not a red. Red/green/amber were
   * removed from the TUI: meaning is carried by the mark (`✖`, `✔`, `▲`) and
   * by intensity, so the screen still reads at a glance on a stock console.
   */
  readonly blood: number
  /** Alarm ink — the hot orchid used for failed text on void. */
  readonly bloodInk: number
  /** Lit mark — awaiting/armed, the brightest lilac. Never a fill. */
  readonly amber: number
  /** Done — completed / PASS, a cool lavender. */
  readonly sage: number
  /** Link — periwinkle, the one cool step beside Nevermore. */
  readonly glass: number
  /** Diff add wash — deep violet, so a patch stays in the same family. */
  readonly diffAdd: number
  /** Diff delete wash — deep magenta. */
  readonly diffDel: number
}

/**
 * 256-colour cube approximation of the brand hexes (truecolor where the
 * terminal supports it; the cube keeps Windows consoles close enough).
 * Derivation: rgb channel -> nearest of the 6 cube steps (0, 95, 135,
 * 175, 215, 255) + 16.
 */
export const THEME: TuiTheme = {
  // The ELEVATION LADDER. Three surfaces and three edges, and the whole point
  // is that each step is far enough apart to read at a glance:
  //
  //   232  page (void ink)
  //   235  the composer          <- the first thing you look at
  //   237  a floating plate      <- above the composer
  //   141  lit edge   ┐
  //   60   body edge  ├ the light comes from above-left
  //   234  cast edge  ┘
  //
  // The first attempt at this used 240/238/236 for the three edges and was
  // reported as "where is the glass theme". It was correct and invisible: three
  // adjacent greys two steps apart are the same colour to anyone not holding a
  // colour picker, and nothing was filled with any of them - the composer had no
  // background at all, so there was no surface to light in the first place.
  //
  // 2026-11-04: the ladder is violet now, not grey. A grey rim on a violet page
  // reads as a system dialog; a lavender rim reads as the house. Depth is still
  // measured in LUMINANCE (`luminance()` below), never in palette index order,
  // because 141 sits below 235 in the index table and is brighter on screen.
  bg: 232,        // ~#080808 page (void ink)
  surface: 235,    // ~#262626 the composer's fill: a real surface above the page
  surface2: 237,   // ~#3a3a3a a floating plate, one step above the composer
  fg: 189,         // #d7d7ff pale periwinkle - bone, tinted to the house hue
  muted: 146,      // #afafd7 ash lavender - meta, timestamps
  border: 60,      // #5f5f87 wrought violet - 1px rails
  edgeTop: 141,    // #af87ff the LIT edge - lavender, this is what reads as depth
  edgeSide: 60,    // #5f5f87 the body edge
  edgeBottom: 234, // ~#1c1c1c the CAST edge - dark, the shadow side
  surfaceHi: 98,   // inner highlight just under a lit rail
  shadow: 233,     // ~#121212, one step off the page: the cast shadow texture
  accent: 98,      // #8b6fd4 Nevermore (hexTo256-verified in screen-test)
  // Everything chromatic below is in the violet family. The old red/green/amber
  // triple was the brand spec's illustration palette; the operator asked for a
  // strictly purple-on-black terminal, so the SEMANTIC NAMES stay (tests and
  // callers speak `red`/`green`/`yellow`) while the hues are all lavender,
  // orchid and periwinkle. `blood` is a fill, `bloodInk` is text on void.
  blood: 53,       // deep magenta fill
  bloodInk: 177,   // hot orchid — failure text
  amber: 183,      // pale lilac — a LIT mark
  sage: 141,       // lavender — done / pass
  glass: 105,      // periwinkle — links
  diffAdd: 54,     // deep violet wash
  diffDel: 53,     // deep magenta wash
}

export const RESET = '\x1b[0m'

/** Foreground truecolor from hex. */
export function fgHex(hex: string, text: string): string {
  return `\x1b[38;2;${r(hex)};${g(hex)};${b(hex)}m${text}${RESET}`
}

/** Background truecolor from hex. */
export function bgHex(hex: string, text: string): string {
  return `\x1b[48;2;${r(hex)};${g(hex)};${b(hex)}m${text}${RESET}`
}

/** Nearest 256-colour index for a hex (cube steps + greys). */
export function hexTo256(hex: string): number {
  const rr = r(hex); const gg = g(hex); const bb = b(hex)
  if (Math.abs(rr - gg) < 8 && Math.abs(gg - bb) < 8) {
    const gray = Math.round((rr + gg + bb) / 3)
    if (gray >= 8 && gray <= 238) return 232 + Math.round((gray - 8) / 10)
  }
  const q = (v: number): number => (v < 48 ? 0 : Math.min(5, Math.round((v - 55) / 40)))
  return 16 + 36 * q(rr) + 6 * q(gg) + q(bb)
}

/**
 * RGB of a 256-colour code.
 *
 * Needed because palette INDEX order says nothing about brightness: the violet
 * ramp crosses the greyscale ramp, so 141 (bright lavender) has a lower index
 * than 235 (near-black) while being many times brighter. Any rule about "the
 * lit edge is lighter than the surface" must measure light, not the table.
 */
export function codeRgb(code: number): [number, number, number] {
  if (code < 16) {
    // The system palette. Terminals disagree about these sixteen, so the
    // standard xterm values are an approximation used only for contrast math.
    const base: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ]
    return [...(base[code] ?? [0, 0, 0])] as [number, number, number]
  }
  if (code >= 232) {
    const level = 8 + 10 * (Math.min(255, code) - 232)
    return [level, level, level]
  }
  const levels = [0, 95, 135, 175, 215, 255]
  const n = code - 16
  return [levels[Math.floor(n / 36)]!, levels[Math.floor((n % 36) / 6)]!, levels[n % 6]!]
}

/** Relative luminance (WCAG) of a 256-colour code, 0 (black) .. 1 (white). */
export function luminance(code: number): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [rr, gg, bb] = codeRgb(code)
  return 0.2126 * channel(rr) + 0.7152 * channel(gg) + 0.0722 * channel(bb)
}

function r(hex: string): number { return parseInt(hex.slice(1, 3), 16) }
function g(hex: string): number { return parseInt(hex.slice(3, 5), 16) }
function b(hex: string): number { return parseInt(hex.slice(5, 7), 16) }

/** Brand hexes, for callers that need truecolor (web preview, export). */
export const BRAND_HEX = {
  voidInk: '#07070c',
  plumInk: '#141020',
  plumInk2: '#1b1630',
  bone: '#ece6da',
  ashViolet: '#9a90b0',
  ironViolet: '#2b2340',
  nevermore: '#8b6fd4',
  nevermoreDeep: '#5d43a0',
  blood: '#b01528',
  bloodInk: '#ff6470',
  amber: '#ffb84d',
  amberDeep: '#cc7722',
  sage: '#7fb069',
  glassBlue: '#4f9fb8',
} as const
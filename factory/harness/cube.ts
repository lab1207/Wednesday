/**
 * The Wednesday brand mark in a terminal: a TESSERACT (4D cube), the same
 * mark as site/icon.svg, rendered as a wireframe into braille cells.
 *
 * Why braille: a cell is 2 × 4 dots, and a terminal cell is roughly twice as
 * tall as wide, so one braille dot is approximately a SQUARE pixel — the same
 * trick the wordmark uses with half-blocks. Lines drawn on the dot grid stay
 * smooth at any window size instead of turning into stair-steps.
 *
 * Math: 16 vertices (±1, ±1, ±1, ±1), 32 edges (pairs differing in one
 * coordinate). Two 4D rotations (X–W and Y–W planes, phased) turn the inner
 * cube inside the outer one — the "4D" read. Then 4D → 3D perspective, then
 * 3D → 2D perspective, then a dot-grid Bresenham per edge. Depth picks the
 * tone: near edges wear Nevermore violet (`cyan` tone in the TUI palette),
 * far edges ash (`dim`), vertices bone (`bold`). Brand rule 14: the mark
 * MOVES when it is the active state — Screen animates `t` on the home page;
 * everywhere else it renders a still frame. WEDNESDAY_NO_ANIM=1 freezes it.
 *
 * This module imports MsgTone as a TYPE only, so screen.ts can import this
 * file with no runtime cycle.
 */
import type { MsgTone } from './screen'

export interface CubeRow {
  text: string
  tone: MsgTone
}

/** 16 vertices of the unit hypercube, coordinates in {-1, 1}. */
function vertices(): Array<[number, number, number, number]> {
  const v: Array<[number, number, number, number]> = []
  for (let i = 0; i < 16; i++) {
    v.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ])
  }
  return v
}

/** 32 edges: vertex pairs differing in exactly one coordinate. */
function edges(): Array<[number, number]> {
  const e: Array<[number, number]> = []
  for (let i = 0; i < 16; i++) {
    for (let bit = 0; bit < 4; bit++) {
      const j = i ^ (1 << bit)
      if (j > i) e.push([i, j])
    }
  }
  return e
}

const VERTS = vertices()
const EDGES = edges()

/** Rotate (x, y, z, w) in the X–W plane by a and the Y–W plane by b. */
function rot4(p: [number, number, number, number], a: number, b: number): [number, number, number, number] {
  let [x, y, z, w] = p
  const ca = Math.cos(a); const sa = Math.sin(a)
  const x1 = x * ca - w * sa
  const w1 = x * sa + w * ca
  x = x1; w = w1
  const cb = Math.cos(b); const sb = Math.sin(b)
  const y1 = y * cb - w * sb
  const w2 = y * sb + w * cb
  return [x, y1, z, w2]
}

/** Braille dot bit for dot-grid offset (dx 0..1, dy 0..3) inside a cell. */
const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/**
 * Render one frame of the spinning tesseract into `cols` × `rows` cells.
 * Returns one row per cell row; fully empty cells come back as spaces with
 * `dim` tone so callers can centre/pad them like any other row.
 */
export function tesseractRows(cols: number, rows: number, t: number): CubeRow[] {
  const cw = Math.max(1, Math.floor(cols))
  const ch = Math.max(1, Math.floor(rows))
  // Dot grid: 2 × 4 dots per cell, roughly square pixels.
  const dw = cw * 2
  const dh = ch * 4
  // 'near' marks a dot drawn by a near edge or a vertex; everything else is dim.
  const dots = new Uint8Array(dw * dh)
  const near = new Uint8Array(dw * dh)

  const a = t
  const b = t * 0.7 + 0.4
  const d4 = 3.4 // 4D perspective distance
  const d3 = 4.6 // 3D perspective distance
  const scale = Math.min(dw, dh) * 0.42
  const cx = dw / 2
  const cy = dh / 2

  const proj: Array<{ x: number; y: number; depth: number }> = VERTS.map(p => {
    const [x, y, z, w] = rot4(p, a, b)
    const s4 = d4 / (d4 - w)
    const x3 = x * s4; const y3 = y * s4; const z3 = z * s4
    const s3 = d3 / (d3 - z3)
    return { x: cx + x3 * s3 * scale, y: cy + y3 * s3 * scale, depth: s4 * s3 }
  })

  const setDot = (x: number, y: number, isNear: boolean): void => {
    const xi = Math.round(x); const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= dw || yi >= dh) return
    const i = yi * dw + xi
    dots[i] = 1
    if (isNear) near[i] = 1
  }

  const line = (x0: number, y0: number, x1: number, y1: number, isNear: boolean): void => {
    // Work on the DOT grid, so round the endpoints first: the loop compares
    // integer positions, and float starts would never land exactly on the
    // end cell (an infinite loop, caught by the smoke test).
    let x = Math.round(x0); let y = Math.round(y0)
    const xe = Math.round(x1); const ye = Math.round(y1)
    const dx = Math.abs(xe - x); const dy = Math.abs(ye - y)
    const sx = x < xe ? 1 : -1
    const sy = y < ye ? 1 : -1
    let err = dx - dy
    for (;;) {
      setDot(x, y, isNear)
      if (x === xe && y === ye) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x += sx }
      if (e2 < dx) { err += dx; y += sy }
    }
  }

  const depthMid = (() => {
    const ds = proj.map(p => p.depth).sort((p, q) => p - q)
    return ds[Math.floor(ds.length / 2)] ?? 1
  })()

  for (const [i, j] of EDGES) {
    const p = proj[i]!; const q = proj[j]!
    const isNear = (p.depth + q.depth) / 2 >= depthMid
    line(p.x, p.y, q.x, q.y, isNear)
  }
  // Vertices on top, always bright.
  for (const p of proj) setDot(p.x, p.y, true)

  const out: CubeRow[] = []
  for (let cyi = 0; cyi < ch; cyi++) {
    let text = ''
    let rowTone: MsgTone = 'dim'
    for (let cxi = 0; cxi < cw; cxi++) {
      let bits = 0
      let cellNear = false
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (cyi * 4 + dy) * dw + (cxi * 2 + dx)
          if (dots[i]) {
            bits |= BRAILLE_BIT[dy]![dx]!
            if (near[i]) cellNear = true
          }
        }
      }
      text += bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits)
      if (cellNear) rowTone = 'cyan'
    }
    // A row is 'bold' when it holds a vertex dot cluster — approximate by any
    // near dot in the middle band; keep it simple: near ⇒ cyan, else dim.
    out.push({ text, tone: rowTone })
  }
  return out
}

/** A still, small tesseract for inline use (header mark), ~9 × 4 cells. */
export function tesseractGlyph(t = 0.9): string[] {
  return tesseractRows(9, 4, t).map(r => r.text)
}

/**
 * Model volume mixer (2026-10-13): the operator decides how much each
 * model is used — 0 = off, 1-100 = share. Pure, offline-green.
 *
 * Source: `FACTORY_MODEL_WEIGHTS="qwen-27b:80,devstral-24b:20"` in the
 * profile. Ids absent from the var default 50 (audible); explicit 0
 * mutes. Unknown ids are ignored. The harness panel (sliders + mute
 * toggles) writes this var; routing only reads it here.
 */

export type ModelWeights = Record<string, number>

const DEFAULT_WEIGHT = 50

/** Parse the mixer var (pure): clamps 0-100, drops junk, ignores unknowns. */
export function parseModelWeights(
  env: NodeJS.ProcessEnv = process.env,
  poolIds: string[] = [],
): ModelWeights {
  const known = new Set(poolIds)
  const out: ModelWeights = {}
  const raw = (env.FACTORY_MODEL_WEIGHTS ?? '').trim()
  if (!raw) return out
  for (const entry of raw.split(',')) {
    const piece = entry.trim()
    if (!piece) continue
    const colon = piece.lastIndexOf(':')
    if (colon <= 0) continue
    const id = piece.slice(0, colon).trim()
    const num = Number(piece.slice(colon + 1).trim())
    if (!id || !Number.isFinite(num)) continue
    if (poolIds.length > 0 && !known.has(id)) continue
    out[id] = Math.min(Math.max(Math.round(num), 0), 100)
  }
  return out
}

/** Effective weight: explicit value wins, missing means 50, never 0 unless muted. */
export function weightFor(id: string, weights: ModelWeights): number {
  return weights[id] ?? DEFAULT_WEIGHT
}

/** Audible pool (pure): mutes (0) dropped, order kept. */
export function enabledPool<T extends { id: string }>(
  pool: T[],
  weights: ModelWeights,
): T[] {
  return pool.filter(model => weightFor(model.id, weights) > 0)
}

/**
 * Weighted pick among ids (pure): `rand` injected so tests stay
 * deterministic (pass () => 0 for first-bucket). Returns '' when
 * nothing is audible — caller keeps its fallback.
 */
export function pickWeighted(
  ids: string[],
  weights: ModelWeights,
  rand: () => number = Math.random,
): string {
  const total = ids.reduce((sum, id) => sum + weightFor(id, weights), 0)
  if (total <= 0) return ''
  let roll = rand() * total
  for (const id of ids) {
    roll -= weightFor(id, weights)
    if (roll < 0) return id
  }
  return ids[ids.length - 1] ?? ''
}

/**
 * Lane shares (pure): `width` lanes split proportional to weight via
 * largest remainder (zero-weight models get zero lanes). Sums to
 * exactly `width` (or 0 when nothing audible / width < 1).
 */
export function allocateLanes<T extends { id: string }>(
  pool: T[],
  weights: ModelWeights,
  width: number,
): Array<{ id: string; lanes: number }> {
  const audible = enabledPool(pool, weights)
  if (audible.length === 0 || width < 1) {
    return []
  }
  const total = audible.reduce(
    (sum, model) => sum + weightFor(model.id, weights),
    0,
  )
  if (total <= 0) return []
  const rows = audible.map((model, index) => {
    const exact = (weightFor(model.id, weights) / total) * width
    return { id: model.id, index, base: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  const rest = width - rows.reduce((sum, row) => sum + row.base, 0)
  rows
    .slice()
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
    .slice(0, rest)
    .forEach(row => {
      rows[row.index]!.base += 1
    })
  return rows.map(row => ({ id: row.id, lanes: row.base }))
}

/**
 * Lane lineup (pure): concrete model id per lane index, favorites
 * appearing proportionally more. Empty when nothing audible.
 */
export function laneLineup<T extends { id: string }>(
  pool: T[],
  weights: ModelWeights,
  width: number,
): string[] {
  const out: string[] = []
  for (const row of allocateLanes(pool, weights, width)) {
    for (let i = 0; i < row.lanes; i += 1) out.push(row.id)
  }
  return out
}

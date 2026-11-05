/**
 * Model capability fit (2026-10-13): measure, don't trust slot labels.
 *
 * Problem: the trio pins planner->R1 / coder->Coder / vision->VL by slot
 * name (`crew-routing.ts` + `LocalProvider.selectModel`). A strong model
 * parked in the vision slot then serves ONLY vision, even when it is the
 * best planner and coder too. With 3-15 user models the factory never
 * learns which model is good at what.
 *
 * Fix (this file, pure + offline-green): a tiny probe per capability
 * grades every pooled model, and routing picks the best scorer PER
 * CAPABILITY. One model may win several (or all) roles — that is the
 * point. `assignTeam` turns scores into the factory dream-team
 * (architect/debugger/builder/completer/reviewer/scanner/vision),
 * same rule: best fit per role, fallback when there is no signal.
 * No network here: `probePool` takes a `complete` function so
 * tests inject a fake and live code passes the real provider call.
 *
 * Scope: text probes for four capabilities plus a red-pixel image
 * probe for vision (`VISION_PIXEL_PNG` through `visionImages`); the
 * vision text probe still separates willing describers on routes whose
 * provider ignores image attachments.
 */

import { effectiveScores } from './model-cards'

export type FitCapability =
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'review'
  | 'complete'

export interface ModelScore {
  reasoning: number
  coding: number
  vision: number
  review: number
  complete: number
}

export interface PoolModel {
  id: string
  baseURL?: string
}

/** Scores registry (in-memory): set once per probe, read per route. */
let activePool: PoolModel[] = []
let activeScores: Record<string, ModelScore> = {}

export function setModelFit(
  pool: PoolModel[],
  scores: Record<string, ModelScore>,
): void {
  activePool = pool.slice()
  activeScores = { ...scores }
}

export function clearModelFit(): void {
  activePool = []
  activeScores = {}
}

export function getModelFit(): {
  pool: PoolModel[]
  scores: Record<string, ModelScore>
} {
  return { pool: activePool.slice(), scores: { ...activeScores } }
}

/**
 * Pool assembly (pure): `FACTORY_MODEL_POOL` wins when set —
 * `id@baseURL` entries, baseURL optional, comma-separated —
 * else the 3 crew slots (planner/coder/vision + their tunnels),
 * else the single legacy `LOCAL_LLM_MODEL`. Trims, drops empties,
 * dedupes by id keeping first order.
 */
export function parseModelPool(
  env: NodeJS.ProcessEnv = process.env,
): PoolModel[] {
  const rawPool = (env.FACTORY_MODEL_POOL ?? '').trim()
  if (rawPool.length > 0) {
    const out: PoolModel[] = []
    const seen = new Set<string>()
    for (const entry of rawPool.split(',')) {
      const piece = entry.trim()
      if (!piece) continue
      const at = piece.lastIndexOf('@')
      const id =
        at > 0 ? piece.slice(0, at).trim() : piece
      const baseURL =
        at > 0 ? piece.slice(at + 1).trim() : undefined
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(baseURL ? { id, baseURL } : { id })
    }
    return out
  }

  const slots: Array<{ id: string; baseURL?: string }> = [
    {
      id: (env.FACTORY_CREW_PLANNER_MODEL ?? '').trim(),
      baseURL: (env.FACTORY_CREW_PLANNER_BASE_URL ?? '').trim() || undefined,
    },
    {
      id: (env.FACTORY_CREW_CODER_MODEL ?? '').trim(),
      baseURL: (env.FACTORY_CREW_CODER_BASE_URL ?? '').trim() || undefined,
    },
    {
      id: (env.FACTORY_CREW_VISION_MODEL ?? '').trim(),
      baseURL: (env.FACTORY_CREW_VISION_BASE_URL ?? '').trim() || undefined,
    },
  ]
  const fromSlots = slots.filter(slot => slot.id.length > 0)
  if (fromSlots.length > 0) {
    const out: PoolModel[] = []
    const seen = new Set<string>()
    for (const slot of fromSlots) {
      if (seen.has(slot.id)) continue
      seen.add(slot.id)
      out.push(
        slot.baseURL ? { id: slot.id, baseURL: slot.baseURL } : { id: slot.id },
      )
    }
    return out
  }

  const legacy = (env.LOCAL_LLM_MODEL ?? '').trim()
  return legacy ? [{ id: legacy }] : []
}

/** Tiny deterministic probes: markers are graded by containment. */
export const CAPABILITY_PROBES: Record<
  FitCapability,
  { prompt: string; markers: string[] }
> = {
  reasoning: {
    prompt:
      'Plan in exactly 3 numbered steps how to add two numbers in Python. ' +
      'Reply with lines starting 1, 2, 3 and the word return on the last line.',
    markers: ['1', '2', '3', 'return'],
  },
  coding: {
    prompt:
      'Reply with ONLY this Python line, nothing else: def add(a, b): return a + b',
    markers: ['def add', 'return a + b'],
  },
  vision: {
    prompt:
      'Describe a red square on a blue background in one sentence using ' +
      'the words red, square, blue, background.',
    markers: ['red', 'square', 'blue', 'background'],
  },
  review: {
    prompt:
      'This Python has a bug: def get(xs, i): return xs[i + 1]. ' +
      'Reply with the word bug, the word index, and the number 1.',
    markers: ['bug', 'index', '1'],
  },
  complete: {
    prompt:
      'Complete exactly: def mul(a, b): return a * b. ' +
      'Reply with ONLY that line.',
    markers: ['def mul', 'return a * b'],
  },
}

/** Grade 0-100 by marker hit rate (case-insensitive). No LLM judge. */
export function gradeMarkers(markers: string[], text: string): number {
  if (markers.length === 0) return 0
  const lower = text.toLowerCase()
  let hits = 0
  for (const marker of markers) {
    if (lower.includes(marker.toLowerCase())) hits += 1
  }
  return Math.round((hits / markers.length) * 100)
}

/** Grade a named capability probe by its marker hit rate. */
export function gradeProbe(capability: FitCapability, text: string): number {
  return gradeMarkers(CAPABILITY_PROBES[capability].markers, text)
}

/**
 * Red-pixel image probe (2026-10-16, R-BM-28): a 1x1 red PNG data URI
 * with known content. A model that truly reads images answers the color;
 * a text-only model guesses or refuses and scores 0. Pass the data URI
 * through `visionImages` — providers without an image path ignore the
 * attachments and the text fallback below still separates describers.
 */
export const VISION_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const VISION_IMAGE_PROBE = {
  prompt: 'Reply with ONLY the color of this pixel in one word.',
  markers: ['red'],
}

/**
 * Probe every pooled model on all five capabilities. Never throws:
 * a failed model scores 0 everywhere (fail-open, router falls back).
 * `complete` may accept image attachments; when `visionImages` is set
 * the vision step shows the red pixel instead of asking for a text
 * description.
 */
export async function probePool(
  pool: PoolModel[],
  complete: (modelId: string, prompt: string, images?: string[]) => Promise<string>,
  visionImages?: string[],
): Promise<Record<string, ModelScore>> {
  const scores: Record<string, ModelScore> = {}
  const caps: FitCapability[] = [
    'reasoning',
    'coding',
    'vision',
    'review',
    'complete',
  ]
  for (const model of pool) {
    const score: ModelScore = {
      reasoning: 0,
      coding: 0,
      vision: 0,
      review: 0,
      complete: 0,
    }
    for (const cap of caps) {
      try {
        if (cap === 'vision' && visionImages && visionImages.length > 0) {
          const text = await complete(model.id, VISION_IMAGE_PROBE.prompt, visionImages)
          score[cap] = gradeMarkers(VISION_IMAGE_PROBE.markers, text)
        } else {
          const text = await complete(model.id, CAPABILITY_PROBES[cap].prompt)
          score[cap] = gradeProbe(cap, text)
        }
      } catch {
        score[cap] = 0
      }
    }
    scores[model.id] = score
  }
  return scores
}

/**
 * Best model id for a capability (pure). Ties keep pool order.
 * Returns '' when the pool is empty or every score is 0 — the
 * caller must fall back to the legacy slot pick.
 */
export function selectBestModel(
  capability: FitCapability,
  pool: PoolModel[],
  scores: Record<string, ModelScore>,
): string {
  let best = ''
  let bestScore = 0
  for (const model of pool) {
    const score = scores[model.id]?.[capability] ?? 0
    if (score > bestScore) {
      bestScore = score
      best = model.id
    }
  }
  return best
}

/**
 * Lane → model rotation (pure): duel lane i runs pool[i % pool.length],
 * so a 10-model pool works all 10 models on one question instead of
 * one model ten times. Empty pool keeps the fallback (solo behavior).
 */
export function laneModelFor(
  laneIndex: number,
  pool: PoolModel[],
  fallback: string,
): string {
  if (pool.length === 0) return fallback
  const idx = ((laneIndex % pool.length) + pool.length) % pool.length
  return pool[idx]?.id || fallback
}

/**
 * Registry read with fallback (pure-or-registry): best probed fit
 * wins, name prior fills probe zeros (capped, measurement first),
 * otherwise the caller-supplied legacy slot pick. One strong
 * model CAN win reasoning + coding + vision at once.
 */
export function bestFitFor(capability: FitCapability, fallback: string): string {
  if (activePool.length === 0) return fallback
  const eff = effectiveScores(
    activePool.map(model => model.id),
    activeScores,
  )
  const winner = selectBestModel(capability, activePool, eff)
  return winner || fallback
}

/** Factory team roles and the probed capability behind each one. */
export type TeamRole =
  | 'architect'
  | 'debugger'
  | 'builder'
  | 'completer'
  | 'reviewer'
  | 'scanner'
  | 'vision'

export const ROLE_FIT: Record<TeamRole, FitCapability> = {
  architect: 'reasoning',
  debugger: 'reasoning',
  builder: 'coding',
  completer: 'complete',
  reviewer: 'review',
  scanner: 'review',
  vision: 'vision',
}

export interface TeamAssignment {
  role: TeamRole
  model: string
  score: number
  reason: string
}

/**
 * Full dream-team assignment (pure): best scorer per role, probe first
 * with name prior filling zeros (capped, measurement first). One model
 * may take several roles. `fallback` supplies the legacy pick per
 * role; roles with no signal at all keep it and say so in `reason`.
 */
export function assignTeam(
  pool: PoolModel[],
  scores: Record<string, ModelScore>,
  fallback: Record<TeamRole, string>,
): TeamAssignment[] {
  const eff = effectiveScores(
    pool.map(model => model.id),
    scores,
  )
  const roles: TeamRole[] = [
    'architect',
    'debugger',
    'builder',
    'completer',
    'reviewer',
    'scanner',
    'vision',
  ]
  return roles.map(role => {
    const cap = ROLE_FIT[role]
    const winner = selectBestModel(cap, pool, eff)
    if (winner) {
      const probeHit = (scores[winner]?.[cap] ?? 0) > 0
      return {
        role,
        model: winner,
        score: eff[winner]?.[cap] ?? 0,
        reason: probeHit
          ? `probed ${cap} best (${eff[winner]?.[cap] ?? 0})`
          : `name prior ${cap} (${eff[winner]?.[cap] ?? 0}), probe to confirm`,
      }
    }
    return {
      role,
      model: fallback[role],
      score: 0,
      reason: 'fallback, no probe signal',
    }
  })
}

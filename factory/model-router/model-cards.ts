/**
 * Model cards (2026-10-13): name-based priors, measurement still wins.
 *
 * Rule: the pool NEVER comes from hardcoded ids — `parseModelPool`
 * reads `FACTORY_MODEL_POOL`, else the 3 crew slots, else legacy
 * `LOCAL_LLM_MODEL`. (`TRIO_*` in `crew-routing.ts` and
 * `DEFAULT_MODEL` in `providers/local.ts` are fallback defaults for
 * an empty env, not team members.)
 *
 * This file adds the cheap half of "know the model before using it":
 * infer what an id SUGGESTS (vl/vision=camera, coder/devstral=hands,
 * r1/distill=brain). Priors are capped (50/25) so a real probe score
 * always beats a name. The expensive half — live 1-by-1 probing —
 * is `probePool` in `model-capabilities.ts`; the internet half
 * (catalog/benchmark lookup for image+text support) stays queued
 * (needs source choice + cache design) and this prior is its
 * offline stand-in, never its replacement.
 */

import type { FitCapability, ModelScore } from './model-capabilities'

export interface ModelCard {
  id: string
  tags: string[]
  vision: boolean
  note: string
}

function hasMarker(id: string, markers: string[]): boolean {
  return markers.some(marker => id.includes(marker))
}

const VISION_MARKERS = [
  'vl',
  'vision',
  'llava',
  'multimodal',
  'image',
  'pixtral',
  'glm-4v',
  'glm-4.6v',
]

const CODE_MARKERS = [
  'coder',
  'codestral',
  'devstral',
  'starcoder',
  'codegeex',
  'deepseek-coder',
  'qwen-coder',
]

const REASON_MARKERS = [
  'r1',
  'distill',
  'reasoning',
  'deepseek',
  'architect',
]

/** What the id suggests. Pure, no network. Probe decides. */
export function inferModelCard(id: string): ModelCard {
  const lower = id.toLowerCase()
  const tags: string[] = []
  const vision = hasMarker(lower, VISION_MARKERS)
  if (vision) tags.push('vision')
  if (hasMarker(lower, CODE_MARKERS)) tags.push('code')
  if (hasMarker(lower, REASON_MARKERS)) tags.push('reasoning')
  if (tags.length === 0) tags.push('general')
  return {
    id,
    tags,
    vision,
    note: vision
      ? 'name suggests image+text; probe confirms before vision duty'
      : 'no vision marker in name; probe decides, never the name alone',
  }
}

/**
 * Prior scores from the name, capped so measurement always wins:
 * tag hits give 50, code/reasoning spill 25 into review/complete.
 * All-zero for unknown names (e.g. `laguna-xs` suggests nothing —
 * only the probe can place it).
 */
export function priorFor(id: string): ModelScore {
  const lower = id.toLowerCase()
  const code = hasMarker(lower, CODE_MARKERS)
  const reason = hasMarker(lower, REASON_MARKERS)
  const vision = hasMarker(lower, VISION_MARKERS)
  return {
    reasoning: reason ? 50 : 0,
    coding: code ? 50 : 0,
    vision: vision ? 50 : 0,
    review: reason || code ? 25 : 0,
    complete: code ? 50 : 0,
  }
}

/**
 * Effective scores: real probe where it exists, name prior where the
 * probe is 0. Probe > 0 always wins because priors never exceed 50.
 */
export function effectiveScores(
  poolIds: string[],
  scores: Record<string, ModelScore>,
): Record<string, ModelScore> {
  const out: Record<string, ModelScore> = {}
  const caps: FitCapability[] = [
    'reasoning',
    'coding',
    'vision',
    'review',
    'complete',
  ]
  for (const id of poolIds) {
    const probe = scores[id]
    const prior = priorFor(id)
    const merged = { ...prior }
    if (probe) {
      for (const cap of caps) {
        if (probe[cap] > 0) merged[cap] = probe[cap]
      }
    }
    out[id] = merged
  }
  return out
}

/**
 * Relay memory (2026-10-16, R-BS-29): relay outcomes teach the router.
 *
 * Every relay lane attempt records per (model, capability): won or not.
 * `applyRelayMemory` folds win rates into probe scores as a capped bonus,
 * so models that keep winning crew work get picked more — and models
 * that keep failing stop getting pieces. Probe scores stay the anchor
 * (bonus caps at +25, needs 2+ attempts); memory never invents skill,
 * it only adjusts proven skill.
 *
 * Pure except the tiny in-memory registry (same shape as model fit).
 */

import type { FitCapability, ModelScore } from '../model-router/model-capabilities'

export interface RelayMemoryEntry {
  wins: number
  attempts: number
}

export type RelayMemory = Record<string, RelayMemoryEntry>

export const RELAY_MEMORY_MAX_BONUS = 25
export const RELAY_MEMORY_MIN_ATTEMPTS = 2

let memory: RelayMemory = {}

export function memoryKey(modelId: string, capability: FitCapability): string {
  return `${modelId}::${capability}`
}

/** Record one lane attempt (pure registry write, never throws). */
export function recordRelayOutcome(
  modelId: string,
  capability: FitCapability,
  won: boolean,
): void {
  const key = memoryKey(modelId, capability)
  const entry = memory[key] ?? { wins: 0, attempts: 0 }
  entry.attempts += 1
  if (won) entry.wins += 1
  memory[key] = entry
}

export function getRelayMemory(): RelayMemory {
  return { ...memory }
}

export function clearRelayMemory(): void {
  memory = {}
}

const CAPS: FitCapability[] = ['reasoning', 'coding', 'vision', 'review', 'complete']

/**
 * Fold win rates into scores (pure): bonus = 25 x winRate per
 * capability once a model has 2+ attempts there, capped at 100 total.
 * Unknown models pass through untouched.
 */
export function applyRelayMemory(
  scores: Record<string, ModelScore>,
  mem: RelayMemory = getRelayMemory(),
): Record<string, ModelScore> {
  const out: Record<string, ModelScore> = {}
  for (const [id, score] of Object.entries(scores)) {
    const next = { ...score }
    for (const cap of CAPS) {
      const entry = mem[memoryKey(id, cap)]
      if (entry && entry.attempts >= RELAY_MEMORY_MIN_ATTEMPTS) {
        const bonus = Math.round(
          RELAY_MEMORY_MAX_BONUS * (entry.wins / entry.attempts),
        )
        next[cap] = Math.min(100, next[cap] + bonus)
      }
    }
    out[id] = next
  }
  return out
}

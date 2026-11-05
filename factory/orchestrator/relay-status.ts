/**
 * Relay live snapshot (2026-10-16, R-BM-25/R-BS-27): the running team
 * loop made visible. The orchestrator writes one snapshot per relay
 * round; `wednesday status` renders it. In-memory only (a restart
 * clears it); null means no relay round has run in this process.
 */

export interface RelaySnapshot {
  roundsUsed: number
  maxRounds: number
  open: string[]
  solved: number
  failed: string[]
  stuck: string[]
}

let snapshot: RelaySnapshot | null = null

export function setRelaySnapshot(value: RelaySnapshot | null): void {
  snapshot = value === null ? null : { ...value }
}

export function getRelaySnapshot(): RelaySnapshot | null {
  return snapshot === null ? null : { ...snapshot }
}

export function clearRelaySnapshot(): void {
  snapshot = null
}

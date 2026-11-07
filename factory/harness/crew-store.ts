/**
 * Crew store — named, resizable crew definitions.
 *
 * Hermes has one crew (trio/duo/solo). Wednesday lets the operator build as
 * many named crews as they want — solo, duo, trio, or a ten-seat bench — and
 * switch between them. A crew is a name plus a list of seats; each seat has a
 * role (the first three map to the factory's planner/coder/vision pipeline;
 * extras are display seats) and a model id. The active crew drives the
 * `✦` meter and the crew dock; switching crews re-sets the planner/coder/
 * vision env slots so the router follows.
 *
 * Stored in `~/.wednesday/state/crews.json` — never the repo.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME } from '../paths'
import {
  CREW_ROLES,
  crewRoleEnvName,
  crewSlotFor,
  normalizeCrewRole,
  resolveCrewModel,
  type CrewRole,
} from '../model-router/crew-routing'

export interface CrewSeat { role: string; model: string }

/**
 * How a crew WORKS, as opposed to who is in it (2026-11-05).
 *
 * A crew used to be a name plus a list of models, so two crews with the
 * same models were indistinguishable - and the things that actually decide
 * whether a run succeeds (how many repair rounds, how big a budget, which
 * shape the team takes) were ENV VARS with no UI at all. The operator was
 * "staffing a team" by picking models and nothing else.
 */
export interface CrewPolicy {
  /** The team shape: solo | duel | vote | relay. */
  shape?: string
  /** How many times a failing verification may be repaired. */
  maxRepairAttempts?: number
  /** A token ceiling for one run. */
  budgetTokens?: number
  /** A USD ceiling for one run. */
  budgetUsd?: number
  /** The verification command this crew always runs. */
  testCommand?: string
  /** Extra files every task in this crew must produce. */
  requiredFiles?: string[]
}

export interface Crew {
  id: string
  name: string
  seats: CrewSeat[]
  policy?: CrewPolicy
}

export interface CrewStore { crews: Crew[]; active: string | null }

function crewsFile(): string { return join(STATE_HOME, 'crews.json') }
function ensureDir(): void { try { mkdirSync(STATE_HOME, { recursive: true }) } catch { /* exists */ } }

export function loadCrews(): CrewStore {
  ensureDir()
  if (!existsSync(crewsFile())) return { crews: [], active: null }
  try {
    const raw = JSON.parse(readFileSync(crewsFile(), 'utf8'))
    if (!raw || !Array.isArray(raw.crews)) return { crews: [], active: null }
    return { crews: raw.crews, active: raw.active ?? null }
  } catch { return { crews: [], active: null } }
}

export function saveCrews(store: CrewStore): void {
  ensureDir()
  writeFileSync(crewsFile(), JSON.stringify(store, null, 2), 'utf8')
}

export function activeCrew(): Crew | null {
  const s = loadCrews()
  if (!s.active) return null
  return s.crews.find(c => c.id === s.active) ?? null
}

export function setActiveCrew(id: string | null): void {
  const s = loadCrews()
  s.active = id
  saveCrews(s)
}

export function addCrew(name: string, seats: CrewSeat[], policy?: CrewPolicy): Crew {
  const s = loadCrews()
  const crew: Crew = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    seats,
    ...(policy && Object.keys(policy).length > 0 ? { policy } : {}),
  }
  s.crews.push(crew)
  if (!s.active) s.active = crew.id
  saveCrews(s)
  return crew
}

export function updateCrew(
  id: string,
  patch: Partial<Pick<Crew, 'name' | 'seats' | 'policy'>>,
): Crew | null {
  const s = loadCrews()
  const idx = s.crews.findIndex(c => c.id === id)
  if (idx < 0) return null
  if (patch.name !== undefined) s.crews[idx].name = patch.name
  if (patch.seats !== undefined) s.crews[idx].seats = patch.seats
  // `'policy' in patch` and NOT `patch.policy !== undefined`: a CLEAR is
  // `undefined` on purpose. The old check could not tell "not mentioned"
  // from "explicitly cleared", so `/team reset` wrote the same policy back
  // and the team kept working the way the operator had just cleared.
  if ('policy' in patch) s.crews[idx].policy = patch.policy
  saveCrews(s)
  return s.crews[idx]
}

export function deleteCrew(id: string): boolean {
  const s = loadCrews()
  const before = s.crews.length
  s.crews = s.crews.filter(c => c.id !== id)
  if (s.crews.length === before) return false
  if (s.active === id) s.active = s.crews[0]?.id ?? null
  saveCrews(s)
  return true
}

/**
 * Apply an active crew to the env slots the router reads.
 *
 * BY ROLE, not by position (2026-11-05). This used to map the first three
 * seats onto planner/coder/vision IN ORDER, so a crew whose seats happened
 * to be [vision, coder, planner] silently became [planner, coder, vision] -
 * and every seat past the third was a display seat that routed nothing.
 * Now a seat says which ROLE it is, and that role decides the slot.
 *
 * A smaller crew CLEARS the slots it does not fill: switching a solo team
 * over a trio must never leave the trio's models answering silently.
 * `resolveCrewModel` treats '' as unset and falls back to the route default,
 * which is exactly the honest reading of "this team has no reviewer seat".
 */
export function applyCrew(crew: Crew): void {
  for (const role of CREW_ROLES) {
    process.env[crewRoleEnvName(role)] = ''
  }
  for (const seat of crew.seats) {
    const role = normalizeCrewRole(seat.role)
    if (!role) continue
    process.env[crewRoleEnvName(role)] = seat.model ?? ''
  }
  applyCrewPolicy(crew.policy)
}

/**
 * Apply a crew's POLICY to the env the orchestrator reads (pure-ish).
 *
 * A crew used to be a name plus a list of models, so "how does this team
 * work?" was an env var with no UI: solo/duel/vote/relay, the repair cap,
 * the token budget, the USD budget. The operator could staff WHO and never
 * HOW, and the shape they saw in `/status` was the session's env, not their
 * team's.
 *
 * The crew's policy now DRIVES those env slots, exactly the way the crew's
 * seats drive the model slots. A crew with no policy leaves the env alone -
 * the team's own setting must never silently override the operator's
 * profile for a team that has no opinion.
 */
export function applyCrewPolicy(policy: CrewPolicy | undefined): void {
  if (!policy) return
  const shape = (policy.shape ?? '').trim().toLowerCase()
  if (shape === 'relay') {
    process.env.FACTORY_RELAY = '1'
    process.env.FACTORY_EXPANSION = 'solo'
  } else if (shape === 'solo' || shape === 'duel' || shape === 'vote') {
    process.env.FACTORY_EXPANSION = shape
    process.env.FACTORY_RELAY = '0'
  } else if (shape === 'auto') {
    process.env.FACTORY_EXPANSION = 'auto'
    process.env.FACTORY_RELAY = '0'
  }
  if (policy.maxRepairAttempts !== undefined) {
    process.env.FACTORY_MAX_REPAIR_ATTEMPTS = String(policy.maxRepairAttempts)
  }
  if (policy.budgetTokens !== undefined) {
    process.env.FACTORY_BUDGET_TOKENS = String(policy.budgetTokens)
  }
  if (policy.budgetUsd !== undefined) {
    process.env.FACTORY_BUDGET_USD = String(policy.budgetUsd)
  }
}

/**
 * The policy's lines for a receipt or a status page (pure).
 *
 * Every line says what the value MEANS, so a stored policy is never a
 * mystery of numbers. A policy with nothing set says so in one line rather
 * than printing six empty rows.
 */
export function crewPolicyLines(policy: CrewPolicy | undefined): string[] {
  if (!policy) return ['shape: auto (the task difficulty decides)']
  const lines: string[] = []
  lines.push(`shape: ${(policy.shape ?? 'auto').trim() || 'auto'}`)
  if (policy.maxRepairAttempts !== undefined) {
    lines.push(`repairs: up to ${policy.maxRepairAttempts} round${policy.maxRepairAttempts === 1 ? '' : 's'}`)
  }
  if (policy.budgetTokens !== undefined) {
    lines.push(`budget: ${policy.budgetTokens.toLocaleString('en-US')} tokens`)
  }
  if (policy.budgetUsd !== undefined) {
    lines.push(`budget: $${policy.budgetUsd.toFixed(4)}`)
  }
  if (policy.testCommand) lines.push(`test: ${policy.testCommand}`)
  if (policy.requiredFiles && policy.requiredFiles.length > 0) {
    lines.push(`required: ${policy.requiredFiles.join(', ')}`)
  }
  return lines
}

/** The team shapes the factory knows how to run. */
export const CREW_SHAPES: readonly string[] = ['auto', 'solo', 'duel', 'vote', 'relay']

/**
 * Parse ONE `/team <setting> <value>` into a policy patch (pure).
 *
 * The grammar is deliberately one word per setting, so it works over a pipe
 * and can be checked without a terminal. Every refusal names the setting
 * and the accepted values: an operator who typed `/team shpae duel` must be
 * told what to type, not that something went wrong.
 *
 * A bad value NEVER half-applies: the patch is returned whole or not at all.
 */
export function parseTeamSetting(
  key: string,
  value: string,
): { ok: true; patch: CrewPolicy } | { ok: false; error: string } {
  const setting = key.trim().toLowerCase()
  const raw = value.trim()
  switch (setting) {
    case 'shape': {
      const shape = raw.toLowerCase()
      if (!CREW_SHAPES.includes(shape)) {
        return { ok: false, error: `Unknown shape: ${raw || '(nothing)'} (${CREW_SHAPES.join(', ')})` }
      }
      return { ok: true, patch: { shape } }
    }
    case 'repairs': {
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `Repairs must be a number >= 0 (got: ${raw || '(nothing)'})` }
      }
      return { ok: true, patch: { maxRepairAttempts: n } }
    }
    case 'tokens': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Token budget must be a number > 0 (got: ${raw || '(nothing)'})` }
      }
      return { ok: true, patch: { budgetTokens: Math.floor(n) } }
    }
    case 'usd': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `USD budget must be a number > 0 (got: ${raw || '(nothing)'})` }
      }
      return { ok: true, patch: { budgetUsd: n } }
    }
    case 'test': {
      if (!raw) return { ok: false, error: 'Usage: /team test "npm test"' }
      return { ok: true, patch: { testCommand: raw } }
    }
    case 'files': {
      if (!raw) return { ok: false, error: 'Usage: /team files src/a.ts,src/b.ts' }
      const files = raw.split(',').map(f => f.trim()).filter(Boolean)
      if (files.length === 0) {
        return { ok: false, error: 'Usage: /team files src/a.ts,src/b.ts' }
      }
      return { ok: true, patch: { requiredFiles: files } }
    }
    default:
      return { ok: false, error: `Unknown /team setting: ${setting || '(nothing)'} (shape, repairs, tokens, usd, test, files)` }
  }
}

/**
 * The model a crew puts in a seat (pure).
 *
 * The seat's OWN seat wins. Then a seat in the same ROUTING SLOT: the crew's
 * planner also serves the architect, its coder also serves the tester and
 * the reviewer. That folding is the legacy behaviour and it is what a crew
 * of three means in practice - but it is now VISIBLE (six named seats, three
 * of them shared) instead of being a silent surprise.
 *
 * Last resort: the env profile.
 *
 * The crew parameter is structural (`{ seats }`), so the status page can
 * pass the lighter shape it carries without pretending it is a stored crew.
 */
export function crewSeatModel(
  crew: { seats: CrewSeat[] } | null,
  role: CrewRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (crew) {
    const exact = crew.seats.find(seat => normalizeCrewRole(seat.role) === role)
    const exactModel = (exact?.model ?? '').trim()
    if (exactModel) return exactModel

    const slot = crewSlotFor(role)
    const inSlot = crew.seats.find(seat => {
      const seatRole = normalizeCrewRole(seat.role)
      return seatRole !== null && crewSlotFor(seatRole) === slot
    })
    const slotModel = (inSlot?.model ?? '').trim()
    if (slotModel) return slotModel
  }
  return resolveCrewModel(role, env)
}

/**
 * The seats of a crew that ACTUALLY ROUTE (pure).
 *
 * A seat routes when its role is one the factory runs. 'worker-4' and other
 * display names do not - and the count says so, because a plate that said
 * "6 seats" without saying so overstated what a run would use (operator,
 * 2026-11-04: the team had six seats and the status page named three).
 */
export function crewRoutingSeats(crew: { seats: CrewSeat[] } | null): CrewSeat[] {
  if (!crew) return []
  return crew.seats.filter(seat => normalizeCrewRole(seat.role) !== null)
}

export function crewSeatCount(crew: Crew | null): number {
  return crew ? crew.seats.length : 0
}

/**
 * How many of a crew's seats actually MAP TO A PIPELINE SEAT (pure).
 */
export function crewRoutingSeatCount(crew: { seats: CrewSeat[] } | null): number {
  return crewRoutingSeats(crew).length
}

/**
 * The seat count as the operator should read it: the total, and — when the
 * team carries display seats that do not route — how many actually do.
 *
 * "3 seats" for a trio. "6 seats · 3 route" for a team with extras.
 */
export function crewSeatSummary(crew: Crew | null): string {
  if (!crew) return '0 seats'
  const total = crew.seats.length
  const routing = crewRoutingSeatCount(crew)
  const noun = `seat${total === 1 ? '' : 's'}`
  return routing < total ? `${total} ${noun} · ${routing} route` : `${total} ${noun}`
}

export function crewMeterName(crew: Crew | null): string | null {
  if (!crew) return null
  const ids = [...new Set(crew.seats.map(s => s.model))]
  return ids.length === 1 ? ids[0] : `${crew.name} · ${crew.seats.length} seats`
}

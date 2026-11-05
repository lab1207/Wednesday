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

export interface CrewSeat { role: string; model: string }
export interface Crew {
  id: string
  name: string
  seats: CrewSeat[]
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

export function addCrew(name: string, seats: CrewSeat[]): Crew {
  const s = loadCrews()
  const crew: Crew = { id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name, seats }
  s.crews.push(crew)
  if (!s.active) s.active = crew.id
  saveCrews(s)
  return crew
}

export function updateCrew(id: string, patch: Partial<Pick<Crew, 'name' | 'seats'>>): Crew | null {
  const s = loadCrews()
  const idx = s.crews.findIndex(c => c.id === id)
  if (idx < 0) return null
  if (patch.name !== undefined) s.crews[idx].name = patch.name
  if (patch.seats !== undefined) s.crews[idx].seats = patch.seats
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

/** Apply an active crew to the env slots the router reads. */
export function applyCrew(crew: Crew): void {
  // First 3 seats map to planner/coder/vision. 2026-10-30 (teams are the
  // product): a smaller crew CLEARS the slots it does not fill — switching
  // a solo team over a trio must never leave the trio's models answering
  // silently. `resolveCrewModel` treats '' as unset and falls back to the
  // route default, which is exactly the honest reading of "this team has
  // no planner seat".
  const roles = ['FACTORY_CREW_PLANNER_MODEL', 'FACTORY_CREW_CODER_MODEL', 'FACTORY_CREW_VISION_MODEL']
  roles.forEach((env, i) => {
    process.env[env] = crew.seats[i]?.model ?? ''
  })
  // Extras are display seats (worker-4..N); they don't map to a pipeline role.
}

export function crewSeatCount(crew: Crew | null): number {
  return crew ? crew.seats.length : 0
}

/**
 * How many of a crew's seats actually MAP TO A PIPELINE SLOT (pure).
 *
 * Only the first three seats route (planner, coder, vision); the extras are
 * display seats the dock shows when an event names them. So a six-seat team
 * is three routing seats plus three display seats — and a plate that said
 * "6 seats" without saying so overstated what a run would use (operator,
 * 2026-11-04: the team had six seats and the status page named three).
 */
export function crewRoutingSeatCount(crew: Crew | null): number {
  if (!crew) return 0
  return Math.min(crew.seats.length, 3)
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

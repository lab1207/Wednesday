/**
 * PER-RUN MODEL POOLS (2026-11-16, operator decision).
 *
 * Until now the only team was the operator's active crew. The operator asked
 * for the other direction: a caller may bring a pool of models to one run —
 * "use this 3, 6 or 9" — and Wednesday assigns the seats. The operator still
 * owns the DEFAULT crew; a pool is a per-run override, recorded on the job,
 * never a new tool per seat.
 *
 * WHAT A POOL CANNOT DO: it cannot bring credentials. A model id that needs a
 * provider key Wednesday does not hold is refused BEFORE the job is queued,
 * with the env var named. MCP moves requests, not keys.
 *
 * The assignment is deliberately deterministic: role hints in the model id
 * (vision/coder/reasoning/guard) break ties, then the least-used model wins.
 * The same pool and the same roles produce the same seats on every machine.
 */
import {
  CREW_ROLES,
  normalizeCrewRole,
  splitProviderPin,
} from '../model-router/crew-routing'
import type { CrewSeat } from './crew-store'

/** The env var each hosted provider needs before a pinned model can run. */
const PROVIDER_KEY: Partial<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  zen: 'ZEN_API_KEY',
}

const VISION_HINT =
  /(^|[/_.-])(vl|vision|image|multimodal|paligemma|llava)([/_.-]|$)|gemma-3/i
const CODER_HINT = /coder|starcoder|codex|qwen.*code|deepseek.*code/i
const REASON_HINT =
  /reason|thinking|(^|[/_.-])r1([/_.-]|$)|(^|[/_.-])o[134]([/_.-]|$)|ultra|deepseek-v4|qwen3|nemotron|(^|[/_.-])pro([/_.-]|$)/i
const SECURITY_HINT = /guard|safety|security/i

/**
 * Can Wednesday actually call this model?
 *
 * `local/…` is always accepted: it needs no credential, and whether the
 * server is up is a run-time fact, not a validation one. An unpinned id is
 * accepted only when the default route itself is local.
 */
export function modelAccess(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason?: string } {
  const id = (model ?? '').trim()

  if (!id) {
    return { ok: false, reason: 'empty model id' }
  }

  const pin = splitProviderPin(id)

  if (!pin) {
    const route = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
    if (route === 'local') {
      return { ok: true }
    }
    return {
      ok: false,
      reason:
        `"${id}" is not provider-pinned; use openrouter/…, nvidia/…, ` +
        'zen/… or local/…',
    }
  }

  if (pin.provider === 'local') {
    return { ok: true }
  }

  const key = PROVIDER_KEY[pin.provider]

  if (key && !(env[key] ?? '').trim()) {
    return {
      ok: false,
      reason:
        `${pin.provider} is not ready: ${key} is not set in ` +
        "~/.wednesday/.env (Wednesday cannot use another app's key)",
    }
  }

  return { ok: true }
}

/**
 * Validate a whole pool at once, so the caller gets every bad id in one
 * error instead of fixing them one run at a time.
 */
export function checkModels(
  models: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const seen = new Set<string>()
  const errors: string[] = []

  for (const raw of models) {
    const id = (raw ?? '').trim()
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)

    const access = modelAccess(id, env)
    if (!access.ok) {
      errors.push(access.reason ?? `${id} is not reachable`)
    }
  }

  return errors
}

/** How strongly a model id suggests it belongs in a role (deterministic). */
function score(model: string, role: string): number {
  if (role === 'vision') {
    return (VISION_HINT.test(model) ? 5 : 0) + (CODER_HINT.test(model) ? 1 : 0)
  }

  if (role === 'security-audit') {
    return (SECURITY_HINT.test(model) ? 4 : 0) + (REASON_HINT.test(model) ? 2 : 0)
  }

  if (
    role === 'coder' ||
    role === 'tester' ||
    role === 'bug-hunter' ||
    role === 'autocomplete'
  ) {
    return (CODER_HINT.test(model) ? 4 : 0) + (REASON_HINT.test(model) ? 1 : 0)
  }

  // architect, planner, reviewer
  return (REASON_HINT.test(model) ? 3 : 0) + (CODER_HINT.test(model) ? 1 : 0)
}

/**
 * Assign a pool to every seat, role first.
 *
 * Each role picks the best-scoring model; ties go to the least-used model, so
 * a 3-model pool covers the whole team instead of putting one model in every
 * seat. `vision` prefers a VL id, coding seats prefer a coder id, and the
 * reasoning seats take the strongest reasoning hint.
 */
export function assignPool(models: readonly string[]): CrewSeat[] {
  const pool = [
    ...new Set(
      models
        .map(model => (model ?? '').trim())
        .filter(Boolean),
    ),
  ]

  if (pool.length === 0) {
    return []
  }

  const used = new Map<string, number>()

  return CREW_ROLES.map(role => {
    let best = pool[0]
    let bestScore = -1
    let bestUsed = Number.POSITIVE_INFINITY

    for (const model of pool) {
      const value = score(model, role)
      const count = used.get(model) ?? 0

      if (value > bestScore || (value === bestScore && count < bestUsed)) {
        best = model
        bestScore = value
        bestUsed = count
      }
    }

    used.set(best, (used.get(best) ?? 0) + 1)

    return { role, model: best }
  })
}

/** Normalize stored seats to real role names (unknown roles are dropped). */
export function normalizeSeatList(seats: readonly CrewSeat[]): CrewSeat[] {
  const out: CrewSeat[] = []

  for (const seat of seats) {
    const role = normalizeCrewRole(seat.role)
    if (!role) {
      continue
    }
    out.push({ role, model: (seat.model ?? '').trim() })
  }

  return out
}

/**
 * Parse the host's `seats` object. Errors name the unknown role and list the
 * roles that exist, because "invalid seats" is not an actionable message.
 */
export function parseSeatOverrides(raw: unknown): {
  seats: CrewSeat[]
  errors: string[]
} {
  if (raw === undefined) {
    return { seats: [], errors: [] }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      seats: [],
      errors: ['seats must be an object of role -> model'],
    }
  }

  const seats: CrewSeat[] = []
  const errors: string[] = []

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const role = normalizeCrewRole(key)

    if (!role) {
      errors.push(
        `Unknown seat role "${key}" (${CREW_ROLES.join(', ')})`,
      )
      continue
    }

    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`Seat "${key}" needs a model id`)
      continue
    }

    seats.push({ role, model: value.trim() })
  }

  return { seats, errors }
}

/** Overlay explicit seats on a base roster, in pipeline order. */
export function mergeSeats(
  base: readonly CrewSeat[],
  overrides: readonly CrewSeat[],
): CrewSeat[] {
  const byRole = new Map<string, CrewSeat>()

  for (const seat of normalizeSeatList(base)) {
    byRole.set(seat.role, seat)
  }

  for (const seat of overrides) {
    byRole.set(seat.role, seat)
  }

  return CREW_ROLES.flatMap(role => {
    const seat = byRole.get(role)
    return seat ? [seat] : []
  })
}

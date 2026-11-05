/**
 * Crew routing for the Colab trio (2026-09-23, offline-green).
 *
 * The T4 holds one Q4 model at a time, so each pipeline role pins the
 * member that owns it (mirrors the Crew 1 catalog in
 * `factory/benchmark/public/scoreboard.ts`): R1-7B plans
 * (architect/planner + strategy-change repairs), Coder-3B types
 * (coder/tester/reviewer + all repair retries), VL-7B sees
 * (vision, on demand only). Env overrides swap ids without code
 * changes. `stripThinking` removes R1 `<think>` leakage before text
 * flows downstream.
 *
 * The swapper HTTP call itself stays pending-live: no Colab endpoint
 * spec exists yet, and an unprovable wire protocol is not shipped.
 * This file carries the provable halves (role map + strip).
 */

export const TRIO_PLANNER_MODEL = 'DeepSeek-R1-Distill-Qwen-7B'
export const TRIO_CODER_MODEL = 'Qwen2.5-Coder-3B-Instruct'
export const TRIO_VISION_MODEL = 'Qwen2.5-VL-7B-Instruct'

export const LOCAL_DEFAULT_BASE_URL = 'http://127.0.0.1:1337/v1'

/**
 * Known provider prefixes for seat/route ids (2026-10-31, provider-agnostic
 * crews): `openrouter/…`, `nvidia/…`, `zen/…`, `local/…` pin the provider
 * per call; anything after the prefix is that provider's model id.
 * Single source of truth — the harness re-exports it for validation.
 */
export const PROVIDER_PREFIXES = ['openrouter', 'nvidia', 'zen', 'local'] as const

/** Split a `provider/model` pin into its parts; undefined when unpinned. */
export function splitProviderPin(
  id: string,
): { provider: (typeof PROVIDER_PREFIXES)[number]; model: string } | undefined {
  const trimmed = id.trim()
  const sep = trimmed.indexOf('/')
  if (sep <= 0) return undefined
  const head = trimmed.slice(0, sep) as (typeof PROVIDER_PREFIXES)[number]
  if (!PROVIDER_PREFIXES.includes(head)) return undefined
  return { provider: head, model: trimmed.slice(sep + 1) }
}

export type CrewRole = 'planner' | 'coder' | 'vision'

/** Pipeline role → trio slot (pure). Unknown roles land on the coder. */
export function crewSlotFor(role: string): CrewRole {
  const normalized = role.trim().toLowerCase()
  if (normalized === 'architect' || normalized === 'planner') return 'planner'
  if (normalized === 'vision') return 'vision'
  return 'coder'
}

/** Trio pool connected (pure): any per-slot model or tunnel override present. */
export function isCrewPoolConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [
    'FACTORY_CREW_PLANNER_MODEL',
    'FACTORY_CREW_CODER_MODEL',
    'FACTORY_CREW_VISION_MODEL',
    'FACTORY_CREW_PLANNER_BASE_URL',
    'FACTORY_CREW_CODER_BASE_URL',
    'FACTORY_CREW_VISION_BASE_URL',
  ].some(name => (env[name] ?? '').trim().length > 0)
}

/** Model id for a pipeline role, env-overridable per slot (pure). */
export function resolveCrewModel(
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const slot = crewSlotFor(role)
  if (slot === 'planner') {
    return (env.FACTORY_CREW_PLANNER_MODEL ?? '').trim() || TRIO_PLANNER_MODEL
  }
  if (slot === 'vision') {
    return (env.FACTORY_CREW_VISION_MODEL ?? '').trim() || TRIO_VISION_MODEL
  }
  return (env.FACTORY_CREW_CODER_MODEL ?? '').trim() || TRIO_CODER_MODEL
}

/**
 * Provider pin for a role's crew seat (pure, 2026-10-31): the seat's
 * env-overridden model id when one is set, else undefined. Seat ids may
 * carry a `provider/` prefix (openrouter/ nvidia/ zen/ local/) so one
 * crew can mix providers; the router strips the prefix per call.
 */
export function seatModelPin(
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const slot = crewSlotFor(role)
  const name =
    slot === 'planner' ? 'FACTORY_CREW_PLANNER_MODEL'
      : slot === 'vision' ? 'FACTORY_CREW_VISION_MODEL'
        : 'FACTORY_CREW_CODER_MODEL'
  const value = (env[name] ?? '').trim()
  if (value.length === 0) return undefined
  // An already-pinned id is authoritative.
  if (splitProviderPin(value)) return value
  // A bare id belongs to the LOCAL route when its seat has its own endpoint
  // (or when the session route itself is local). Without this, selecting a
  // hosted route sent the seat's bare `qwen2.5-coder-3b-instruct` to that
  // host — and the worker's config then force-routed it to a keyless local
  // profile, which is the 2026-11-05 `no credential for provider route
  // "local"` failure. A bare id with no local endpoint stays legacy (the
  // route provider owns it), so hosted-only profiles are unchanged.
  const baseName =
    slot === 'planner' ? 'FACTORY_CREW_PLANNER_BASE_URL'
      : slot === 'vision' ? 'FACTORY_CREW_VISION_BASE_URL'
        : 'FACTORY_CREW_CODER_BASE_URL'
  const seatBase = (env[baseName] ?? '').trim()
  const routeIsLocal = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() === 'local'
  const localBase = seatBase || (routeIsLocal ? (env.LOCAL_LLM_BASE_URL ?? '').trim() : '')
  return localBase ? `local/${value}` : value
}

function cleanBase(value: string | undefined, fallback: string): string {
  return ((value ?? '').trim() || fallback).replace(/\/+$/, '')
}

/** Default tunnel for the local route (pure): coder box unless overridden. */
export function resolveLocalBaseURL(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return cleanBase(
    env.LOCAL_LLM_BASE_URL ?? env.FACTORY_CREW_CODER_BASE_URL,
    LOCAL_DEFAULT_BASE_URL,
  )
}

/**
 * Tunnel for a trio slot (pure). Each slot points at its own ngrok
 * tunnel: planner/coder usually share box A (two ids, one endpoint),
 * vision sits on box B — but any layout works since every slot is
 * independently overridable. Falls back to the default tunnel.
 */
export function resolveCrewBaseURL(
  slot: CrewRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const local = (env.LOCAL_LLM_BASE_URL ?? '').trim()
  const localIsProxy = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(local)
  if (localIsProxy) {
    return cleanBase(local, LOCAL_DEFAULT_BASE_URL)
  }
  const fallback = resolveLocalBaseURL(env)
  if (slot === 'planner') {
    return cleanBase(env.FACTORY_CREW_PLANNER_BASE_URL, fallback)
  }
  if (slot === 'vision') {
    return cleanBase(env.FACTORY_CREW_VISION_BASE_URL, fallback)
  }
  return cleanBase(env.FACTORY_CREW_CODER_BASE_URL, fallback)
}

/**
 * Tunnel for a concrete model id (pure): with a configured pool, matches
 * the id against the slot catalogs and returns that slot's tunnel;
 * without a pool (or for unknown ids) uses the single default tunnel —
 * legacy single-server behavior is byte-identical.
 */
export function crewBaseURLForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isCrewPoolConfigured(env)) return resolveLocalBaseURL(env)
  const id = model.trim()
  if (id && id === resolveCrewModel('planner', env)) {
    return resolveCrewBaseURL('planner', env)
  }
  if (id && id === resolveCrewModel('vision', env)) {
    return resolveCrewBaseURL('vision', env)
  }
  return resolveCrewBaseURL('coder', env)
}

/**
 * Thinking-strip (pure): removes R1 `<think>…</think>` reasoning blocks
 * (including an unclosed trailing block from a cutoff stream) plus any
 * stray think tags. Text without think markup passes through untouched.
 */
export function stripThinking(text: string): string {
  return (
    text
      // Closed blocks first.
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // An unclosed trailing block (cutoff stream) runs to the end.
      .replace(/<think>[\s\S]*$/gi, '')
      // Stray tags of either kind.
      .replace(/<\/?think>/gi, '')
  ).trim()
}

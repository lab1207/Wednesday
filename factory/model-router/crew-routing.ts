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

/**
 * The THREE ROUTING SLOTS (2026-11-05).
 *
 * A slot is where a model LIVES: the trio has always been planner / coder /
 * vision, each with its own endpoint (a T4 holds one Q4 model at a time, so
 * each slot points at a different box). The slots did not change.
 */
export type CrewSlot = 'planner' | 'coder' | 'vision'

/**
 * The SEATS - the roles the factory actually runs.
 *
 * This is the honest list (2026-11-05). The factory's pipeline is
 * architect -> planner -> coder -> tester -> reviewer (plus vision on
 * demand), but the operator could only staff THREE seats, and
 * `crewSlotFor` folded everything that was not 'architect', 'planner' or
 * 'vision' onto the CODER. That is how the TESTER and the REVIEWER ended up
 * running on the coder's model: one model typed the code, ran the tests, and
 * signed off on its own work. A team of one wearing three name tags.
 *
 * Now every seat can have its own model, and the legacy mapping is kept as
 * the FALLBACK so an unchanged profile behaves exactly as before.
 */
export type CrewRole =
  | 'architect'
  | 'planner'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'vision'

/** Every seat the factory runs, in pipeline order. */
export const CREW_ROLES: readonly CrewRole[] = [
  'architect',
  'planner',
  'coder',
  'tester',
  'reviewer',
  'vision',
]

/** The env var that holds a seat's model. */
export function crewRoleEnvName(role: CrewRole): string {
  return `FACTORY_CREW_${role.toUpperCase()}_MODEL`
}

/** The env var that holds a seat's endpoint. */
export function crewRoleBaseEnvName(role: CrewRole): string {
  return `FACTORY_CREW_${role.toUpperCase()}_BASE_URL`
}

/**
 * Is this string one of the real seats? (pure)
 *
 * A crew seat called 'worker-4' is a DISPLAY seat - it has no pipeline role
 * and therefore no model slot. Saying so is the point.
 */
export function normalizeCrewRole(role: string): CrewRole | null {
  const normalized = role.trim().toLowerCase()
  return (CREW_ROLES as readonly string[]).includes(normalized)
    ? (normalized as CrewRole)
    : null
}

/**
 * Pipeline role -> routing SLOT (pure).
 *
 * The slot says where the model lives; the seat says what the model is
 * FOR. `tester` and `reviewer` share the coder's slot by default (that is
 * the legacy behavior), `architect` shares the planner's.
 */
export function crewSlotFor(role: string): CrewSlot {
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

/**
 * The model for a seat, with the legacy slot fallback (pure).
 *
 * The chain is: this seat's own model, then the slot's model, then the
 * trio default. So a profile that only sets the three old slots behaves
 * EXACTLY as it did (the tester and the reviewer still run on the coder's
 * model), while a crew that staffs a reviewer gets its own model.
 */
export function resolveCrewModel(
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seat = normalizeCrewRole(role)
  const own = seat
    ? (env[crewRoleEnvName(seat)] ?? '').trim()
    : ''
  if (own.length > 0) return own

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
  const seat = normalizeCrewRole(role)
  const slot = crewSlotFor(role)
  const slotModelName =
    slot === 'planner' ? 'FACTORY_CREW_PLANNER_MODEL'
      : slot === 'vision' ? 'FACTORY_CREW_VISION_MODEL'
        : 'FACTORY_CREW_CODER_MODEL'

  // The seat's own model wins; the slot's model is the legacy fallback.
  const value = seat
    ? (env[crewRoleEnvName(seat)] ?? '').trim() || (env[slotModelName] ?? '').trim()
    : (env[slotModelName] ?? '').trim()
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
  const slotBaseName =
    slot === 'planner' ? 'FACTORY_CREW_PLANNER_BASE_URL'
      : slot === 'vision' ? 'FACTORY_CREW_VISION_BASE_URL'
        : 'FACTORY_CREW_CODER_BASE_URL'
  const seatBase = seat
    ? (env[crewRoleBaseEnvName(seat)] ?? '').trim() || (env[slotBaseName] ?? '').trim()
    : (env[slotBaseName] ?? '').trim()
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
 * Thinking-strip (pure): removes reasoning blocks the model leaked into its
 * answer - R1's `<think>…</think>` (including an unclosed trailing block from
 * a cutoff stream), plus the other spellings the small reasoning models use.
 *
 * The list grew in 2026-11-05 because the strip was too narrow: it only knew
 * `<think>`, so a `<thinking>` block, a Qwen `<|thinking|>` block, or a stray
 * `</think>` in the middle of a paragraph all survived - and a surviving
 * scratchpad is a surviving broken JSON verdict.
 */
export function stripThinking(text: string): string {
  const blocks = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<thought>[\s\S]*?<\/thought>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<\|thinking\|>[\s\S]*?<\/\|thinking\|>/gi,
    /<\|\/thinking\|>[\s\S]*?<\/\|thinking\|>/gi,
  ]
  const openers = [
    /<think>[\s\S]*$/gi,
    /<thinking>[\s\S]*$/gi,
    /<thought>[\s\S]*$/gi,
    /<reasoning>[\s\S]*$/gi,
    /<\|thinking\|>[\s\S]*$/gi,
  ]
  const tags =
    /<\/?(?:think|thinking|thought|reasoning|\|thinking\||\/thinking\|)>/gi

  let out = text
  for (const block of blocks) out = out.replace(block, '')
  for (const opener of openers) out = out.replace(opener, '')
  return out.replace(tags, '').trim()
}

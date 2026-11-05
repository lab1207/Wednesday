/**
 * `wednesday status` (2026-10-13): one screen of what this machine will
 * do — route, active model, pool, mixer, work shape. Pure render over
 * env; never prints key VALUES (set/unset only).
 *
 * Hermes grammar (2026-10-25): a `Wednesday Status` heading, a blank line, then
 * `Field: value` rows — the shape its `/status` answers with. Lowercase
 * `key: value` prose read as a log dump beside it.
 */
import { parseModelPool } from '../model-router/model-capabilities'
import { parseModelRegistry, resolveActiveModel } from '../model-router/model-switch'
import { parseModelWeights, weightFor } from '../model-router/model-weights'
import { resolveCrewModel } from '../model-router/crew-routing'
import { resolveChatRoute, seatFitsRoute } from '../model-router/chat-stream'
import { getRelaySnapshot } from '../orchestrator/relay-status'
import type { RelaySnapshot } from '../orchestrator/relay-status'

function keyState(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim() ? 'set' : 'unset'
}

/** Session facts only the live harness knows; absent for the CLI subcommand. */
export interface StatusContext {
  sessionId?: string
  tokens?: number
  busy?: boolean
  /** Workspace the session runs against (Hermes' `Path:` row). */
  path?: string
}

/**
 * The active team, as the caller knows it.
 *
 * Passed in rather than read from disk: this renderer is pure over its
 * inputs, and a status page that read the crew store behind the caller's
 * back would show a different answer in the session than in a test.
 */
export interface StatusCrew {
  name: string
  seats: Array<{ role: string; model: string }>
}

/**
 * The two model paths, named.
 *
 * A QUESTION and a BUILD go to different places, and the operator asked why.
 * The answer is in the product, not only in a reply: `Chat` is the one model
 * a conversation turn speaks to (the team's first seat, else the route
 * model), and `Build` is the set of models the pipeline seats use. One model
 * can fill both — a team whose seats all name the same model is exactly
 * that — but the routes are separate, because a build needs a workspace, tools
 * and verification, and a chat turn needs none of them.
 *
 * The CHAT row is resolved through the SAME resolver the chat turn uses
 * (`resolveChatRoute` + `seatFitsRoute`), because a row that names a model
 * the conversation would not actually speak to is a lie: on a hosted route a
 * bare seat id (no `/`) does not fit, and the turn falls back to the route's
 * model. A blocked route says BLOCKED, not a model that cannot be used.
 */
export function statusModelPaths(
  env: NodeJS.ProcessEnv,
  crew: StatusCrew | null,
): { chat: string; build: string } {
  const seat = crew?.seats[0]?.model?.trim() ?? ''
  const resolved = resolveChatRoute(seat || null, env)
  let chat: string
  if ('blocker' in resolved) {
    chat = `(blocked — ${resolved.blocker})`
  } else {
    const fits = !!seat && seatFitsRoute(resolved.route, seat)
    const model = (fits ? seat : resolved.route.model).trim()
    chat = model || '(unset — /model)'
    if (seat && !fits) chat += ` (seat ${seat} does not fit the ${resolved.route.name} route)`
  }
  // The build seats resolve EXACTLY as the pipeline resolves them: the team's
  // seat by position, else the env slot, else the built-in default. A status
  // page that named anything else would be a second opinion about the routing.
  const roles = ['planner', 'coder', 'vision']
  const seats = roles.map((role, index) => ({
    role,
    model: crew?.seats[index]?.model?.trim() || resolveCrewModel(role, env),
  }))
  const models = [...new Set(seats.map(s => s.model).filter(Boolean))]
  const slots = seats.map(s => `${s.role}=${s.model}`).join(' ')
  // A team is named, so the operator can see WHICH team the build speaks for.
  // Only the three routing slots are listed: a team's extra seats are display
  // seats and never answer a pipeline stage (see `crewSeatSummary`).
  if (crew) {
    const label = models.length === 1 ? `${models[0]} (3 slots)` : slots
    return { chat, build: `${crew.name} · ${label}` }
  }
  const label = models.length === 1 ? `${models[0]} (all roles)` : slots
  return { chat, build: label }
}

/** One status screen (pure over env + an explicit relay snapshot). */
export function renderStatus(
  env: NodeJS.ProcessEnv = process.env,
  relay: RelaySnapshot | null = getRelaySnapshot(),
  ctx: StatusContext = {},
  crew: StatusCrew | null = null,
): string {
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || 'openrouter (default)'
  const lines: string[] = ['Wednesday Status', '']
  if (ctx.sessionId) lines.push(`Session ID: ${ctx.sessionId}`)
  lines.push(`Path: ${ctx.path ?? process.cwd()}`)
  lines.push(`Route: ${provider}`)
  if (provider === 'local') {
    lines.push(`Endpoint: ${(env.LOCAL_LLM_BASE_URL ?? '').trim() || '(default 127.0.0.1:1337)'}`)
    lines.push(`Model: ${(env.LOCAL_LLM_MODEL ?? '').trim() || '(default)'}`)
    // A hosted OpenAI-compatible endpoint needs its real key; a loopback box
    // ignores it (2026-11-01: "local" is any compatible endpoint, not only
    // one on this machine).
    const loopback = /^$|^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test((env.LOCAL_LLM_BASE_URL ?? '').trim())
    const localKey = (env.LOCAL_LLM_API_KEY ?? '').trim()
    lines.push(loopback
      ? `Key: ${keyState(env, 'LOCAL_LLM_API_KEY')} (any non-empty works — a local server asks no credential)`
      : `Key: ${localKey && localKey !== 'local' ? 'present' : 'MISSING'} (hosted endpoint — needs the provider key)`)
  } else if (provider === 'nvidia') {
    lines.push(`Model: ${(env.NVIDIA_LLM_MODEL ?? '').trim() || '(server default)'}`)
    lines.push(`Key: ${keyState(env, 'NVIDIA_API_KEY')}`)
  } else if (provider === 'zen') {
    lines.push(`Key: ${keyState(env, 'ZEN_API_KEY')}`)
  } else {
    lines.push(`Model: ${(env.DSH_LLM_MODEL ?? '').trim() || '(unset — /model or --setup)'}`)
    lines.push(`Key: ${keyState(env, 'OPENROUTER_API_KEY')}`)
  }
  const registry = parseModelRegistry(env)
  const active = resolveActiveModel(env, registry)
  lines.push(
    active
      ? `Active: ${active.name} (${active.provider}/${active.id})`
      : `Active: (none — ${registry.length} saved, pick with FACTORY_ACTIVE_MODEL)`,
  )
  lines.push(`Registry: ${registry.length} saved model${registry.length === 1 ? '' : 's'}`)
  const pool = parseModelPool(env)
  if (pool.length > 0) {
    const weights = parseModelWeights(env, pool.map(model => model.id))
    const shares = pool
      .map(model => `${model.id}:${weightFor(model.id, weights)}`)
      .join(', ')
    lines.push(`Pool: ${pool.length} model${pool.length === 1 ? '' : 's'} (${shares})`)
  } else {
    lines.push('Pool: solo (no FACTORY_MODEL_POOL — one model, all roles)')
  }
  lines.push(`Shape: ${(env.FACTORY_EXPANSION ?? 'auto').trim() || 'auto'} (solo/duel/vote/off)`)
  // The two paths, named. A question speaks to ONE model; a build runs the
  // pipeline. The operator asked why they differ — the page answers it.
  const paths = statusModelPaths(env, crew)
  lines.push(`Chat: ${paths.chat}`)
  lines.push(`Build: ${paths.build}`)
  if (relay) {
    const openBit = relay.open.length > 0 ? `open ${relay.open.length} (${relay.open.slice(0, 6).join(', ')})` : 'open 0'
    const stuckBit = relay.stuck.length > 0 ? ` STUCK ${relay.stuck.slice(0, 6).join(', ')}` : ''
    lines.push(`Relay: round ${relay.roundsUsed}/${relay.maxRounds} · ${openBit} · solved ${relay.solved} · failed ${relay.failed.length}${stuckBit}`)
  } else {
    lines.push(
      (env.FACTORY_RELAY ?? '').trim() === '1'
        ? 'Relay: on (no round yet this process)'
        : 'Relay: off (FACTORY_RELAY=1 to team up)',
    )
  }
  if (ctx.tokens !== undefined) lines.push(`Tokens: ${ctx.tokens.toLocaleString('en-US')}`)
  if (ctx.busy !== undefined) lines.push(`Agent Running: ${ctx.busy ? 'Yes' : 'No'}`)
  return lines.join('\n')
}

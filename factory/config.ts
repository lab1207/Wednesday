import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { parseEnv } from 'node:util'
import { PROVIDER_PREFIXES } from './model-router/crew-routing'
import { redactSensitiveText } from './security/redaction'

// Credentials belong to the user's profile, never the project or task store.
export const CONFIG_PATH = join(homedir(), '.wednesday', '.env')
const LEGACY_CONFIG_PATH = join(homedir(), '.ai-software-factory', '.env')
export { PROVIDER_PREFIXES }

/**
 * Model ids are route-shaped: hosted routes name `provider/model`, a local
 * OpenAI-compatible server names whatever its `/models` endpoint reports
 * (`qwen2.5-coder-3b-instruct` has no slash). Rejecting the local shape made
 * `/model` unable to switch to a model the palette itself was showing.
 */
/**
 * Known provider prefixes for seat/route ids (2026-10-31, provider-agnostic
 * crews): `openrouter/…`, `nvidia/…`, `zen/…`, `local/…` pin the provider
 * per call; anything after the prefix is that provider's model id.
 * Re-exported from the model router so validation and routing share one list.
 */
// (PROVIDER_PREFIXES imported and re-exported above)

export function validateModel(model: string, provider = process.env.FACTORY_LLM_PROVIDER): void {
  const id = model.trim()
  const prefix = PROVIDER_PREFIXES.find(p => id.startsWith(`${p}/`))
  if (prefix !== undefined) {
    const rest = id.slice(prefix.length + 1)
    if (!/^[a-zA-Z0-9._:/-]+$/.test(rest)) {
      throw new Error(`After "${prefix}/" enter the model id (letters, digits, . _ : - /; no spaces).`)
    }
    return
  }
  const local = (provider ?? '').trim().toLowerCase() === 'local'
  const ok = local
    ? /^[a-zA-Z0-9._:-]+(\/[a-zA-Z0-9._:/-]+)?$/.test(id)
    : /^[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._:/-]+$/.test(id)
  if (!ok) {
    throw new Error(local
      ? 'Enter a model id (letters, digits, . _ : -; no spaces) — or pin a provider: openrouter/…, nvidia/…, zen/…, local/….'
      : 'Enter a model id such as provider/model, or pin a provider: openrouter/…, nvidia/…, zen/…, local/… (no spaces).')
  }
}

export async function saveConfig(key: string, model: string, path = CONFIG_PATH): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{16,}$/.test(key)) throw new Error('Invalid API key format (value not displayed).')
  validateModel(model, 'openrouter')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Never overwrite an existing file or follow an existing file symlink.
  await writeFile(path, `OPENROUTER_API_KEY=${key}\nDSH_LLM_MODEL=${model}\n`, { flag: 'wx', mode: 0o600 })
}

export async function loadConfig(
  path = CONFIG_PATH,
  env = process.env,
  legacyPath = path === CONFIG_PATH ? LEGACY_CONFIG_PATH : undefined,
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Preserve existing installations; never copy, overwrite or print keys.
      if (legacyPath) await loadConfig(legacyPath, env, undefined)
      return
    }
    throw new Error('Cannot read Wednesday user configuration; check file permissions.')
  }
  const config = parseEnv(raw)
  // Whitelist: user config cannot set execution mode, task paths or NODE_OPTIONS.
  // Operator-rig knobs (trio routing + work shapes) load here too: without
  // them every loadConfig entry point silently falls back to single-server,
  // which would fake trio evidence. Same sensitivity class as LOCAL_*.
  for (const name of [
    'OPENROUTER_API_KEY',
    'DSH_LLM_MODEL',
    'FACTORY_LLM_PROVIDER',
    'LOCAL_LLM_BASE_URL',
    'LOCAL_LLM_MODEL',
    'LOCAL_LLM_API_KEY',
    'LOCAL_TOOL_PROXY_UPSTREAM',
    'FACTORY_CREW_PLANNER_MODEL',
    'FACTORY_CREW_PLANNER_BASE_URL',
    'FACTORY_CREW_CODER_MODEL',
    'FACTORY_CREW_CODER_BASE_URL',
    'FACTORY_CREW_VISION_MODEL',
    'FACTORY_CREW_VISION_BASE_URL',
    'FACTORY_EXPANSION',
    'FACTORY_CAPTAIN',
    'FACTORY_RECOVERY_ROUNDS',
    'ZEN_API_KEY',
    'ZEN_BASE_URL',
    'ZEN_MODEL',
    // The NVIDIA triple (2026-10-05). It was missing while ZEN_* was present,
    // so a key saved in the profile file was silently DISCARDED and the run
    // reported `NVIDIA_API_KEY is not set` with the key sitting unread two
    // hundred lines away in `~/.wednesday/.env`. A whitelist hole is the worst
    // shape of this bug: it looks exactly like an operator mistake.
    'NVIDIA_API_KEY',
    'NVIDIA_LLM_MODEL',
    'NVIDIA_BASE_URL',
    // Model switcher + fit rig (2026-10-13, 1-model release). Same B88
    // lesson: a missing line here silently discards a saved value and
    // the failure looks exactly like operator error.
    'FACTORY_MODELS',
    'FACTORY_ACTIVE_MODEL',
    'FACTORY_MODEL_POOL',
    'FACTORY_MODEL_WEIGHTS',
    'FACTORY_TRYOUT_MIN_PASS',
    'FACTORY_TRYOUT_MIN_REVIEW',
  ]) {
    if (env[name] === undefined && config[name]) env[name] = config[name]
  }
}

/**
 * A named, actionable reason a run cannot start — never a thrown string.
 *
 * This whole module used to be `requireLiveConfig()`: a boolean-ish gate that
 * only the CLASSIC approval path called. Three real defects followed, and an
 * operator hit all three at once ("NVIDIA_API_KEY is not set", then pressing
 * `y` appeared to do nothing):
 *
 *   1. The screen (real terminal) path NEVER called it. A session with no
 *      usable credential still built and showed an approval card; `y` submitted
 *      the task, the architect died on the missing key, and `/run <id>` offered
 *      a byte-identical card for a run that could not possibly succeed. That is
 *      what "y does nothing" looks like from the chair: the gate is not broken,
 *      it is ABSENT.
 *   2. `FACTORY_LLM_PROVIDER=nvidia` fell through to the OpenRouter branch, so
 *      the gate asked for a key the chosen route does not use — and waved a run
 *      through when an unrelated OpenRouter key happened to be set.
 *   3. `NVIDIA_API_KEY` was missing from the loadConfig whitelist (above), so a
 *      correctly saved key was discarded before it could be read.
 *
 * A blocker is returned rather than thrown so the operator gets a NAME and a
 * REMEDY, so the same classification can be applied to a failure that already
 * happened (`configBlockerIn`), and so a doomed approval is never shown.
 */
export interface ConfigBlocker {
  /**
   * `credential` — a key is missing or rejected.
   * `model` — the route works but no model was chosen.
   * `route` — the endpoint could not be reached at all.
   */
  kind: 'credential' | 'model' | 'route'
  /** What is wrong, in the operator's terms. No key values, ever. */
  message: string
  /** The exact action that clears it. One sentence, no steps to forget. */
  remedy: string
}

/** Keys are read from the profile at startup, so an edit needs a restart. */
const RESTART = 'Keys load at startup, so restart the session after editing it.'

/** The blocker for a key that is definitely absent, whatever the environment. */
function credentialBlocker(name: string, label: string): ConfigBlocker {
  // NVIDIA is the one route with a zero-config way out worth naming: a local
  // OpenAI-compatible server needs no credential at all.
  const elsewhere = name === 'NVIDIA_API_KEY'
    ? ' Or switch routes with FACTORY_LLM_PROVIDER=local.'
    : ''
  return {
    kind: 'credential',
    message: `${label} key missing`,
    remedy: `Add ${name}= to ${CONFIG_PATH} (never in chat or the repo). ${RESTART}${elsewhere}`,
  }
}

/** Same, but only when the environment genuinely lacks the key. */
function missingCredential(env: NodeJS.ProcessEnv, name: string, label: string): ConfigBlocker | null {
  return env[name]?.trim() ? null : credentialBlocker(name, label)
}

/** Model blocker for a route that needs an explicit model id. */
function modelBlocker(env: NodeJS.ProcessEnv): ConfigBlocker | null {
  const model = env.DSH_LLM_MODEL?.trim()
  if (!model) {
    return {
      kind: 'model',
      message: 'Choose a model for the OpenRouter route',
      remedy: `Run /model in the harness and pick one, or run wednesday --setup. ${RESTART}`,
    }
  }
  // A malformed id is a configuration fault, not a crash: it fails the same
  // way on every run and on every retry. `validateModel` owns that shape.
  try {
    validateModel(model)
  } catch {
    return {
      kind: 'model',
      message: `Model id is not a provider/model pair: ${model}`,
      remedy: 'Run /model and choose a provider/model id such as provider/model.',
    }
  }
  return null
}

/**
 * What the SELECTED route still needs before it can run anything.
 *
 * Route-aware, because a gate that checks the wrong credential is worse than no
 * gate: it blocks a working setup and admits a broken one. Null means ready.
 */
export function liveConfigBlocker(env: NodeJS.ProcessEnv = process.env): ConfigBlocker | null {
  if ((env.FACTORY_EXECUTION_MODE ?? 'live').trim().toLowerCase() === 'deterministic') return null
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
  // A local OpenAI-compatible route needs no credential, its model id need not
  // follow the provider/model form, and its base URL has a default.
  if (provider === 'local') return null
  if (provider === 'zen') return missingCredential(env, 'ZEN_API_KEY', 'Zen')
  // NVIDIA serves its own proven default model, so a missing key is the only
  // blocker — asking this route for DSH_LLM_MODEL would invent one.
  if (provider === 'nvidia') return missingCredential(env, 'NVIDIA_API_KEY', 'NVIDIA')
  return missingCredential(env, 'OPENROUTER_API_KEY', 'OpenRouter') ?? modelBlocker(env)
}

/**
 * Recognise a configuration blocker in a failure that ALREADY happened.
 *
 * Deliberately narrow. A mis-classified code failure is worse than an
 * unclassified one — it would tell the operator to fix a key while the real
 * fault is in their code — so only unambiguous shapes count:
 *
 *   - a key name followed by `is not set` (the providers' own wording)
 *   - the gate's own `... key missing` phrasing
 *   - 401, which is unambiguous, unlike 403 (the proxy's policy gate also
 *     produces refusals and those are NOT a credential problem)
 *   - a connection-level failure naming the local base URL
 */
export function configBlockerIn(text: string | undefined, env: NodeJS.ProcessEnv = process.env): ConfigBlocker | null {
  if (!text) return null
  // The providers' own wording names the key, so the blocker names the key too
  // rather than re-deriving it from the environment: the failure happened under
  // the environment as it was THEN, and this classification runs later.
  const KEY_LABEL: Record<string, string> = {
    NVIDIA_API_KEY: 'NVIDIA',
    ZEN_API_KEY: 'Zen',
    OPENROUTER_API_KEY: 'OpenRouter',
    LOCAL_LLM_API_KEY: 'local',
  }
  // Providers phrase the same fact three ways: `X is not set`, `X, which is
  // not set` (pi-ai's wording, 2026-11-04 — it slipped this gate and the run was
  // reported as a failed task with a tunnel guess) and `X is missing`.
  const notSet = /\b([A-Z][A-Z0-9_]*_API_KEY)\b[^.\n]{0,48}?\b(?:is|which is)\s+not\s+set\b/.exec(text)
  if (notSet?.[1] && KEY_LABEL[notSet[1]]) return credentialBlocker(notSet[1], KEY_LABEL[notSet[1]]!)
  const missing = /\b([A-Z][A-Z0-9_]*_API_KEY)\b[^.\n]{0,48}?\b(?:is\s+)?missing\b/.exec(text)
  if (missing?.[1] && KEY_LABEL[missing[1]]) return credentialBlocker(missing[1], KEY_LABEL[missing[1]]!)
  const gatePhrase = /\b(OpenRouter|NVIDIA|Zen) key missing\b/.exec(text)
  if (gatePhrase?.[1]) {
    const name = `${gatePhrase[1] === 'OpenRouter' ? 'OpenRouter' : gatePhrase[1]}_API_KEY`
    return credentialBlocker(name, gatePhrase[1])
  }
  if (/\b401\b/.test(text)) {
    const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
    const label = provider === 'nvidia' ? 'NVIDIA' : provider === 'zen' ? 'Zen' : 'OpenRouter'
    const name = provider === 'nvidia' ? 'NVIDIA_API_KEY' : provider === 'zen' ? 'ZEN_API_KEY' : 'OPENROUTER_API_KEY'
    return {
      kind: 'credential',
      message: `${label} rejected the key (HTTP 401)`,
      remedy: `Check ${name} in ${CONFIG_PATH} — it was read but not accepted.`,
    }
  }
  if (/\b(fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|getaddrinfo|other side closed|no route to)\b/i.test(text)) {
    const base = env.LOCAL_LLM_BASE_URL?.trim() || 'the local base URL'
    return {
      kind: 'route',
      message: `No route to ${base}`,
      remedy: 'Start your local OpenAI-compatible model server, or point LOCAL_LLM_BASE_URL at one that is running.',
    }
  }
  return null
}

export function requireLiveConfig(): void {
  const blocker = liveConfigBlocker()
  if (blocker) throw new Error(`${blocker.message}. ${blocker.remedy}`)
}

export function safeError(error: unknown): string {
  // One rule for every exit (CLI, Hermes, harness, connect, fatal guard):
  // secret-shaped env values, tunnel HOSTS, bearer tokens, key shapes and
  // secret query params are all scrubbed. See factory/security/redaction.ts.
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}

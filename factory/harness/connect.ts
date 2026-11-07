/**
 * `/connect` — the one onboarding step a real operator needs.
 *
 * The route used to live in a hand-edited `~/.wednesday/.env`: an ngrok URL
 * changes on every Colab restart, so "where do I put it" was a documentation
 * problem disguised as a configuration problem. This flow asks for the tunnel
 * ONCE, proves it answers `/models`, writes the profile outside the repo, and
 * applies it to the running session — no restart, no file hunting.
 *
 * Two rules are load-bearing:
 *
 *  1. **Probe before save.** A URL that does not answer is not a connection.
 *     The operator may still choose to save it (Colab not started yet), but
 *     the choice is explicit and the failure is named.
 *  2. **Never echo a secret.** API keys are read with echo off and only ever
 *     appear as `key present` in the receipt.
 */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CONFIG_PATH, safeError } from './config'
import { detectLocalServers, ollamaInstalledModels, type LocalCandidate } from './local-discovery'
import { NVIDIA_DEFAULT_BASE_URL, NVIDIA_DEFAULT_MODEL } from '../model-router/providers/nvidia'
import { createLocalToolProxy, type ToolProxyHandle } from '../dsh-worker/local-tool-proxy'
import type { SelectOption } from './screen'

export type Transport = 'ngrok' | 'cloudflare' | 'proxy' | 'openrouter' | 'local' | 'nvidia' | 'custom'

export interface ConnectUi {
  select?(title: string, options: SelectOption[]): Promise<string | undefined>
  ask(prompt: string): Promise<string | undefined>
  /** Secret prompt: echo off. */
  askPrivate?(prompt: string): Promise<string | undefined>
  /** Secret prompt with a mask on screen (preferred over askPrivate). */
  askSecret?(prompt: string): Promise<string | undefined>
  /** Configuration prompt: visible while typing, but not a stream request. */
  askConfig?(prompt: string): Promise<string | undefined>
  note(text: string): void
  error(text: string): void
  progress?(text: string): void
  routeLabel?(label: string): void
}

export interface ProbeResult {
  ok: boolean
  status?: number
  models: string[]
  ms: number
  error?: string
}

export interface ConnectResult {
  ok: boolean
  cancelled?: boolean
  /** What was connected to, in operator terms. Never contains a key. */
  receipt?: string
}

export interface ConnectOptions {
  /** Profile path; tests point this at a temp file. */
  path?: string
  /** Injected transport, so the probe is testable without a network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Injected local-server candidates for the auto-detect transport (tests). */
  candidates?: LocalCandidate[]
}

const TRANSPORTS: SelectOption[] = [
  { title: 'Local models (auto-detect)', desc: 'scans 127.0.0.1 — Ollama · LM Studio · llama.cpp · proxy', value: 'local' },
  { title: 'ngrok tunnel', desc: 'https://<sub>.ngrok-free.dev/v1', value: 'ngrok' },
  { title: 'Cloudflare tunnel', desc: 'https://<name>.trycloudflare.com/v1', value: 'cloudflare' },
  { title: 'Local proxy', desc: '127.0.0.1:18090 · auto-started from your saved tunnel URL', value: 'proxy' },
  { title: 'Any OpenAI-compatible API', desc: 'paste base URL · key · model — DeepSeek · Groq · Together · Mistral · vLLM · any /v1', value: 'custom' },
  { title: 'OpenRouter', desc: 'hosted route · needs an API key', value: 'openrouter' },
  { title: 'NVIDIA NIM', desc: 'hosted route · needs an NVIDIA_API_KEY', value: 'nvidia' },
]

const PROXY_URL = 'http://127.0.0.1:18090/v1'

/**
 * Turn what a person pastes into a base URL an OpenAI client accepts.
 *
 * A bare `xxxx.ngrok-free.dev` gets `https://` and `/v1`; a pasted
 * `https://host/v1/chat/completions` loses the endpoint suffix. Guessing is
 * kept to the two shapes people actually paste, and anything else is rejected
 * with the expected shape rather than silently "fixed".
 */
export function normalizeBaseURL(input: string): string {
  let value = input.trim()
  if (!value) throw new Error('Paste the tunnel base URL (it ends in /v1).')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('That is not a URL. Expected https://<host>/v1.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https endpoints are supported.')
  }
  // A pasted OpenAI endpoint is a common paste; the client wants the base.
  url.pathname = url.pathname.replace(/\/(chat\/completions|completions)\/?$/i, '')
  url.pathname = url.pathname.replace(/\/+$/, '')
  // `new URL('https://host')` reports pathname `/`, not empty: treat both as
  // "no path" so a bare host gets the OpenAI base path.
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/** `GET <base>/models`, bounded. No model call, no spend. */
export async function probeModels(
  baseURL: string,
  apiKey?: string,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    })
    const text = await response.text()
    let models: string[] = []
    try {
      const data = JSON.parse(text) as { data?: Array<{ id?: unknown }> }
      models = Array.isArray(data.data)
        ? data.data.map(entry => String(entry?.id ?? '')).filter(Boolean)
        : []
    } catch {
      // A non-JSON body is still a response; the status below says whether it
      // is a usable one. Never paste the body into the error: a proxy page can
      // be huge, and a key could be in a header echo.
    }
    const ms = Date.now() - started
    if (!response.ok) {
      return { ok: false, status: response.status, models, ms, error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}` }
    }
    return { ok: true, status: response.status, models, ms }
  } catch (error) {
    const reason = controller.signal.aborted
      ? `no answer in ${timeoutMs}ms`
      : safeError(error)
    return { ok: false, models: [], ms: Date.now() - started, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `POST <base>/chat/completions` with a 4-token ask. `/models` can answer on a
 * dead upstream (the tunnel edge is still up while Colab is down), but the
 * chat turn cannot lie — this is the fail-fast probe for tunnel routes.
 */
export async function probeChat(
  baseURL: string,
  timeoutMs = 20000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: '__probe__',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    })
    // Drain without echoing: a body can carry header echoes.
    await response.text()
    const ms = Date.now() - started
    if (!response.ok) {
      return { ok: false, status: response.status, models: [], ms, error: `chat probe HTTP ${response.status}` }
    }
    return { ok: true, status: response.status, models: [], ms }
  } catch (error) {
    const reason = controller.signal.aborted
      ? `no answer in ${timeoutMs}ms`
      : safeError(error)
    return { ok: false, models: [], ms: Date.now() - started, error: `chat probe failed: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Keeps the in-process proxy alive for the lifetime of the TUI. */
let proxyHandle: ToolProxyHandle | undefined

/**
 * Tunnel URLs are never dialed directly by the worker: the local tool proxy on
 * 127.0.0.1:18090 sits in front (UA/header fixes + tool-call normalization).
 * If nothing listens there yet, start it in-process against `upstream` — one
 * paste of the tunnel URL in /connect is then the whole setup.
 */
export async function ensureProxy(
  upstream: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const up = await probeModels(PROXY_URL, undefined, Math.min(timeoutMs, 4000), fetchImpl)
  if (up.ok) return up
  try {
    proxyHandle = await createLocalToolProxy({ port: 18090, upstream })
  } catch (error) {
    return { ok: false, models: [], ms: 0, error: `proxy start failed: ${safeError(error)}` }
  }
  // Give the listener a beat, then re-probe through it (validates the chain).
  await new Promise(resolve => setTimeout(resolve, 400))
  return probeModels(PROXY_URL, undefined, timeoutMs, fetchImpl)
}

/**
 * Update keys in an env file, preserving comments, order and every key this
 * flow does not own. The old setup wrote a fresh file and refused to overwrite
 * — safe, but it made the second tunnel of the day a manual edit.
 */
export function mergeEnv(content: string, updates: Record<string, string>): string {
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  const pending = new Map(Object.entries(updates))
  const out: string[] = []
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match && pending.has(match[1]!)) {
      const name = match[1]!
      out.push(`${name}=${pending.get(name)}`)
      pending.delete(name)
      continue
    }
    out.push(line)
  }
  // Drop a trailing blank so appending does not create a double gap.
  while (out.length && out[out.length - 1]!.trim() === '') out.pop()
  if (pending.size) {
    if (out.length) out.push('')
    for (const [name, value] of pending) out.push(`${name}=${value}`)
  }
  return `${out.join('\n')}\n`
}

/** Persist route updates outside the repository (0600 where the OS honours it). */
export async function writeEnv(
  updates: Record<string, string>,
  path = CONFIG_PATH,
): Promise<void> {
  for (const [name, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Refusing an invalid env name: ${name}`)
    if (/[\r\n]/.test(value)) throw new Error(`Refusing a multi-line value for ${name}.`)
  }
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, mergeEnv(current, updates), { mode: 0o600 })
}

/** Apply a local route to THIS process: the next request uses it, no restart. */
export function applyLocalRoute(
  baseURL: string,
  model: string,
  allSeats: boolean,
  upstream = true,
  upstreamURL?: string,
  /**
   * The provider's real key, when it needs one (2026-11-01). The local route is
   * "any OpenAI-compatible endpoint", which includes HOSTED ones — DeepSeek,
   * Groq, Together, Mistral, a vLLM box — and those reject a placeholder. It
   * stays optional so a loopback server keeps working with no key at all.
   */
  apiKey?: string,
): void {
  process.env.FACTORY_LLM_PROVIDER = 'local'
  process.env.LOCAL_LLM_BASE_URL = baseURL
  process.env.LOCAL_LLM_MODEL = model
  process.env.DSH_LLM_MODEL = model
  if (apiKey?.trim()) process.env.LOCAL_LLM_API_KEY = apiKey.trim()
  if (upstreamURL) {
    process.env.LOCAL_TOOL_PROXY_UPSTREAM = upstreamURL
  } else if (upstream && /^https?:/i.test(baseURL) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseURL)) {
    process.env.LOCAL_TOOL_PROXY_UPSTREAM = baseURL
  }
  if (allSeats) {
    for (const slot of ['PLANNER', 'CODER', 'VISION']) {
      process.env[`FACTORY_CREW_${slot}_MODEL`] = model
      process.env[`FACTORY_CREW_${slot}_BASE_URL`] = baseURL
    }
  }
}

function localUpdates(
  baseURL: string,
  model: string,
  allSeats: boolean,
  upstreamURL?: string,
  apiKey?: string,
): Record<string, string> {
  const updates: Record<string, string> = {
    FACTORY_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: baseURL,
    LOCAL_LLM_MODEL: model,
    DSH_LLM_MODEL: model,
  }
  if (apiKey?.trim()) updates.LOCAL_LLM_API_KEY = apiKey.trim()
  if (upstreamURL) {
    updates.LOCAL_TOOL_PROXY_UPSTREAM = upstreamURL
  } else if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseURL)) {
    updates.LOCAL_TOOL_PROXY_UPSTREAM = baseURL
  }
  if (allSeats) {
    for (const slot of ['PLANNER', 'CODER', 'VISION']) {
      updates[`FACTORY_CREW_${slot}_MODEL`] = model
      updates[`FACTORY_CREW_${slot}_BASE_URL`] = baseURL
    }
  }
  return updates
}

/**
 * Connect one specific local server + model and persist it — the "pick a model
 * and start working" path used by the /model plate's auto-detected rows and by
 * /create's seat picker. Every seat gets the model (solo start); the receipt
 * is the caller's.
 */
export async function connectLocalServer(baseURL: string, model: string, path = CONFIG_PATH): Promise<void> {
  await writeEnv(localUpdates(baseURL, model, true), path)
  applyLocalRoute(baseURL, model, true)
}

function hostOf(baseURL: string): string {
  try { return new URL(baseURL).host } catch { return baseURL }
}

type AskKind = 'request' | 'config' | 'secret'

async function askText(ui: ConnectUi, prompt: string, kind: AskKind = 'request'): Promise<string | undefined> {
  if (kind === 'secret') {
    if (ui.askSecret) return ui.askSecret(prompt)
    if (ui.askPrivate) return ui.askPrivate(prompt)
  }
  if (kind === 'config' && ui.askConfig) return ui.askConfig(prompt)
  return ui.ask(prompt)
}

/** Numbered fallback for the classic path, so connect exists without a plate. */
async function chooseTransport(ui: ConnectUi): Promise<Transport | undefined> {
  if (ui.select) {
    const pick = await ui.select('Connect to', TRANSPORTS)
    if (pick === undefined) return undefined
    return TRANSPORTS.find(entry => entry.value === pick)?.value as Transport | undefined
  }
  ui.note(`Connect to:\n${TRANSPORTS.map((t, i) => `  ${i + 1}) ${t.title}`).join('\n')}`)
  const choice = (await askText(ui, `Choice [1-${TRANSPORTS.length}]: `, 'config'))?.trim()
  if (!choice) return undefined
  const index = Number(choice)
  if (!Number.isInteger(index) || index < 1 || index > TRANSPORTS.length) {
    ui.error(`Unknown choice: ${choice} (choose 1-${TRANSPORTS.length})`)
    return undefined
  }
  return TRANSPORTS[index - 1]!.value as Transport
}

/**
 * Shared tail for every local-shaped transport (tunnel, proxy, auto-detected
 * local server): the seats question, the save outside the repo, applying the
 * route to the live process, and the receipt. One implementation, so the
 * three transports can never disagree about what "connected" means.
 */
async function finishLocalConnect(
  ui: ConnectUi,
  path: string,
  baseURL: string,
  model: string,
  modelCount: number,
  upstreamURL?: string,
  apiKey?: string,
): Promise<ConnectResult> {
  // All seats on one model is the default for a single box. A multi-box rig
  // can say no and keep its existing per-seat overrides.
  const seatsAnswer = (await askText(ui, 'Use this model for every crew seat? [Y/n] ', 'config'))?.trim().toLowerCase()
  if (seatsAnswer === undefined) return { ok: false, cancelled: true }
  const allSeats = seatsAnswer !== 'n' && seatsAnswer !== 'no'

  await writeEnv(localUpdates(baseURL, model, allSeats, upstreamURL, apiKey), path)
  applyLocalRoute(baseURL, model, allSeats, true, upstreamURL, apiKey)
  const receipt = `connected · ${hostOf(baseURL)} · ${model}${modelCount ? ` · ${modelCount} model${modelCount === 1 ? '' : 's'}` : ''}${allSeats ? ' · all seats' : ''}`
  ui.note(receipt)
  ui.note(`saved to ${CONFIG_PATH} (outside the repository)`)
  ui.routeLabel?.(model.split('/').pop() || model)
  ui.progress?.(`route → ${model.split('/').pop() || model}`)
  return { ok: true, receipt }
}

/**
 * The interactive flow shared by `/connect` and `wednesday connect`.
 *
 * Every step returns to the caller cleanly on cancel, and a failed probe never
 * writes anything unless the operator explicitly says so.
 */
export async function connectFlow(ui: ConnectUi, options: ConnectOptions = {}): Promise<ConnectResult> {
  const path = options.path ?? CONFIG_PATH
  const probeWith = (baseURL: string, key?: string) =>
    probeModels(baseURL, key, options.timeoutMs ?? 8000, options.fetchImpl ?? fetch)
  const transport = await chooseTransport(ui)
  if (!transport) return { ok: false, cancelled: true }

  if (transport === 'local') {
    // "Which local models do I have?" — scan the usual loopback ports, then
    // let the operator pick server + model. Read-only GET /models only.
    ui.progress?.('scanning local model servers on 127.0.0.1…')
    const servers = await detectLocalServers(
      Math.min(options.timeoutMs ?? 8000, 2000),
      options.fetchImpl ?? fetch,
      options.candidates ?? undefined,
    )
    if (servers.length === 0) {
      ui.error('no local model server answered (tried Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000, :1337, wednesday proxy :18090).')
      const installed = ollamaInstalledModels()
      if (installed.length > 0) {
        ui.note(`ollama has ${installed.length} model(s) installed — start the server with: ollama serve`)
        ui.note(`  ${installed.slice(0, 8).join(', ')}${installed.length > 8 ? ` (+${installed.length - 8} more)` : ''}`)
      } else {
        ui.note('start one (e.g. `ollama serve`), or pick a tunnel/OpenRouter/NVIDIA above.')
      }
      return { ok: false }
    }
    const serverPick = ui.select
      ? await ui.select('Local server found', servers.map(server => ({
          title: server.label,
          desc: `${server.models.length} model${server.models.length === 1 ? '' : 's'}: ${server.models.slice(0, 3).join(', ')}${server.models.length > 3 ? ' …' : ''}`,
          value: server.baseURL,
        })))
      : undefined
    if (serverPick === undefined) return { ok: false, cancelled: true }
    const server = servers.find(entry => entry.baseURL === serverPick)
    if (!server) return { ok: false, cancelled: true }

    let model = ''
    if (ui.select && server.models.length > 1) {
      const pick = await ui.select('Model on this server', [
        ...server.models.map(name => ({ title: name, value: name })),
        { title: 'Enter a different id…', desc: 'custom', value: '__custom' },
      ])
      if (pick === undefined) return { ok: false, cancelled: true }
      model = pick === '__custom'
        ? (await askText(ui, 'Model id: ', 'config'))?.trim() ?? ''
        : pick
    } else {
      model = server.models[0] ?? (await askText(ui, 'Model id: ', 'config'))?.trim() ?? ''
    }
    if (!model) return { ok: false }
    return finishLocalConnect(ui, path, server.baseURL, model, server.models.length)
  }

  if (transport === 'custom') {
    // ANY OpenAI-compatible provider (2026-11-01, operator direction: "don't
    // make wednesday depend on an OpenRouter key — /connect should accept any
    // provider"). Three answers and it works: base URL, key (optional — a
    // local box needs none), model id. Nothing here is OpenRouter-specific.
    const entered = (await askText(ui, 'Base URL (ends in /v1, e.g. https://api.deepseek.com/v1): ', 'config'))?.trim()
    if (entered === undefined) return { ok: false, cancelled: true }
    let baseURL: string
    try {
      baseURL = normalizeBaseURL(entered)
    } catch (error) {
      ui.error(safeError(error))
      return { ok: false }
    }
    const key = (await askText(ui, 'API key (hidden, Enter for none): ', 'secret'))?.trim() ?? ''
    ui.progress?.(`probing ${hostOf(baseURL)}…`)
    const probe = await probeWith(baseURL, key || undefined)
    if (!probe.ok) {
      ui.error(`${hostOf(baseURL)} did not answer: ${probe.error ?? 'unknown error'}`)
      ui.note('If the endpoint needs a key, check it; if it needs no /models route, type the model id anyway — /connect will ask next.')
      return { ok: false }
    }
    let model = ''
    if (ui.select && probe.models.length > 1) {
      const pick = await ui.select(`Model on ${hostOf(baseURL)}`, [
        ...probe.models.slice(0, 40).map(name => ({ title: name, value: name })),
        { title: 'Enter a different id…', desc: 'custom', value: '__custom' },
      ])
      if (pick === undefined) return { ok: false, cancelled: true }
      model = pick === '__custom'
        ? (await askText(ui, 'Model id: ', 'config'))?.trim() ?? ''
        : pick
    } else {
      model = probe.models[0] ?? (await askText(ui, 'Model id: ', 'config'))?.trim() ?? ''
    }
    if (!model) return { ok: false }
    return finishLocalConnect(ui, path, baseURL, model, probe.models.length, undefined, key || undefined)
  }

  if (transport === 'nvidia') {
    const key = (await askText(ui, 'NVIDIA API key (hidden): ', 'secret'))?.trim()
    if (!key) return { ok: false, cancelled: true }
    const enteredModel = (await askText(ui, `Model id [${NVIDIA_DEFAULT_MODEL}]: `, 'config'))?.trim()
    const model = enteredModel || NVIDIA_DEFAULT_MODEL
    if (!/^[a-zA-Z0-9._:\/-]+$/.test(model)) {
      ui.error('That is not a model id (letters, digits, . _ : - /).')
      return { ok: false }
    }
    ui.progress?.('probing integrate.api.nvidia.com…')
    const probe = await probeWith(NVIDIA_DEFAULT_BASE_URL, key)
    if (!probe.ok) {
      ui.error(`NVIDIA NIM did not answer: ${probe.error ?? 'unknown error'}`)
      return { ok: false }
    }
    await writeEnv({ NVIDIA_API_KEY: key, NVIDIA_LLM_MODEL: model, FACTORY_LLM_PROVIDER: 'nvidia', DSH_LLM_MODEL: model }, path)
    process.env.NVIDIA_API_KEY = key
    process.env.NVIDIA_LLM_MODEL = model
    process.env.FACTORY_LLM_PROVIDER = 'nvidia'
    process.env.DSH_LLM_MODEL = model
    const receipt = `connected · NVIDIA NIM · ${model}${probe.models.length ? ` · ${probe.models.length} models` : ''}`
    ui.note(receipt)
    ui.note(`saved to ${CONFIG_PATH} (outside the repository)`)
    ui.routeLabel?.(model.split('/').pop() || model)
    ui.progress?.(`route → ${model.split('/').pop() || model}`)
    return { ok: true, receipt }
  }

  if (transport === 'openrouter') {
    const key = (await askText(ui, 'OpenRouter API key (hidden): ', 'secret'))?.trim()
    if (!key) return { ok: false, cancelled: true }
    const model = (await askText(ui, 'Model id (provider/model): ', 'config'))?.trim()
    if (!model) return { ok: false, cancelled: true }
    if (!/^[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._:/-]+$/.test(model)) {
      ui.error('That is not a provider/model id (example: deepseek/deepseek-chat).')
      return { ok: false }
    }
    ui.progress?.('probing OpenRouter…')
    const probe = await probeWith('https://openrouter.ai/api/v1', key)
    if (!probe.ok) {
      ui.error(`OpenRouter did not answer: ${probe.error ?? 'unknown error'}`)
      return { ok: false }
    }
    await writeEnv({ OPENROUTER_API_KEY: key, DSH_LLM_MODEL: model, FACTORY_LLM_PROVIDER: 'openrouter' }, path)
    process.env.OPENROUTER_API_KEY = key
    process.env.DSH_LLM_MODEL = model
    process.env.FACTORY_LLM_PROVIDER = 'openrouter'
    const receipt = `connected · openrouter.ai · ${model}${probe.models.length ? ` · ${probe.models.length} models` : ''}`
    ui.note(receipt)
    ui.routeLabel?.(model.split('/').pop() || model)
    ui.progress?.(`route → ${model.split('/').pop() || model}`)
    return { ok: true, receipt }
  }

  // Tunnel transports (ngrok / cloudflare / local proxy): the pasted tunnel
  // URL is the UPSTREAM, never the dialed base. The worker always goes through
  // the local tool proxy on 127.0.0.1:18090 (header fixes + tool-call
  // normalization); if it is not running, /connect starts it in-process.
  // 2026-10-31 live-run finding: dialing the tunnel directly let a dead
  // upstream pass the /models probe and then kill every chat turn mid-stream
  // ("Stream ended without finish_reason") -> coder stage failed x retries.
  const hint = transport === 'proxy' ? ` [${PROXY_URL}]` : transport === 'cloudflare' ? ' (https://…trycloudflare.com/v1)' : ' (https://…ngrok-free.dev/v1)'
  const entered = (await askText(ui, `Base URL${hint}: `, 'config'))?.trim()
  if (entered === undefined) return { ok: false, cancelled: true }
  let upstreamURL: string
  try {
    upstreamURL = normalizeBaseURL(entered || (transport === 'proxy' ? PROXY_URL : ''))
  } catch (error) {
    ui.error(safeError(error))
    return { ok: false }
  }
  if (transport === 'proxy') {
    // Local proxy transport: reuse the saved tunnel URL as upstream.
    upstreamURL = (process.env.LOCAL_TOOL_PROXY_UPSTREAM ?? '').trim() || upstreamURL
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(upstreamURL)) {
      // good: remote upstream
    } else if (upstreamURL === PROXY_URL) {
      ui.error('No tunnel URL saved yet — pick "ngrok tunnel"/"Cloudflare tunnel" and paste the URL once; it is stored as LOCAL_TOOL_PROXY_UPSTREAM (outside the repo).')
      return { ok: false }
    }
  }

  // A loopback URL (Ollama-style, or a test server) is dialed directly — the
  // proxy only earns its keep for REMOTE tunnels, where it fixes headers and
  // normalizes tool calls on the way out.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(upstreamURL)) {
    ui.progress?.(`starting/using local proxy 127.0.0.1:18090 → ${hostOf(upstreamURL)}…`)
    const proxyUp = await ensureProxy(upstreamURL, options.fetchImpl ?? fetch, options.timeoutMs ?? 8000)
    if (!proxyUp.ok) {
      ui.error(`local proxy did not come up: ${proxyUp.error ?? 'unknown error'}`)
      const save = (await askText(ui, 'Save the tunnel URL anyway? [y/N] ', 'config'))?.trim().toLowerCase()
      if (save === 'y' || save === 'yes') {
        await writeEnv({ LOCAL_TOOL_PROXY_UPSTREAM: upstreamURL }, path)
        ui.note('tunnel URL saved to the profile (outside the repository). Start Colab, then /connect again.')
      }
      return { ok: false }
    }
  } else {
    upstreamURL = ''
  }
  const baseURL = upstreamURL ? PROXY_URL : normalizeBaseURL(entered || (transport === 'proxy' ? PROXY_URL : ''))

  ui.progress?.(`probing ${hostOf(baseURL)}…`)
  const probe = await probeWith(baseURL)
  if (!probe.ok) {
    ui.error(`could not reach ${hostOf(baseURL)}: ${probe.error ?? 'unknown error'}`)
    const save = (await askText(ui, 'Save it anyway? [y/N] ', 'config'))?.trim().toLowerCase()
    if (save !== 'y' && save !== 'yes') {
      ui.note('Nothing changed. Start the tunnel, then run /connect again.')
      return { ok: false }
    }
  }
  // Fail fast on a dead upstream (proxy routes only): /models can answer while
  // Colab is down, a real chat turn cannot (2026-10-31 live-run fix).
  if (upstreamURL) {
    ui.progress?.('chat-probing the tunnel (4 tokens)…')
    const chat = await probeChat(baseURL, Math.max(options.timeoutMs ?? 8000, 20000), options.fetchImpl ?? fetch)
    if (!chat.ok) {
      ui.error(`tunnel answered /models but a chat turn failed: ${chat.error ?? 'unknown error'}`)
      ui.note('The Colab/GPU box is probably down or restarting (the URL rotates) — paste the fresh URL.')
      const save = (await askText(ui, 'Save this URL anyway? [y/N] ', 'config'))?.trim().toLowerCase()
      if (save === 'y' || save === 'yes') {
        await writeEnv({ LOCAL_TOOL_PROXY_UPSTREAM: upstreamURL }, path)
      }
      return { ok: false }
    }
  }

  // One model on the endpoint means there is nothing to choose: take it. This
  // is the common Colab shape, and asking anyway is friction for no decision.
  const existing = (process.env.LOCAL_LLM_MODEL ?? '').trim()
  let model = probe.models.length === 1 ? probe.models[0]! : ''
  if (!model && ui.select && probe.models.length > 1) {
    // Many models: pick from the endpoint's own list instead of typing blind.
    const pick = await ui.select('Model on this endpoint', [
      ...probe.models.map(name => ({ title: name, value: name })),
      { title: 'Enter a different id…', desc: 'custom', value: '__custom' },
    ])
    if (pick === undefined) return { ok: false, cancelled: true }
    model = pick === '__custom'
      ? (await askText(ui, 'Model id: ', 'config'))?.trim() ?? ''
      : pick
  }
  if (!model) {
    const fallback = existing || probe.models[0] || ''
    const answer = (await askText(ui, `Model id${fallback ? ` [${fallback}]` : ''}: `, 'config'))?.trim()
    if (answer === undefined) return { ok: false, cancelled: true }
    model = answer || fallback
  }
  if (!model) {
    ui.error('No model id: the endpoint listed none and none was entered.')
    return { ok: false }
  }
  if (probe.models.length > 1 && !probe.models.includes(model)) {
    ui.note(`note: ${model} is not in the endpoint's model list — saved anyway.`)
  }

  return finishLocalConnect(ui, path, baseURL, model, probe.models.length, upstreamURL)
}

/** `wednesday connect` — the same flow on a plain terminal (no alternate screen). */
export async function connectCli(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Connect needs your own terminal; never send keys through a pipe or chat.')
  }
  let hidden = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) stdout.write(chunk, encoding as BufferEncoding)
      callback()
    },
  })
  const readline = createInterface({ input: stdin, output, terminal: true })
  const ui: ConnectUi = {
    ask: async prompt => {
      const answer = await readline.question(prompt)
      return answer
    },
    askPrivate: async prompt => {
      stdout.write(prompt)
      hidden = true
      try {
        const answer = await readline.question('')
        return answer
      } finally {
        hidden = false
        stdout.write('\n')
      }
    },
    note: text => console.log(text),
    error: text => console.error(text),
    progress: text => console.log(text),
  }
  try {
    await connectFlow(ui)
  } finally {
    readline.close()
    output.end()
  }
}

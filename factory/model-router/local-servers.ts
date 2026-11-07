/**
 * Local model server discovery for the `local` route.
 *
 * The model layer could not enumerate the models on the operator's own
 * machine: `providers/local.ts` returned ONE configured id and never asked
 * the server what it actually has. The harness kept a private port list,
 * and the README and the website both CLAIM vLLM is auto-detected - it was
 * not in the list, so the published claim was false. This module is the one
 * shared list: it probes the known local OpenAI-compatible servers (vLLM
 * included), asks each one for its model list, and answers with what is
 * really there.
 *
 * Loopback-only and read-only (`GET /models`, `GET /api/tags`): no model
 * call, no spend, no writes.
 */

export interface LocalServerCandidate {
  baseURL: string
  label: string
  /** Extra non-/v1 paths worth probing (Ollama's native API). */
  extraPaths?: string[]
  /** The runtime this candidate is for. */
  runtime: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'proxy' | 'generic'
}

export interface DiscoveredLocalServer extends LocalServerCandidate {
  ok: boolean
  latencyMs?: number
  models: string[]
  error?: string
}

/** Hard ceiling for one probe. A dead port must never hang the scan. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * The local OpenAI-compatible servers an operator is likely to have. vLLM
 * is here because the docs claim it is auto-detected (the claim was false
 * until this list included it).
 */
const CANDIDATES: LocalServerCandidate[] = [
  {
    baseURL: 'http://127.0.0.1:11434/v1',
    label: 'Ollama - 127.0.0.1:11434',
    extraPaths: ['/api/tags'],
    runtime: 'ollama',
  },
  {
    baseURL: 'http://127.0.0.1:1234/v1',
    label: 'LM Studio - 127.0.0.1:1234',
    runtime: 'lmstudio',
  },
  {
    baseURL: 'http://127.0.0.1:8080/v1',
    label: 'llama.cpp server - 127.0.0.1:8080',
    runtime: 'llamacpp',
  },
  {
    baseURL: 'http://127.0.0.1:8000/v1',
    label: 'vLLM - 127.0.0.1:8000',
    runtime: 'vllm',
  },
  {
    baseURL: 'http://127.0.0.1:1337/v1',
    label: 'local server - 127.0.0.1:1337',
    runtime: 'generic',
  },
  {
    baseURL: 'http://127.0.0.1:18090/v1',
    label: 'wednesday local proxy - 127.0.0.1:18090',
    runtime: 'proxy',
  },
]

/** A fresh copy of the candidate list (callers may mutate it). */
export function localServerCandidates(): LocalServerCandidate[] {
  return CANDIDATES.map(candidate => ({
    ...candidate,
    extraPaths: candidate.extraPaths ? [...candidate.extraPaths] : undefined,
  }))
}

/** Strip trailing slashes so `${base}/models` is well formed. */
function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/** The origin of a base URL, or null when it cannot be parsed. */
function originOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).origin
  } catch {
    return null
  }
}

/** A model id as a string; anything else is not a model id. */
function modelId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Both list shapes: OpenAI-compatible (`data[].id`) and Ollama's native
 * (`models[].name`). A body that is not JSON is not a model list.
 */
function parseModelList(text: string): string[] {
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const root = parsed as { data?: unknown; models?: unknown }
  const ids: string[] = []
  if (Array.isArray(root.data)) {
    for (const entry of root.data) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = modelId((entry as { id?: unknown }).id)
      if (id) ids.push(id)
    }
  }
  if (ids.length === 0 && Array.isArray(root.models)) {
    for (const entry of root.models) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as { name?: unknown; id?: unknown }
      const name = modelId(record.name)
      const id = name ? name : modelId(record.id)
      if (id) ids.push(id)
    }
  }
  return ids
}

/** A human-readable error for a thrown value. */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`
    return err.message
  }
  return String(err)
}

/** A fetch that always has a deadline. */
interface Deadline {
  signal: AbortSignal
  expired: () => boolean
  timeoutMs: number
  clear: () => void
}

function makeDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    expired: () => expired,
    timeoutMs,
    clear: () => clearTimeout(timer),
  }
}

interface FetchOutcome {
  ok: boolean
  status: number
  body: string
  error?: string
}

/** One GET, never throwing. */
async function fetchJson(url: string, deadline: Deadline): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      signal: deadline.signal,
      headers: { accept: 'application/json' },
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body }
  } catch (err) {
    const message = deadline.expired()
      ? `timeout after ${String(deadline.timeoutMs)}ms`
      : errorText(err)
    return { ok: false, status: 0, body: '', error: message }
  }
}

/**
 * The model ids a local server reports.
 *
 * `GET {baseURL}/models` first; when that comes back empty, Ollama's native
 * `GET {origin}/api/tags` is the fallback (some Ollama builds only expose
 * that shape). On failure the answer is an empty list - never an exception.
 */
export async function listLocalModels(
  baseURL: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  const base = normalizeBaseURL(baseURL)
  if (!base) return []
  const deadline = makeDeadline(timeoutMs)
  try {
    const primary = await fetchJson(`${base}/models`, deadline)
    const models = parseModelList(primary.body)
    if (models.length > 0) return models
    const origin = originOf(base)
    if (!origin) return []
    const native = await fetchJson(`${origin}/api/tags`, deadline)
    return parseModelList(native.body)
  } catch {
    return []
  } finally {
    deadline.clear()
  }
}

/**
 * Probe one candidate: is a server there, and which models does it have?
 * Never hangs - one hard deadline covers the whole probe.
 */
export async function probeLocalServer(
  candidate: LocalServerCandidate,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DiscoveredLocalServer> {
  const started = Date.now()
  const base = normalizeBaseURL(candidate.baseURL)
  const deadline = makeDeadline(timeoutMs)
  let lastError = ''
  let answered = false
  try {
    const paths = ['/models', ...(candidate.extraPaths ?? [])]
    for (const path of paths) {
      if (deadline.expired()) break
      const outcome = await fetchJson(`${base}${path}`, deadline)
      if (outcome.error) {
        lastError = outcome.error
        continue
      }
      if (!outcome.ok) {
        lastError = `HTTP ${String(outcome.status)} on ${path}`
        continue
      }
      answered = true
      const models = parseModelList(outcome.body)
      if (models.length > 0) {
        return {
          ...candidate,
          ok: true,
          latencyMs: Date.now() - started,
          models,
        }
      }
    }
    return {
      ...candidate,
      ok: answered,
      latencyMs: Date.now() - started,
      models: [],
      error: answered ? undefined : (lastError || `no model list from ${base}`),
    }
  } catch (err) {
    return {
      ...candidate,
      ok: false,
      latencyMs: Date.now() - started,
      models: [],
      error: errorText(err),
    }
  } finally {
    deadline.clear()
  }
}

/**
 * Probe every known candidate concurrently and return ALL of them - the
 * live servers and the dead ones - with the live ones first. A dead port
 * costs one timeout, and they all run at once.
 */
export async function discoverLocalServers(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DiscoveredLocalServer[]> {
  const candidates = localServerCandidates()
  const settled = await Promise.allSettled(
    candidates.map(candidate => probeLocalServer(candidate, timeoutMs)),
  )
  const servers: DiscoveredLocalServer[] = []
  settled.forEach((result, index) => {
    const candidate = candidates[index]
    if (!candidate) return
    if (result.status === 'fulfilled') {
      servers.push(result.value)
      return
    }
    servers.push({
      ...candidate,
      ok: false,
      models: [],
      error: errorText(result.reason),
    })
  })
  return servers.sort((a, b) => Number(b.ok) - Number(a.ok))
}

/* ------------------------------------------------------------------ */
/* The server's context window.                                         */
/* ------------------------------------------------------------------ */

/**
 * The window the SERVER is actually running with, in tokens (0 = unknown).
 *
 * The MODEL's ceiling and the DEPLOYMENT's window are different facts, and
 * confusing them is how a prompt gets truncated at the wrong end:
 *  - Qwen2.5-Coder-3B supports 32K, but the Colab box that serves it was
 *    deliberately configured for 13,312 (a T4's memory), so the real ceiling
 *    there is 13K - and a 20K prompt sent to it loses its HEAD, which is
 *    where the instructions live.
 *  - A 4K free model on OpenRouter supports 4K, and the route used to send
 *    it 30K because hosted routes had NO window at all.
 *
 * llama.cpp's `/props` reports `n_ctx`; vLLM and LM Studio expose
 * `max_model_len`. We read whatever the server is willing to say and take
 * the SMALLER of that and the model's own ceiling.
 */
export async function probeServerContextWindow(
  baseURL: string,
  timeoutMs: number = 2000,
): Promise<number> {
  const base = normalizeBaseURL(baseURL)
  if (!base) return 0
  const origin = originOf(base)
  if (!origin) return 0
  const deadline = makeDeadline(timeoutMs)
  try {
    for (const path of ['/props', '/v1/props', '/api/show']) {
      if (deadline.expired()) break
      const outcome = await fetchJson(`${origin}${path}`, deadline)
      if (!outcome.ok || !outcome.body) continue
      const found = findContextWindow(outcome.body)
      if (found > 0) return found
    }
    return 0
  } catch {
    return 0
  } finally {
    deadline.clear()
  }
}

/** Dig a window number out of a server's JSON, wherever it hides. */
function findContextWindow(body: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return 0
  }
  const keys = ['n_ctx', 'max_model_len', 'context_length', 'contextLength', 'max_context_length']
  const found = searchNumber(parsed, keys, 0)
  return found > 0 ? Math.floor(found) : 0
}

/** Depth-limited search for the first numeric value under any of the keys. */
function searchNumber(value: unknown, keys: string[], depth: number): number {
  if (depth > 4 || value === null || typeof value !== 'object') return 0
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = searchNumber(entry, keys, depth + 1)
      if (found > 0) return found
    }
    return 0
  }
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate
    }
  }
  for (const nested of Object.values(record)) {
    const found = searchNumber(nested, keys, depth + 1)
    if (found > 0) return found
  }
  return 0
}

/** The probe is cached per server for a short while (a window rarely moves). */
const windowCache = new Map<string, { value: number; at: number }>()
const WINDOW_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * The cached server window (0 when the server will not say).
 *
 * A probe per completion would add a round trip to every single call, on a
 * route whose whole point is that it is fast and local.
 */
export async function cachedServerContextWindow(
  baseURL: string,
  timeoutMs: number = 2000,
): Promise<number> {
  const base = normalizeBaseURL(baseURL)
  if (!base) return 0
  const cached = windowCache.get(base)
  if (cached && Date.now() - cached.at < WINDOW_CACHE_TTL_MS) return cached.value
  const value = await probeServerContextWindow(base, timeoutMs)
  windowCache.set(base, { value, at: Date.now() })
  return value
}

/** Forget a cached window (tests, and after the operator changes the server). */
export function resetServerContextWindowCache(): void {
  windowCache.clear()
}

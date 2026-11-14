/**
 * Local model discovery — "what models do I already have on this machine?"
 *
 * `/connect` offers this as one transport: instead of pasting a URL, the
 * harness scans the usual local OpenAI-compatible ports in parallel (each
 * with a sub-second timeout, so a dead port costs nothing), asks each
 * answering server for its model list, and lets the operator pick a server
 * and a model. Ollama's `/api/tags` is probed too, because some builds only
 * expose that shape.
 *
 * Everything is loopback-only and read-only (`GET /models`): no model call,
 * no spend, no writes. If nothing answers but the `ollama` CLI is installed,
 * the caller can still tell the operator which models exist and that
 * `ollama serve` is what is missing.
 */
import { spawnSync } from 'node:child_process'

export interface LocalServer {
  baseURL: string
  label: string
  models: string[]
  ms: number
}

interface Candidate {
  baseURL: string
  label: string
  /** Extra endpoint shape to try (Ollama's /api/tags). */
  extraPaths?: string[]
}

export type { Candidate as LocalCandidate }

const CANDIDATES: Candidate[] = [
  { baseURL: 'http://127.0.0.1:11434/v1', label: 'Ollama · 127.0.0.1:11434', extraPaths: ['/api/tags'] },
  { baseURL: 'http://127.0.0.1:1234/v1', label: 'LM Studio · 127.0.0.1:1234' },
  { baseURL: 'http://127.0.0.1:8080/v1', label: 'llama.cpp server · 127.0.0.1:8080' },
  // vLLM (2026-11-05): the model layer has always known about vLLM on
  // :8000 (`factory/model-router/local-servers.ts`), and the README and the
  // website both CLAIMED the harness auto-detected it - it did not. The
  // claim was false and the port was one line away, so the claim is now
  // true: the harness scan probes :8000 too.
  { baseURL: 'http://127.0.0.1:8000/v1', label: 'vLLM · 127.0.0.1:8000' },
  { baseURL: 'http://127.0.0.1:1337/v1', label: 'local server · 127.0.0.1:1337' },
  { baseURL: 'http://127.0.0.1:18090/v1', label: 'wednesday local proxy · 127.0.0.1:18090' },
]

/** The ports scanned by default; exported so tests can scan their own. */
export function defaultLocalCandidates(): Candidate[] {
  return CANDIDATES.map(candidate => ({ ...candidate, extraPaths: candidate.extraPaths ? [...candidate.extraPaths] : undefined }))
}

/** Both OpenAI (`data[].id`) and Ollama (`models[].name`) list shapes. */
function parseModelList(text: string): string[] {
  try {
    const data = JSON.parse(text) as { data?: unknown; models?: unknown }
    if (Array.isArray(data.data)) {
      return (data.data as Array<{ id?: unknown }>).map(entry => String(entry?.id ?? '')).filter(Boolean)
    }
    if (Array.isArray(data.models)) {
      return (data.models as Array<{ name?: unknown; id?: unknown }>)
        .map(entry => String(entry?.name ?? entry?.id ?? ''))
        .filter(Boolean)
    }
  } catch { /* not JSON — not a model list */ }
  return []
}

async function probeCandidate(
  candidate: Candidate,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<LocalServer | null> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const paths = ['/models', ...(candidate.extraPaths ?? [])]
    for (const path of paths) {
      let response: Awaited<ReturnType<typeof fetchImpl>>
      try {
        response = await fetchImpl(`${candidate.baseURL}${path}`, { signal: controller.signal })
      } catch {
        continue // dead port or wrong path — try the next shape
      }
      if (!response.ok) continue
      const models = parseModelList(await response.text())
      if (models.length > 0) {
        return { baseURL: candidate.baseURL, label: candidate.label, models, ms: Date.now() - started }
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scan known local ports in parallel. A dead port costs one timeout
 * (they run concurrently, so the whole scan is ~timeoutMs, not N x timeoutMs).
 * `candidates` is overridable so tests can point the scan at a loopback server.
 */
export async function detectLocalServers(
  timeoutMs = 900,
  fetchImpl: typeof fetch = fetch,
  candidates: Candidate[] = CANDIDATES,
): Promise<LocalServer[]> {
  const found = await Promise.all(candidates.map(candidate => probeCandidate(candidate, timeoutMs, fetchImpl)))
  return found.filter((server): server is LocalServer => server !== null)
}

/**
 * Models the `ollama` CLI reports as installed, even when the server is not
 * running — the honest answer to "which local models do I have" is the CLI's
 * list; the server is what makes them usable.
 */
export function ollamaInstalledModels(): string[] {
  try {
    const done = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    if (done.status !== 0 || !done.stdout) return []
    return done.stdout
      .split('\n')
      .slice(1)
      .map(line => line.split(/\s+/)[0] ?? '')
      .filter(name => name && name !== 'NAME')
  } catch {
    return []
  }
}

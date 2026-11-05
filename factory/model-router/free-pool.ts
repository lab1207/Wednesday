/**
 * Free-pool resolver for OpenRouter (2026-09-23, offline-green).
 *
 * Instead of one hardcoded model id, the Factory reads the live
 * `/api/v1/models` catalog and picks a working `:free` model: the
 * first operator-preferred id present (`FACTORY_FREE_POOL_MODELS`,
 * comma-separated), else the first free id in catalog order. Anything
 * failing (pool disabled via `FACTORY_FREE_POOL=0`, network down,
 * empty pool) falls back to the configured model — today's behavior
 * is the floor, never a regression.
 *
 * No hardcoded model list lives here by design: free-tier ids churn
 * weekly, so the operator curates preferences in env, not in code.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TIMEOUT_MS = 10000

/** Opt-out flag (pure): pool resolves unless explicitly `0`/`false`/`no`. */
export function isFreePoolEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !['0', 'false', 'no'].includes(
    (env.FACTORY_FREE_POOL ?? '').trim().toLowerCase(),
  )
}

/** Operator-preferred free ids in rank order (pure). */
export function preferredFreeModels(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return String(env.FACTORY_FREE_POOL_MODELS ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

/** Free-tier ids (`:free` suffix) from a catalog payload (pure). */
export function parseFreeModels(catalog: unknown): string[] {
  const entries =
    typeof catalog === 'object' && catalog !== null && 'data' in catalog
      ? (catalog as { data?: unknown }).data
      : null
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const entry of entries) {
    const id =
      typeof entry === 'object' && entry !== null && 'id' in entry
        ? String((entry as { id?: unknown }).id ?? '')
        : ''
    if (id.endsWith(':free') && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Winner: first preferred id present in the pool, else the pool head,
 * else null (caller falls back to the configured model).
 */
export function pickFreeModel(
  freeIds: string[],
  preferred: string[],
): string | null {
  for (const want of preferred) {
    if (freeIds.includes(want)) return want
  }
  return freeIds[0] ?? null
}

export interface FreePoolOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/** Live catalog read → free ids (throws on any failure; caller falls back). */
export async function listFreeModels(
  options: FreePoolOptions = {},
): Promise<string[]> {
  const fetchFn = options.fetchFn ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CATALOG_TIMEOUT_MS,
  )
  try {
    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Free-pool catalog failed: ${response.status}`)
    }
    return parseFreeModels(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

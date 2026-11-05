/**
 * Model switcher (2026-10-13, 1-model release): the operator saves MANY
 * models, ONE is active — Claude-Code-style switching. Pure.
 *
 * Registry var: `FACTORY_MODELS="qwen1b:local/qwen-27b-1bit@http://127.0.0.1:8080/v1,pro:openrouter/qwen/qwen3-coder"`.
 * Entry = `name:provider/model-id[@baseURL]` (baseURL optional).
 * Active var: `FACTORY_ACTIVE_MODEL=qwen1b`. File IO stays in the
 * harness (`/model` writes, `loadConfig` loads); this file only
 * parses and resolves. Unknown active name is an operator-facing
 * error, never a silent fallback to a different model.
 */

export interface NamedModel {
  name: string
  provider: string
  id: string
  baseURL?: string
}

/** Parse the registry (pure): trims, drops junk, dedupes by name. */
export function parseModelRegistry(
  env: NodeJS.ProcessEnv = process.env,
): NamedModel[] {
  const raw = (env.FACTORY_MODELS ?? '').trim()
  if (!raw) return []
  const out: NamedModel[] = []
  const seen = new Set<string>()
  for (const entry of raw.split(',')) {
    const piece = entry.trim()
    if (!piece) continue
    const at = piece.lastIndexOf('@')
    const head = (at > 0 ? piece.slice(0, at) : piece).trim()
    const baseURL = at > 0 ? piece.slice(at + 1).trim() : undefined
    const colon = head.indexOf(':')
    if (colon <= 0) continue
    const name = head.slice(0, colon).trim()
    const model = head.slice(colon + 1).trim()
    if (!name || seen.has(name)) continue
    const slash = model.indexOf('/')
    if (slash <= 0) continue
    const provider = model.slice(0, slash).trim().toLowerCase()
    const id = model.slice(slash + 1).trim()
    if (!provider || !id) continue
    seen.add(name)
    out.push(baseURL ? { name, provider, id, baseURL } : { name, provider, id })
  }
  return out
}

/**
 * Active entry (pure): exact name match on FACTORY_ACTIVE_MODEL.
 * Returns null when unset/unknown — the caller falls back to the
 * route defaults AND should tell the operator (never silently run
 * a different model than the one named).
 */
export function resolveActiveModel(
  env: NodeJS.ProcessEnv = process.env,
  registry: NamedModel[] = parseModelRegistry(env),
): NamedModel | null {
  const active = (env.FACTORY_ACTIVE_MODEL ?? '').trim()
  if (!active) return null
  return registry.find(entry => entry.name === active) ?? null
}

/** Validate a switch target (pure): returns the entry or throws naming it. */
export function switchModel(
  name: string,
  registry: NamedModel[],
): NamedModel {
  const target = name.trim()
  const found = registry.find(entry => entry.name === target)
  if (!found) {
    const known = registry.map(entry => entry.name).join(', ') || '(empty registry)'
    throw new Error(`Unknown model "${target}". Saved: ${known}.`)
  }
  return found
}

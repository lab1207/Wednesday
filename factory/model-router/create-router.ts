import { RegistryModelRouter } from './router'
import { LocalProvider } from './providers/local'
import { NvidiaProvider } from './providers/nvidia'
import { OpenRouterProvider } from './providers/openrouter'
import { ZenProvider } from './providers/zen'
import type { ModelProvider } from './types'

/**
 * Builds the model router (2026-10-31, provider-agnostic crews).
 *
 * The FACTORY_LLM_PROVIDER route is registered FIRST so legacy single-route
 * runs are byte-identical, but it is no longer the ONLY provider: every
 * other provider whose credential is present is registered too, so a crew
 * seat can pin any of them with a `provider/model` id (see
 * RegistryModelRouter.pinnedProvider). `local` needs no credential — it is
 * any OpenAI-compatible endpoint (ngrok / Cloudflare tunnel / NIM-style
 * custom server) via LOCAL_LLM_BASE_URL or the per-slot
 * FACTORY_CREW_<ROLE>_BASE_URL overrides.
 *
 * @param env - Environment holding the route selection; defaults to `process.env`.
 * @returns A router with the route provider plus every credentialed provider.
 */
export function createModelRouter(
  env: NodeJS.ProcessEnv = process.env,
): RegistryModelRouter {
  const router = new RegistryModelRouter()
  const route = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()

  const factories: Array<[string, () => ModelProvider, () => boolean]> = [
    ['openrouter', () => new OpenRouterProvider(), () => (env.OPENROUTER_API_KEY ?? '').trim().length > 0],
    ['nvidia', () => new NvidiaProvider(), () => (env.NVIDIA_API_KEY ?? '').trim().length > 0],
    ['zen', () => new ZenProvider(), () => (env.ZEN_API_KEY ?? '').trim().length > 0],
    // Any OpenAI-compatible endpoint needs no key — always available.
    ['local', () => new LocalProvider(), () => true],
  ]

  const routeName =
    route === 'local' ? 'local'
      : route === 'zen' ? 'zen'
        : route === 'nvidia' ? 'nvidia'
          : 'openrouter'

  // Route provider first (legacy precedence), then the rest in stable order.
  const ordered = [...factories].sort(([a], [b]) =>
    a === routeName ? -1 : b === routeName ? 1 : 0,
  )

  const seen = new Set<string>()
  for (const [name, make, ready] of ordered) {
    if (seen.has(name)) continue
    if (name === routeName || ready()) {
      router.register(make())
      seen.add(name)
    }
  }

  return router
}

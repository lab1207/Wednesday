import { OpenRouterProvider } from '../model-router/providers/openrouter'
import { NvidiaProvider } from '../model-router/providers/nvidia'
import { ZenProvider } from '../model-router/providers/zen'
import { LocalProvider } from '../model-router/providers/local'

import { redactSensitiveText } from '../security/redaction'

/**
 * Whether a route has the credential it needs.
 *
 * `present` - the credential is in the environment.
 * `missing` - the credential is absent, so the route is never queried.
 * `not-needed` - the route issues no credential (any OpenAI-compatible
 * local server).
 *
 * The VALUE of a credential is never part of this state, never returned and
 * never logged: the catalogue only ever says which of the three words it is.
 */
export type CredentialState = 'present' | 'missing' | 'not-needed'

/** One route's entry in the model catalogue. */
export interface ModelCatalogueEntry {
  provider: string
  credential: CredentialState
  /** The models this route can reach. Absent when the route was not queried. */
  models?: string[]
  /** Why the route produced no models. Absent on success. */
  error?: string
}

/** The part of a model provider the catalogue needs. */
export interface CatalogueProvider {
  name: string
  listModels(): Promise<string[]>
}

/**
 * The credential state of a route.
 *
 * The rule is the one the router already uses: `openrouter` needs
 * OPENROUTER_API_KEY, `nvidia` needs NVIDIA_API_KEY, `zen` needs
 * ZEN_API_KEY, and `local` needs nothing at all. Any other route is
 * reported as `missing`.
 *
 * @param provider - the route name.
 * @param env - the environment holding the credentials; defaults to the process environment.
 * @returns the state — never the credential itself.
 */
export function credentialState(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialState {
  switch (provider) {
    case 'openrouter':
      return (env.OPENROUTER_API_KEY ?? '').trim().length > 0 ? 'present' : 'missing'
    case 'nvidia':
      return (env.NVIDIA_API_KEY ?? '').trim().length > 0 ? 'present' : 'missing'
    case 'zen':
      return (env.ZEN_API_KEY ?? '').trim().length > 0 ? 'present' : 'missing'
    case 'local':
      return 'not-needed'
    default:
      return 'missing'
  }
}

/**
 * The real providers, in the order the catalogue lists them.
 *
 * These are the very classes the router registers, so the catalogue reports
 * what Wednesday can actually call — never a mock, never a second protocol.
 */
export function catalogueProviders(): CatalogueProvider[] {
  return [
    new OpenRouterProvider(),
    new NvidiaProvider(),
    new ZenProvider(),
    new LocalProvider(),
  ]
}

/**
 * Build the catalogue: one entry per provider, in the order given.
 *
 * A route whose credential is missing is NEVER queried. A route that throws
 * or that does not answer in time degrades to its own error entry, and the
 * other routes still return. The catalogue never throws and never hangs.
 *
 * @param providers - the routes to list, in the order they should appear.
 * @param env - the environment holding the credentials.
 * @param timeoutMs - the per-route deadline; a slower route is an error, not a hang.
 * @returns one entry per provider, in order.
 */
export async function buildModelCatalogue(
  providers: CatalogueProvider[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
): Promise<ModelCatalogueEntry[]> {
  const catalogue: ModelCatalogueEntry[] = []

  for (const provider of providers) {
    const state = credentialState(provider.name, env)

    // A route we cannot authenticate against is never queried: the request
    // would only ever produce an auth error.
    if (state === 'missing') {
      catalogue.push({ provider: provider.name, credential: state })
      continue
    }

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${String(timeoutMs)}ms`)),
        timeoutMs,
      )
    })

    try {
      const models = await Promise.race([provider.listModels(), timeout])
      catalogue.push({ provider: provider.name, credential: state, models })
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).trim()
      catalogue.push({
        provider: provider.name,
        credential: state,
        error: redactSensitiveText(message.length > 0 ? message : 'unknown error'),
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return catalogue
}

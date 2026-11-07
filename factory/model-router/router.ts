import type {
  CompletionHooks,
  CompletionOptions,
  ModelProvider,
  ModelRequirements,
  ModelRoute,
  ModelRouter,
} from './types'
import { contextWindowFor } from './model-registry'
import { priceForModel } from './usage'

export class RegistryModelRouter implements ModelRouter {
  private readonly providers: ModelProvider[] = []

  register(provider: ModelProvider): void {
    this.providers.push(provider)
  }

  /**
   * Provider-pinned ids (2026-10-31, provider-agnostic crews): a
   * `provider/model` pin whose prefix names a REGISTERED provider routes
   * straight to it, and the provider receives the id without the prefix.
   * A pin whose prefix is NOT a registered provider (e.g. the vendor part
   * of an OpenRouter id like `deepseek/deepseek-chat`) falls through to
   * legacy supports()-based selection, byte-identical.
   */
  private pinnedProvider(model: string | undefined): ModelProvider | undefined {
    const pin = (model ?? '').trim()
    const sep = pin.indexOf('/')
    if (sep <= 0) return undefined
    const head = pin.slice(0, sep)
    return this.providers.find(candidate => candidate.name === head)
  }

  /**
   * Do the requirements' LIMITS fit this model? (2026-11-05)
   *
   * `ModelRequirements` declared `maxCost`, `maxLatencyMs` and
   * `contextTokens` from the start and NOTHING read them: the router picked
   * a model and ignored the limits, so "a model that fits a 13K window" and
   * "a model under $X" were unanswerable - exactly the two questions that
   * matter when a fleet of small models has to be staffed.
   *
   * The rules are deliberately strict:
   *  - An UNKNOWN window or price cannot satisfy a limit. We do not promise
   *    what we cannot check.
   *  - A limit of 0 (or absent) means "no limit", never "reject everything".
   *  - `maxCost` is the COMBINED USD-per-million-token rate the caller will
   *    accept (input + output). It is compared against the operator's own
   *    price when one is set (`FACTORY_PRICE_<MODEL>`), because the
   *    factory cannot know what somebody's contract costs.
   */
  private fitsLimits(
    provider: string,
    model: string,
    requirements: ModelRequirements,
  ): boolean {
    const contextTokens = requirements.contextTokens ?? 0
    if (contextTokens > 0) {
      const window = contextWindowFor(model, provider)
      if (window <= 0 || window < contextTokens) return false
    }

    const maxCost = requirements.maxCost ?? 0
    if (maxCost > 0) {
      const price = priceForModel(model)
      // A local model costs the operator their own hardware; it is not free
      // in tokens, but it is not priced either, so a cost cap cannot be
      // enforced against it. Refuse to pretend.
      if (price === null) return false
      const inputPrice = price.input + price.output
      if (inputPrice > maxCost) return false
    }

    // `maxLatencyMs` needs a measured latency, which only exists after a
    // call. The registry has no per-model latency table, so the honest
    // answer is: a latency cap cannot be enforced at selection time and is
    // enforced by the retry/timeout policy instead.

    return true
  }

  async select(
    requirements: ModelRequirements = {},
  ): Promise<ModelRoute> {
    const pin = (requirements.preferredModel ?? '').trim()

    const pinned = this.pinnedProvider(pin)
    if (pinned) {
      const model = pin.slice(pinned.name.length + 1)
      if (this.fitsLimits(pinned.name, model, requirements)) {
        return { provider: pinned.name, model }
      }
      // A pinned lane that cannot honour the limits is still the lane's
      // model: the lane pin is an explicit operator decision, and silently
      // swapping in a different model would be worse than overrunning a
      // limit nobody set today. Fall through to the normal selection.
    }

    const provider = this.providers.find(candidate =>
      candidate.supports(requirements),
    )

    if (!provider) {
      throw new Error(
        `No model provider satisfies requirements: ${JSON.stringify(requirements)}`,
      )
    }

    const models = provider.selectModel
      ? [await provider.selectModel(requirements)]
      : await provider.listModels()

    if (models.length === 0) {
      throw new Error(
        `Provider "${provider.name}" has no available models`,
      )
    }

    // THE LIMITS ARE ENFORCED HERE TOO (2026-11-05).
    //
    // They used to be checked only on the PINNED path, so an ordinary
    // selection walked straight past a cost cap - and a cap that is not
    // enforced is worse than no cap, because the operator believes it is
    // holding.
    //
    // When several models are on offer, the FIRST one that fits wins.
    const fitting = models.filter(model =>
      this.fitsLimits(provider.name, model, requirements),
    )

    // THE OPERATOR'S PIN IS HONOURED when this provider carries it. A lane
    // pin is an explicit decision, and a silent swap to another model would
    // change WHAT RAN - the receipt still shows the real cost, so an
    // over-budget pin is a fact the operator can see and act on.
    const pinModel = pin === ''
      ? ''
      : pin.startsWith(`${provider.name}/`)
        ? pin.slice(provider.name.length + 1)
        : pin
    if (pinModel !== '' && models.includes(pinModel)) {
      return {
        provider: provider.name,
        model: pinModel,
      }
    }

    if (fitting.length > 0) {
      return {
        provider: provider.name,
        model: fitting[0],
      }
    }

    // Nothing fits and nothing was pinned: the honest answer is an error
    // that says what did not fit. A silent over-budget run is the one
    // outcome a cost cap must never produce.
    throw new Error(
      `No model on "${provider.name}" fits the requested limits: ${JSON.stringify(requirements)}`,
    )
  }

  async complete(
    requirements: ModelRequirements = {},
    prompt: string,
    hooks?: CompletionHooks,
    options?: CompletionOptions,
  ): Promise<{
    route: ModelRoute
    text: string
  }> {
    const route = await this.select(requirements)

    const provider = this.providers.find(
      candidate => candidate.name === route.provider,
    )

    if (!provider) {
      throw new Error(
        `Provider "${route.provider}" disappeared after route selection`,
      )
    }

    const text = await provider.complete(
      route.model,
      prompt,
      requirements.images,
      hooks,
      {
        ...options,
        // The seat rides along so the provider can attribute the tokens to
        // the teammate that spent them.
        seat: options?.seat ?? requirements.seat,
      },
    )

    return {
      route,
      text,
    }
  }
}

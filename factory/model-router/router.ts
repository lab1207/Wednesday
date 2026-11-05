import type {
  CompletionHooks,
  ModelProvider,
  ModelRequirements,
  ModelRoute,
  ModelRouter,
} from './types'

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

  async select(
    requirements: ModelRequirements = {},
  ): Promise<ModelRoute> {
    const pinned = this.pinnedProvider(requirements.preferredModel)
    if (pinned) {
      return {
        provider: pinned.name,
        model: (requirements.preferredModel ?? '').trim().slice(pinned.name.length + 1),
      }
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

    return {
      provider: provider.name,
      model: models[0],
    }
  }

  async complete(
    requirements: ModelRequirements = {},
    prompt: string,
    hooks?: CompletionHooks,
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
    )

    return {
      route,
      text,
    }
  }
}
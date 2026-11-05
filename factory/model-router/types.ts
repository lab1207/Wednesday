export type ModelCapability =
  | 'general'
  | 'coding'
  | 'reasoning'
  | 'vision'

export interface ModelRequirements {
  capability?: ModelCapability
  maxCost?: number
  maxLatencyMs?: number
  contextTokens?: number
  localOnly?: boolean
  /**
   * Lane pin (2026-10-13, team duel/vote): the executor sets this per
   * lane/ballot so each runs a different pool model. Honored by every
   * provider with `selectModel` (2026-10-16: all of them); providers
   * without it use legacy routing. Blank/absent = legacy, byte-identical.
   */
  preferredModel?: string
  /**
   * Image attachments (2026-10-16, vision lanes/probes): data URIs or
   * URLs. Providers with an image path send them as image parts;
   * text-only providers ignore them. Absent = text prompt as before.
   */
  images?: string[]
}

export interface ModelRoute {
  provider: string
  model: string
}

/**
 * Live hooks a caller can attach to one completion.
 *
 * `onReasoning` receives the model's reasoning as it arrives (SSE providers
 * deliver it piece by piece). The seat runners forward it to the event bus so
 * the operator can watch a seat THINK instead of watching a spinner
 * (operator, 2026-11-04).
 */
export interface CompletionHooks {
  onReasoning?: (piece: string) => void
}

export interface ModelProvider {
  readonly name: string

  supports(requirements: ModelRequirements): boolean

  listModels(): Promise<string[]>

  /**
   * Optional capability-aware pick (2026-09-23, trio routing). When
   * present the router calls it instead of `listModels()[0]` so one
   * provider can serve different models per capability (planner vs
   * coder vs vision on the Colab trio). Absent = legacy behavior.
   */
  selectModel?(
    requirements: ModelRequirements,
  ): Promise<string> | string

  complete(
    model: string,
    prompt: string,
    images?: string[],
    hooks?: CompletionHooks,
  ): Promise<string>
}

export interface ModelRouter {
  select(requirements?: ModelRequirements): Promise<ModelRoute>

  complete(
    requirements: ModelRequirements | undefined,
    prompt: string,
    hooks?: CompletionHooks,
  ): Promise<{
    route: ModelRoute
    text: string
  }>
}
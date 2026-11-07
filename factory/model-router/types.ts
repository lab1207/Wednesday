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
   * The SEAT this call belongs to (2026-11-05).
   *
   * The factory runs a TEAM: a planner seat, a coder seat, a reviewer seat.
   * Usage was recorded per provider+model only, so the operator could see
   * "3B, 4 calls" and never "the reviewer seat cost me 40 minutes". The seat
   * name rides the requirement, the router forwards it, and the provider
   * attributes the tokens to it.
   */
  seat?: string
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

/**
 * One native tool the model may call.
 *
 * Only the CODER seat had tools, and only because it ran through the dsh
 * worker: the planner, tester and reviewer were handed a raw prompt and had
 * to return PERFECT JSON, because the provider contract had nowhere to say
 * "answer with this schema" (2026-11-05). A 1B model that wraps its verdict
 * in one stray quote had its verdict silently dropped.
 */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters?: Record<string, unknown>
}

/**
 * Per-call knobs the factory can turn (2026-11-05).
 *
 * Before this, the provider contract was one prompt in and one string out:
 * no `tools`, no `response_format`, no `max_tokens`, no `temperature`, no
 * `stop`. Every model therefore ran on the SERVER's defaults, and a 1B model
 * whose review verdict had to be JSON got whatever sampling the server
 * happened to use. These options are optional, so every existing call site
 * keeps working byte-identically.
 */
export interface CompletionOptions {
  /** Native tool definitions. Sent only when the provider is asked for them. */
  tools?: ToolSpec[]
  /** 'auto' lets the model decide, 'required' forces a call, 'none' forbids. */
  toolChoice?: 'auto' | 'none' | 'required'
  /** Ask the server for JSON-shaped output. */
  responseFormat?: 'text' | 'json_object'
  /** Hard cap on output tokens. 0 or absent = let the server decide. */
  maxTokens?: number
  temperature?: number
  /** Stop sequences. */
  stop?: string[]
  /**
   * Which SEAT made this call (attribution only - not a model knob).
   *
   * The router fills it from `ModelRequirements.seat`. The provider uses it
   * to attribute tokens and wall-clock time to the teammate that spent
   * them, so `/stats` can answer "what did the reviewer seat cost?".
   */
  seat?: string
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
    options?: CompletionOptions,
  ): Promise<string>
}

export interface ModelRouter {
  select(requirements?: ModelRequirements): Promise<ModelRoute>

  complete(
    requirements: ModelRequirements | undefined,
    prompt: string,
    hooks?: CompletionHooks,
    options?: CompletionOptions,
  ): Promise<{
    route: ModelRoute
    text: string
  }>
}
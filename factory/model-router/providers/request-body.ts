/**
 * The shared chat-completions request body (2026-11-05).
 *
 * Four providers post to four different hosts with the same body shape, and
 * until now each one hand-rolled it. That is why NONE of them sent
 * `max_tokens`, none sent `response_format`, none sent `temperature`, and
 * none could send tools: every model ran on the server's defaults, and a
 * 1B model whose review verdict had to be JSON got whatever sampling the
 * server happened to use.
 *
 * One builder now decides what goes on the wire:
 *  - `max_tokens` comes from the MODEL REGISTRY when the caller did not set
 *    one, so a small model is asked for a small answer and a big one is not
 *    cut short.
 *  - `tools` and `response_format` are sent only when asked for. A server
 *    that does not understand them errors out, so the factory never sends
 *    them speculatively.
 *  - `temperature` and `stop` are sent only when the caller sets them,
 *    because a default the operator did not choose is a default they cannot
 *    account for.
 */
import type { CompletionOptions, ToolSpec } from '../types'
import { maxOutputFor, supportsToolsFor } from '../model-registry'
import { userContent } from './chat'

/** A tool in the OpenAI wire shape. */
function wireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }
}

export interface ChatBodyInput {
  model: string
  prompt: string
  images?: string[]
  options?: CompletionOptions
  /** The provider name, so the registry can be asked provider-aware. */
  provider?: string
}

export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
  const { model, prompt, images, options, provider } = input
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'user',
        content: userContent(prompt, images),
      },
    ],
  }

  const maxTokens = options?.maxTokens ?? maxOutputFor(model, provider)
  if (maxTokens > 0) body.max_tokens = maxTokens

  if (options?.temperature !== undefined) body.temperature = options.temperature

  if (options?.stop && options.stop.length > 0) body.stop = options.stop

  if (options?.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' }
  }

  const tools = options?.tools ?? []
  if (tools.length > 0) {
    body.tools = tools.map(wireTool)
    body.tool_choice = options?.toolChoice ?? 'auto'
  }

  return body
}

/**
 * Should this call carry native tools at all? (pure)
 *
 * The registry knows whether the model was TRAINED for tool calls. A model
 * that was not will either ignore the tools or answer with prose about them
 * - and prose about tools is how a coder seat "calls" a tool by writing a
 * JSON block as text. So when the registry says no, the caller is told to
 * use the fenced-tool path instead.
 */
export function canUseNativeTools(
  model: string,
  provider?: string,
): boolean {
  return supportsToolsFor(model, provider)
}

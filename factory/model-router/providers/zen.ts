import type { CompletionHooks, ModelProvider, ModelRequirements } from '../types'
import { recordUsage } from '../usage'
import { describeBody } from './failure'
import { Agent, fetch as zenFetch } from 'undici'

/**
 * OpenCode Zen route (OpenAI-compatible chat completions).
 *
 * Registered only when `FACTORY_LLM_PROVIDER=zen`. Base URL, key and model
 * come from ZEN_BASE_URL / ZEN_API_KEY / ZEN_MODEL (all trimmed - pasted
 * values trail whitespace). Streams like the local route (same long-
 * generation timeout reasoning) and records usage; cost stays unknown
 * (null) until Zen pricing is pinned in usage.ts.
 */

const NO_TIMEOUT_ZEN = new Agent({ bodyTimeout: 0, headersTimeout: 0 })

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1'
const DEFAULT_MODEL = 'nemotron-3-ultra-free'

interface ZenChatDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

interface ZenChatChunk {
  choices?: Array<{ delta?: ZenChatDelta }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

function endpoint(baseURL: string | undefined): string {
  return (baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export class ZenProvider implements ModelProvider {
  readonly name = 'zen'

  supports(_requirements: ModelRequirements): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    const configured = process.env.ZEN_MODEL?.trim()
    return [configured && configured.length > 0 ? configured : DEFAULT_MODEL]
  }

  /**
   * Team pin (2026-10-16, R-BM-21): a lane/ballot pin wins outright so
   * every pool model runs its own lanes on this route too. Unpinned =
   * legacy configured-model resolution, byte-identical.
   */
  async selectModel(
    requirements: ModelRequirements,
  ): Promise<string> {
    const pinned = (requirements.preferredModel ?? '').trim()
    if (pinned) return pinned
    return (await this.listModels())[0]
  }

  // NOTE (2026-10-16, R-BM-28): image attachments are accepted and
  // ignored on this route (it serves text free models); vision lanes
  // run on local/OpenRouter until a Zen vision model is configured.
  async complete(model: string, prompt: string, _images?: string[], hooks?: CompletionHooks): Promise<string> {
    const cleanModel = model.trim()
    const apiKey = process.env.ZEN_API_KEY?.trim()

    if (!apiKey) {
      throw new Error(
        'ZEN_API_KEY is not set (add it to ~/.wednesday/.env yourself; never chat or repo).',
      )
    }

    const response = await zenFetch(
      `${endpoint(process.env.ZEN_BASE_URL)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cleanModel,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          stream_options: { include_usage: true },
        }),
        dispatcher: NO_TIMEOUT_ZEN,
      },
    )

    if (!response.ok) {
      const rawBody = await response.text()
      throw new Error(`Zen request failed: ${response.status} — ${describeBody(rawBody)}`)
    }

    const body = response.body
    if (!body) {
      throw new Error('Zen response had no body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let promptTokens = 0
    let completionTokens = 0
    let sawUsage = false

    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      let data: ZenChatChunk
      try {
        data = JSON.parse(payload) as ZenChatChunk
      } catch {
        return
      }
      const delta = data.choices?.[0]?.delta
      if (delta) {
        const piece = readText(delta.content)
        if (piece) content += piece
        else if (readText(delta.reasoning_content)) {
          const thought = readText(delta.reasoning_content)
          reasoning += thought
          // Live reasoning, piece by piece — the operator asked to watch the
          // seat think, not to wait for the whole answer.
          hooks?.onReasoning?.(thought)
        } else if (readText(delta.reasoning)) {
          const thought = readText(delta.reasoning)
          reasoning += thought
          hooks?.onReasoning?.(thought)
        }
      }
      if (data.usage) {
        sawUsage = true
        promptTokens = data.usage.prompt_tokens ?? 0
        completionTokens = data.usage.completion_tokens ?? 0
      }
    }

    for await (const chunk of body) {
      buffer += decoder.decode(chunk as BufferSource, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        consumeLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      consumeLine(buffer)
    }

    if (sawUsage) {
      recordUsage(this.name, cleanModel, promptTokens, completionTokens)
    }

    const text = content.trim() || reasoning.trim()
    if (text) {
      return text
    }
    throw new Error('Zen returned no usable assistant content')
  }
}

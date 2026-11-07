import type { CompletionHooks, CompletionOptions, ModelProvider, ModelRequirements } from '../types'
import { recordSeatUsage, recordUsage } from '../usage'
import { buildChatBody } from './request-body'
import { consumeChatStream } from './sse'
import { stripThinking } from '../crew-routing'
import { fetchWithRetry, resolveRetryConfig } from '../retry'
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

function endpoint(baseURL: string | undefined): string {
  return (baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
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
  async complete(
    model: string,
    prompt: string,
    _images?: string[],
    hooks?: CompletionHooks,
    options?: CompletionOptions,
  ): Promise<string> {
    const cleanModel = model.trim()
    const apiKey = process.env.ZEN_API_KEY?.trim()

    if (!apiKey) {
      throw new Error(
        'ZEN_API_KEY is not set (add it to ~/.wednesday/.env yourself; never chat or repo).',
      )
    }

    const startedAt = Date.now()

    // Retry (2026-11-05): this route had none, so a transient 503 killed the
    // seat on the first try while the two hosted routes replayed it.
    const requestBody = buildChatBody({
      model: cleanModel,
      prompt,
      options,
      provider: this.name,
    })
    requestBody.stream = true
    requestBody.stream_options = { include_usage: true }

    const response = await fetchWithRetry(
      zenFetch as unknown as (url: string, init: object) => Promise<Response>,
      `${endpoint(process.env.ZEN_BASE_URL)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        dispatcher: NO_TIMEOUT_ZEN,
      } as object,
      resolveRetryConfig(),
    )

    const elapsedMs = Date.now() - startedAt

    if (!response.ok) {
      const rawBody = await response.text()
      throw new Error(`Zen request failed: ${response.status} — ${describeBody(rawBody)}`)
    }

    const streamed = await consumeChatStream(response, hooks)

    if (streamed.promptTokens > 0 || streamed.completionTokens > 0) {
      recordUsage(this.name, cleanModel, streamed.promptTokens, streamed.completionTokens, elapsedMs)
    }
    recordSeatUsage(
      options?.seat ?? '',
      this.name,
      cleanModel,
      streamed.promptTokens,
      streamed.completionTokens,
      elapsedMs,
    )

    // The reasoning is shown live; it is never handed on AS the answer.
    const text = stripThinking(streamed.content.trim())
    if (text) {
      return text
    }
    if (streamed.reasoning.trim()) {
      throw new Error('Zen produced only reasoning and no answer')
    }
    throw new Error('Zen returned no usable assistant content')
  }
}

import type {
  CompletionHooks,
  ModelProvider,
  ModelRequirements,
} from '../types'

import {
  recordUsage,
} from '../usage'

import {
  fetchWithRetry,
  resolveRetryConfig,
  resolveThrottleMs,
  throttleShared,
} from '../retry'

import { userContent } from './chat'

import { describeBody } from './failure'

import {
  isFreePoolEnabled,
  listFreeModels,
  pickFreeModel,
  preferredFreeModels,
} from '../free-pool'

interface OpenRouterChoice {
  message?: {
    content?: unknown
    reasoning?: unknown
    reasoning_content?: unknown
  }
  text?: unknown
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
  output_text?: unknown
  output?: unknown
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter'

  supports(
    requirements: ModelRequirements,
  ): boolean {
    return requirements.localOnly !== true
  }

  async listModels(): Promise<string[]> {
    const configured = String(
      process.env.DSH_LLM_MODEL ??
      'stealth/ox-alpha',
    )

    // Free-pool resolver (2026-09-23): prefer a live `:free` model so
    // flapping paid pools fail over instead of dying. Any failure
    // (disabled, offline, empty pool) falls back to the configured id —
    // today's behavior is the floor.
    if (isFreePoolEnabled()) {
      try {
        const winner = pickFreeModel(
          await listFreeModels(),
          preferredFreeModels(),
        )
        if (winner) return [winner]
      } catch {
        // Fail open to the configured model below.
      }
    }

    return [configured]
  }

  /**
   * Team pin (2026-10-16, R-BM-21): a lane/ballot pin wins outright so
   * every pool model runs its own lanes on this route too. Unpinned =
   * legacy free-pool/default resolution, byte-identical.
   */
  async selectModel(
    requirements: ModelRequirements,
  ): Promise<string> {
    const pinned = (requirements.preferredModel ?? '').trim()
    if (pinned) return pinned
    return (await this.listModels())[0]
  }

  async complete(
    model: string,
    prompt: string,
    images?: string[],
    hooks?: CompletionHooks,
  ): Promise<string> {
    const apiKey =
      process.env.OPENROUTER_API_KEY

    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set',
      )
    }

    // Shared live guardrails (2026-09-23): throttle spaces calls for RPM
    // caps, fetchWithRetry replays 429/502/503/504 with backoff. The
    // provider still throws on the final failure exactly as before.
    await throttleShared(resolveThrottleMs())

    const retry = resolveRetryConfig()

    const response = await fetchWithRetry(
      fetch,
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: userContent(prompt, images),
            },
          ],
        }),
      },
      retry,
    )

    const rawBody = await response.text()

    if (!response.ok) {
      throw new Error(
        `OpenRouter request failed: ${response.status} — ${describeBody(rawBody)}`,
      )
    }

    let data: OpenRouterResponse

    try {
      data = JSON.parse(
        rawBody,
      ) as OpenRouterResponse
    } catch {
      throw new Error(
        `OpenRouter returned invalid JSON: ${describeBody(rawBody)}`,
      )
    }

    if (data.usage !== undefined) {
      recordUsage(
        this.name,
        model,
        data.usage.prompt_tokens ?? 0,
        data.usage.completion_tokens ?? 0,
      )
    }

    const choice =
      data.choices?.[0]

    const content =
      choice?.message?.content

    if (typeof content === 'string' &&
        content.trim()) {
      return content
    }

    if (Array.isArray(content)) {
      const text = content
        .map(part => {
          if (
            typeof part === 'object' &&
            part !== null &&
            'text' in part
          ) {
            return String(
              (part as { text?: unknown }).text ??
              '',
            )
          }

          return ''
        })
        .join('')
        .trim()

      if (text) {
        return text
      }
    }

    const reasoning =
      choice?.message?.reasoning

    if (
      typeof reasoning === 'string' &&
      reasoning.trim()
    ) {
      // This route does not stream, so the reasoning arrives whole — but it is
      // still the model's own reasoning, and the operator asked to see it.
      hooks?.onReasoning?.(reasoning)
      return reasoning
    }

    const reasoningContent =
      choice?.message?.reasoning_content

    if (
      typeof reasoningContent === 'string' &&
      reasoningContent.trim()
    ) {
      hooks?.onReasoning?.(reasoningContent)
      return reasoningContent
    }

    if (
      typeof data.output_text === 'string' &&
      data.output_text.trim()
    ) {
      return data.output_text
    }

    if (
      typeof data.output === 'string' &&
      data.output.trim()
    ) {
      return data.output
    }

    throw new Error(
      `OpenRouter returned no usable assistant content: ${rawBody}`,
    )
  }
}
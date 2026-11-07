import type {
  CompletionHooks,
  CompletionOptions,
  ModelProvider,
  ModelRequirements,
} from '../types'

import {
  recordSeatUsage,
  recordUsage,
} from '../usage'

import {
  fetchWithRetry,
  resolveRetryConfig,
  resolveThrottleMs,
  throttleShared,
} from '../retry'

import { buildChatBody } from './request-body'
import { consumeChatStream } from './sse'
import { stripThinking } from '../crew-routing'

import { describeBody } from './failure'

import {
  isFreePoolEnabled,
  listFreeModels,
  pickFreeModel,
  preferredFreeModels,
} from '../free-pool'

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
    options?: CompletionOptions,
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
    const startedAt = Date.now()

    // The route STREAMS now (2026-11-05). It used to read the whole body
    // with `await response.text()`, so the operator watched a silent spinner
    // for a minute on a small model and, when the socket dropped, lost every
    // token of the answer. The shared reader handles both shapes: SSE and a
    // server that answers plain JSON anyway.
    const requestBody = buildChatBody({
      model,
      prompt,
      images,
      options,
      provider: this.name,
    })
    requestBody.stream = true

    const response = await fetchWithRetry(
      fetch,
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      retry,
    )

    const elapsedMs = Date.now() - startedAt

    if (!response.ok) {
      const rawBody = await response.text()
      throw new Error(
        `OpenRouter request failed: ${response.status} — ${describeBody(rawBody)}`,
      )
    }

    const streamed = await consumeChatStream(response, hooks)

    if (streamed.promptTokens > 0 || streamed.completionTokens > 0) {
      recordUsage(
        this.name,
        model,
        streamed.promptTokens,
        streamed.completionTokens,
        elapsedMs,
      )
    }
    recordSeatUsage(
      options?.seat ?? '',
      this.name,
      model,
      streamed.promptTokens,
      streamed.completionTokens,
      elapsedMs,
    )

    // The answer is the CONTENT. Reasoning is shown live (the operator asked
    // to see it) but is never handed on AS the answer: a scratchpad that
    // reaches the next stage breaks its JSON and silently mutes the seat.
    const text = stripThinking(streamed.content.trim())

    if (text) {
      return text
    }

    // OpenRouter's Responses-style models answer with `output_text` /
    // `output` at the top level instead of `choices`.
    const raw = streamed.raw as {
      output_text?: unknown
      output?: unknown
    } | undefined
    const outputText = typeof raw?.output_text === 'string' ? raw.output_text.trim() : ''
    if (outputText) return outputText
    const output = typeof raw?.output === 'string' ? raw.output.trim() : ''
    if (output) return output

    if (streamed.reasoning.trim()) {
      throw new Error(
        'OpenRouter produced only reasoning and no answer',
      )
    }

    throw new Error(
      'OpenRouter returned no usable assistant content',
    )
  }
}
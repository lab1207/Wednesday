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

/**
 * NVIDIA provider slice (2026-09-23, offline-green).
 *
 * `FACTORY_LLM_PROVIDER=nvidia` routes every live role to the NVIDIA
 * Build endpoint (OpenAI-compatible `/chat/completions`). Key is BYO
 * from the profile (`~/.wednesday/.env` as `NVIDIA_API_KEY`) — never
 * in chat args or the repo. Default model is the serving-proven
 * `nvidia/nemotron-3.5-lightning-30b-a3b` (200 OK, 42 tokens, 2026-09-22);
 * override with `NVIDIA_LLM_MODEL`, base with `NVIDIA_BASE_URL`.
 *
 * Retry + throttle land in the next slice as a shared helper used by
 * both this provider and OpenRouter; this file stays a thin client.
 */

export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b'

/** Trimmed key from the environment (empty when unset). */
export function resolveNvidiaKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (env.NVIDIA_API_KEY ?? '').trim()
}

/** Configured model or the serving-proven default (pure). */
export function resolveNvidiaModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (env.NVIDIA_LLM_MODEL ?? '').trim()
  return configured || NVIDIA_DEFAULT_MODEL
}

/** Configured base URL or the Build default (pure). */
export function resolveNvidiaBaseURL(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (env.NVIDIA_BASE_URL ?? '').trim()
  return (configured || NVIDIA_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export class NvidiaProvider implements ModelProvider {
  readonly name = 'nvidia'

  supports(
    requirements: ModelRequirements,
  ): boolean {
    return requirements.localOnly !== true
  }

  async listModels(): Promise<string[]> {
    return [resolveNvidiaModel()]
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

  async complete(
    model: string,
    prompt: string,
    images?: string[],
    hooks?: CompletionHooks,
    options?: CompletionOptions,
  ): Promise<string> {
    const apiKey = resolveNvidiaKey()

    if (!apiKey) {
      throw new Error(
        'NVIDIA_API_KEY is not set',
      )
    }

    // Shared live guardrails (2026-09-23): throttle spaces calls for RPM
    // caps, fetchWithRetry replays 429/502/503/504 with backoff. The
    // provider still throws on the final failure exactly as before.
    await throttleShared(resolveThrottleMs())

    const retry = resolveRetryConfig()
    const startedAt = Date.now()
    const cleanModel = model.trim() || resolveNvidiaModel()

    // The route STREAMS now (2026-11-05) - it used to buffer the whole body,
    // so the operator watched a silent spinner and lost every token when a
    // socket dropped. It also stopped DROPPING IMAGES: `_images` was
    // ignored and the prompt was sent as plain text, so a vision seat on
    // NVIDIA was a text seat in disguise.
    const requestBody = buildChatBody({
      model: cleanModel,
      prompt,
      images,
      options,
      provider: this.name,
    })
    requestBody.stream = true

    const response = await fetchWithRetry(
      fetch,
      `${resolveNvidiaBaseURL()}/chat/completions`,
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
        `NVIDIA request failed: ${response.status} — ${describeBody(rawBody)}`,
      )
    }

    const streamed = await consumeChatStream(response, hooks)

    if (streamed.promptTokens > 0 || streamed.completionTokens > 0) {
      recordUsage(
        this.name,
        cleanModel,
        streamed.promptTokens,
        streamed.completionTokens,
        elapsedMs,
      )
    }
    recordSeatUsage(
      options?.seat ?? '',
      this.name,
      cleanModel,
      streamed.promptTokens,
      streamed.completionTokens,
      elapsedMs,
    )

    const text = stripThinking(streamed.content.trim())

    if (text) {
      return text
    }

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
        'NVIDIA produced only reasoning and no answer',
      )
    }

    throw new Error(
      'NVIDIA returned no usable assistant content',
    )
  }
}


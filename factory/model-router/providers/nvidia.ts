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

interface NvidiaChoice {
  message?: {
    content?: unknown
    reasoning?: unknown
    reasoning_content?: unknown
  }
  text?: unknown
}

interface NvidiaResponse {
  choices?: NvidiaChoice[]
  output_text?: unknown
  output?: unknown
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
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
    _images?: string[],
    hooks?: CompletionHooks,
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

    const response = await fetchWithRetry(
      fetch,
      `${resolveNvidiaBaseURL()}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.trim() || resolveNvidiaModel(),
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      },
      retry,
    )

    const rawBody = await response.text()

    if (!response.ok) {
      throw new Error(
        `NVIDIA request failed: ${response.status} — ${describeBody(rawBody)}`,
      )
    }

    let data: NvidiaResponse

    try {
      data = JSON.parse(
        rawBody,
      ) as NvidiaResponse
    } catch {
      throw new Error(
        `NVIDIA returned invalid JSON: ${describeBody(rawBody)}`,
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
      `NVIDIA returned no usable assistant content: ${describeBody(rawBody)}`,
    )
  }
}

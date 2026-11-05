import type { CompletionHooks, ModelProvider, ModelRequirements } from '../types'
import { recordUsage } from '../usage'
import { userContent } from './chat'
import { describeBody } from './failure'
import {
  crewBaseURLForModel,
  isCrewPoolConfigured,
  resolveCrewModel,
  stripThinking,
} from '../crew-routing'
import { bestFitFor } from '../model-capabilities'
import { clampPrompt, resolvePromptBudget } from '../prompt-budget'
import { recordTrimmedPrompt } from '../trim-report'
import { Agent, fetch as localFetch } from 'undici'
import { connect } from 'node:net'

/**
 * OpenAI-compatible local model route (Jan / llama.cpp / any local server).
 *
 * Registered only when `FACTORY_LLM_PROVIDER=local`, so it answers every
 * requirement for that run. No credential is issued by the server; the
 * placeholder key satisfies the client's bearer header.
 *
 * The request streams (SSE): on slow local hardware a generation can outlast
 * Node's default 300s undici body timeout, and a buffered response sends no
 * bytes during that window, so the socket gets force-closed mid-answer.
 * Streaming keeps bytes flowing until the final `[DONE]`, and the model's
 * usage chunk is captured from the stream. The dispatcher below disables the
 * 300s cap entirely, because even streaming can be byte-silent for minutes
 * while a slow CPU prefills a large prompt before the first token.
 */

const NO_TIMEOUT_LOCAL = new Agent({ bodyTimeout: 0, headersTimeout: 0 })

const DEFAULT_BASE_URL = 'http://127.0.0.1:1337/v1'
const DEFAULT_MODEL = 'Qwen3_5-4B-IQ4_XS'

/**
 * Layer audit 2026-09-21: fail fast before a benchmark, not per problem.
 * A dead proxy/tunnel used to surface as N slow per-problem failures;
 * a TCP handshake proves the route is alive in milliseconds (it says
 * nothing about the model itself — that still needs a real call).
 */
export function checkLocalUpstream(
  baseURL: string = process.env.LOCAL_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
  timeoutMs = 5000,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise(resolve => {
    let parsed: URL
    try {
      parsed = new URL(baseURL)
    } catch {
      resolve({ ok: false, error: `unparseable LOCAL_LLM_BASE_URL: ${baseURL}` })
      return
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    const started = Date.now()
    const socket = connect({ host: parsed.hostname, port })
    const done = (result: { ok: boolean; latencyMs?: number; error?: string }): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ ok: true, latencyMs: Date.now() - started }))
    socket.once('timeout', () => done({ ok: false, error: `no route to ${parsed.hostname}:${port} in ${timeoutMs}ms (proxy/tunnel down?)` }))
    socket.once('error', (err: Error) => {
      // Node's own message repeats the endpoint ("connect ECONNREFUSED
      // 127.0.0.1:18090"), which pushed the doctor row past 80 columns and
      // wrapped a bare host:port onto its own unindented line. The errno code
      // says the same thing in one word.
      const code = (err as NodeJS.ErrnoException).code
      done({ ok: false, error: `no route to ${parsed.hostname}:${port}: ${code ?? err.message}` })
    })
  })
}

interface LocalChatDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

interface LocalChatChoice {
  delta?: LocalChatDelta
  message?: LocalChatDelta
}

interface LocalChatChunk {
  choices?: LocalChatChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export class LocalProvider implements ModelProvider {
  readonly name = 'local'

  supports(_requirements: ModelRequirements): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    // Trim: copy-paste from terminals/shells routinely trails whitespace
    // (a trailing space once 404'd every benchmark run - the model id
    // must match exactly).
    const configured =
      process.env.LOCAL_LLM_MODEL?.trim()

    return [
      configured && configured.length > 0
        ? configured
        : DEFAULT_MODEL,
    ]
  }

  /**
   * Trio routing (2026-09-23) + capability fit (2026-10-13): with a
   * user-connected pool, the legacy slot pick (reasoning->planner,
   * vision->vision, else coder) is only the FALLBACK. When
   * `setModelFit` holds probe scores, the best scorer per capability
   * wins instead — one strong model may serve several roles at once.
   * Without a pool or without scores the legacy applies byte-identical.
   */
  selectModel(
    requirements: ModelRequirements,
  ): string {
    // Lane pin wins (team duel/vote): the executor names the pool model
    // for this lane. Trusted as-is (the executor derives it from the
    // parsed pool); blank falls through to capability routing below.
    const pinned = (requirements.preferredModel ?? '').trim()
    if (pinned) return pinned
    const legacy = (() => {
      const configured = process.env.LOCAL_LLM_MODEL?.trim()
      return configured && configured.length > 0
        ? configured
        : DEFAULT_MODEL
    })()
    if (!isCrewPoolConfigured()) return legacy
    if (requirements.capability === 'reasoning') {
      return bestFitFor('reasoning', resolveCrewModel('planner'))
    }
    if (requirements.capability === 'vision') {
      return bestFitFor('vision', resolveCrewModel('vision'))
    }
    return bestFitFor(
      'coding',
      process.env.LOCAL_LLM_MODEL?.trim() || resolveCrewModel('coder'),
    )
  }

  async complete(
    model: string,
    prompt: string,
    images?: string[],
    hooks?: CompletionHooks,
  ): Promise<string> {
    const cleanModel = model.trim()

    // Fit the window BEFORE the request. A local/tunnel model with a 13K
    // context silently head-truncates a 25K prompt, so the operator's build
    // ignores half its own instructions and reads as a bad model (B150).
    const budget = clampPrompt(prompt, resolvePromptBudget())
    if (budget.trimmed > 0) {
      prompt = budget.prompt
      recordTrimmedPrompt(cleanModel, budget.before, budget.after)
    }

    const apiKey =
      process.env.LOCAL_LLM_API_KEY?.trim() ||
      'local'

    const response = await localFetch(
      // Per-model tunnel (2026-09-23): the model id picks its Colab
      // box (planner/coder on A, vision on B by default) instead of
      // every call sharing one base URL.
      `${crewBaseURLForModel(cleanModel)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          model: cleanModel,
          messages: [
            {
              role: 'user',
              content: userContent(prompt, images),
            },
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
        dispatcher: NO_TIMEOUT_LOCAL,
      },
    )

    if (!response.ok) {
      const rawBody = await response.text()
      throw new Error(
        `Local model request failed: ${response.status} — ${describeBody(rawBody)}`,
      )
    }

    const body = response.body

    if (!body) {
      throw new Error('Local model response had no body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let promptTokens = 0
    let completionTokens = 0
    let sawUsage = false

    // A choice carries either streaming `delta` or (non-streaming servers)
    // a full `message` — both share the same content shape.
    const consumeData = (data: LocalChatChunk): void => {
      const choice = data.choices?.[0]
      const part = choice?.delta ?? choice?.message

      if (part) {
        const piece = readText(part.content)
        if (piece) content += piece
        else if (readText(part.reasoning_content)) {
          const thought = readText(part.reasoning_content)
          reasoning += thought
          // Live reasoning: the piece goes to the caller as it arrives, so the
          // operator watches the seat think. The reasoning is still stripped
          // from the ANSWER below — this only opens a window on it.
          hooks?.onReasoning?.(thought)
        } else if (readText(part.reasoning)) {
          const thought = readText(part.reasoning)
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

    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return

      let data: LocalChatChunk

      try {
        data = JSON.parse(payload) as LocalChatChunk
      } catch {
        return
      }

      consumeData(data)
    }

    const providerName = this.name
    const finishCompletion = (): string => {
      if (sawUsage) {
        recordUsage(providerName, cleanModel, promptTokens, completionTokens)
      }

      // Thinking-strip (2026-09-23): R1 leaks `<think>` reasoning into
      // answers on the Colab trio route — strip before returning so only
      // the final answer flows downstream. Clean text passes untouched.
      const text = stripThinking(content.trim() || reasoning.trim())

      if (text) {
        return text
      }

      throw new Error('Local model returned no usable assistant content')
    }

    // Some OpenAI-compatible servers (e.g. the Colab FastAPI trio,
    // 2026-09-27) answer plain JSON even when `stream: true` was asked
    // for. Detect the shape instead of assuming SSE: a body with no
    // `data:` lines parses once as a full chat completion.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const raw = (await response.text()).trim()
      if (!raw.includes('data:')) {
        let data: LocalChatChunk

        try {
          data = JSON.parse(raw) as LocalChatChunk
        } catch {
          throw new Error('Local model returned no usable assistant content')
        }

        consumeData(data)
        return finishCompletion()
      }
      // SSE bytes under a non-SSE content-type: fall through to the
      // line parser below with the buffered text as the first chunk.
      buffer = raw
    }

    // A pre-buffered SSE body (non-SSE content-type fallback above) is
    // split into lines up front; the live stream below then finds the
    // body already consumed and yields nothing more.
    if (buffer.includes('\n')) {
      for (const line of buffer.split('\n')) consumeLine(line)
      buffer = ''
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

    return finishCompletion()
  }
}
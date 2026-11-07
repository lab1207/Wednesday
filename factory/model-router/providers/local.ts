import type { CompletionHooks, CompletionOptions, ModelProvider, ModelRequirements } from '../types'
import { recordSeatUsage, recordUsage } from '../usage'
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
import { buildChatBody } from './request-body'
import { listLocalModels, cachedServerContextWindow } from '../local-servers'
import { fetchWithRetry, resolveRetryConfig } from '../retry'
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

  /**
   * What the operator's own machine can serve (2026-11-05).
   *
   * This used to return ONE configured id and never ask the server. The
   * consequence was blunt: `wednesday` could not see the models running on
   * the operator's own box, so "staff a team from what I have locally" was
   * impossible - the operator had to know and type every id. Now the route
   * asks the server what it has (`GET /models`, with Ollama's `/api/tags`
   * fallback) and falls back to the configured id when the server cannot be
   * reached - never to an empty list, because an empty list reads as "this
   * server has no models" when the truth is "I could not ask".
   */
  async listModels(): Promise<string[]> {
    // Trim: copy-paste from terminals/shells routinely trails whitespace
    // (a trailing space once 404'd every benchmark run - the model id
    // must match exactly).
    const configured =
      process.env.LOCAL_LLM_MODEL?.trim()

    const baseURL = crewBaseURLForModel(configured ?? '') ||
      process.env.LOCAL_LLM_BASE_URL?.trim() ||
      DEFAULT_BASE_URL

    try {
      const served = await listLocalModels(baseURL, 3000)
      const ids = served.map(id => id.trim()).filter(id => id.length > 0)
      if (ids.length > 0) {
        // The configured model stays first: it is the operator's explicit
        // choice and must win the default pick.
        if (configured && ids.includes(configured)) {
          return [configured, ...ids.filter(id => id !== configured)]
        }
        return configured ? [configured, ...ids] : ids
      }
    } catch {
      // The server could not be asked. Fall through to the configured id.
    }

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
    options?: CompletionOptions,
  ): Promise<string> {
    const cleanModel = model.trim()

    // Which server answers this model, and what window is IT running with?
    // The deployment's window can be smaller than the model's own (a 13K
    // Colab box serving a 32K model), and the smaller one is the real one.
    const baseURL = crewBaseURLForModel(cleanModel)
    const serverWindow = await cachedServerContextWindow(baseURL)

    // Fit the window BEFORE the request, against THIS model's real window
    // (2026-11-05): the route used to assume every local model had one
    // hardcoded 13,312-token window, so a 32K model was cut at 13K and a
    // 8K model was allowed 13K (the server then truncated the head of the
    // prompt, and the operator read that as a bad model - B150).
    const budget = clampPrompt(
      prompt,
      resolvePromptBudget(process.env, cleanModel, serverWindow),
    )
    if (budget.trimmed > 0) {
      prompt = budget.prompt
      recordTrimmedPrompt(cleanModel, budget.before, budget.after)
    }

    const apiKey =
      process.env.LOCAL_LLM_API_KEY?.trim() ||
      'local'

    const startedAt = Date.now()

    // The stream flags belong to the BODY, not to the request envelope.
    const requestBody = buildChatBody({
      model: cleanModel,
      prompt,
      images,
      options,
      provider: this.name,
    })
    requestBody.stream = true
    requestBody.stream_options = { include_usage: true }

    const response = await fetchWithRetry(
      localFetch as unknown as (url: string, init: object) => Promise<Response>,
      // Per-model tunnel (2026-09-23): the model id picks its Colab
      // box (planner/coder on A, vision on B by default) instead of
      // every call sharing one base URL.
      `${baseURL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(requestBody),
        dispatcher: NO_TIMEOUT_LOCAL,
      } as object,
      resolveRetryConfig(),
    )

    const elapsedMs = Date.now() - startedAt

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
    const seat = options?.seat ?? ''
    const finishCompletion = (): string => {
      if (sawUsage) {
        recordUsage(providerName, cleanModel, promptTokens, completionTokens, elapsedMs)
      }
      recordSeatUsage(
        seat,
        providerName,
        cleanModel,
        promptTokens,
        completionTokens,
        elapsedMs,
      )

      // Thinking-strip (2026-09-23): R1 leaks `<think>` reasoning into
      // answers on the Colab trio route — strip before returning so only
      // the final answer flows downstream. Clean text passes untouched.
      //
      // The reasoning is NOT an answer fallback (2026-11-05). A model that
      // produced only a scratchpad has not answered, and handing the
      // scratchpad on as the answer is how a reviewer's JSON verdict became
      // a paragraph of thinking — which then failed to parse and SILENTLY
      // muted the reviewer. Failing loudly lets the repair loop retry.
      const text = stripThinking(content.trim())

      if (text) {
        return text
      }

      if (reasoning.trim()) {
        throw new Error(
          'Local model produced only reasoning and no answer',
        )
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
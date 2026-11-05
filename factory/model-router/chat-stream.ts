/**
 * Chat streaming (2026-10-30, "real chat loop" direction).
 *
 * The providers own talking to a ROLE: one prompt in, one string out,
 * buffered. The operator's TUI chat is a different shape: a conversation
 * (system + prior turns) streamed a delta at a time, over whichever route
 * the operator connected — local/tunnel, OpenRouter, or NVIDIA. This module
 * is that one path for every route, so the harness chat block stays thin.
 *
 * Route resolution mirrors the providers exactly:
 * - local — crewBaseURLForModel (per-model tunnel), placeholder key, Chrome UA.
 * - openrouter — throttle + retry, key required.
 * - nvidia — Build endpoint, key required.
 * Anything the provider layer itself would have refused surfaces here as a
 * named blocker BEFORE any request is attempted.
 */

import {
  crewBaseURLForModel,
  splitProviderPin,
  stripThinking,
} from './crew-routing'
import {
  fetchWithRetry,
  resolveRetryConfig,
  resolveThrottleMs,
  throttleShared,
} from './retry'
import { describeBody } from './providers/failure'
import { NVIDIA_DEFAULT_MODEL, resolveNvidiaBaseURL, resolveNvidiaKey } from './providers/nvidia'
import { buildIdentitySection } from '../agents/identity'
import { recordUsage } from './usage'
import { clampMessages, resolvePromptBudget } from './prompt-budget'
import { Agent, fetch as undiciFetch } from 'undici'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRoute {
  /** Label used in usage records + the operator header. */
  name: string
  baseURL: string
  apiKey: string
  model: string
  /** Extra headers (local tunnels need the browser UA). */
  headers?: Record<string, string>
  /** Local/Colab hardware: disable undici body/header timeouts entirely. */
  noTimeout?: boolean
}

/** How many remembered turns ride along (system prompt excluded). */
export const CHAT_HISTORY_CAP = 12

/** Local default mirrors LocalProvider so chat and roles agree. */
export const CHAT_LOCAL_DEFAULT_MODEL = 'qwen2.5-coder-3b-instruct'

const NO_TIMEOUT_CHAT = new Agent({ bodyTimeout: 0, headersTimeout: 0 })

/** Trimmed id; a hosted seat keeps its `/` shape, a bare local id passes as-is. */
function cleanModelID(hint: string | null, hosted: boolean): string {
  const model = (hint ?? '').trim()
  if (!model) return ''
  if (hosted && !model.includes('/')) return ''
  return model
}

/**
 * Which route chat speaks on, given the model the operator (or the active
 * crew seat) picked. `modelHint` is the crew-seat model when a team is
 * active; when that model belongs to another provider than the route
 * (a bare local id inside OpenRouter), the route's own model wins instead
 * of failing mid-conversation.
 */
export function resolveChatRoute(
  modelHint: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { route: ChatRoute } | { blocker: string } {
  // 2026-10-31 provider pins: a crew seat id like `nvidia/…` overrides the
  // route provider for this chat, so mixed-provider teams chat on their own
  // seat's provider instead of sending a prefixed id to the wrong endpoint.
  const pin = splitProviderPin(modelHint ?? '')
  const route = (pin?.provider ?? (env.FACTORY_LLM_PROVIDER ?? 'openrouter')).trim().toLowerCase()
  const hint = pin ? pin.model : (modelHint ?? '').trim()

  if (route === 'local') {
    const base = env.LOCAL_LLM_BASE_URL?.trim()
    if (!base) {
      return { blocker: 'local route selected but LOCAL_LLM_BASE_URL is not set — run /connect' }
    }
    const model =
      cleanModelID(hint, false) ||
      env.LOCAL_LLM_MODEL?.trim() ||
      CHAT_LOCAL_DEFAULT_MODEL
    return {
      route: {
        name: 'local',
        baseURL: crewBaseURLForModel(model),
        apiKey: env.LOCAL_LLM_API_KEY?.trim() || 'local',
        model,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        noTimeout: true,
      },
    }
  }

  if (route === 'nvidia') {
    const key = resolveNvidiaKey(env)
    if (!key) return { blocker: 'NVIDIA route selected but NVIDIA_API_KEY is not set' }
    const model =
      cleanModelID(hint, true) ||
      (env.NVIDIA_LLM_MODEL ?? '').trim() ||
      NVIDIA_DEFAULT_MODEL
    return {
      route: { name: 'nvidia', baseURL: resolveNvidiaBaseURL(env), apiKey: key, model },
    }
  }

  if (route === 'zen') {
    return { blocker: 'the zen route is retired — run /connect to move to OpenRouter or local' }
  }

  const key = env.OPENROUTER_API_KEY?.trim()
  if (!key) {
    return { blocker: 'OPENROUTER_API_KEY is not set — run /connect or wednesday --setup' }
  }
  const model =
    cleanModelID(hint, true) ||
    (env.DSH_LLM_MODEL ?? '').trim() ||
    ''
  return {
    route: { name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: key, model },
  }
}

/** System prompt: Wednesday persona + confidentiality, then chat mode. */
export function buildChatSystemPrompt(): string {
  return [
    buildIdentitySection(),
    '',
    'CHAT MODE:',
    '- This is a conversation with the operator. Answer the question asked.',
    '- Be concise and plain; short paragraphs read best in a terminal.',
    '- If the operator describes a concrete engineering task, point them to',
    '  submit it as a build request so it runs under the approval gate and',
    '  gets verified — do not attempt file edits from chat.',
  ].join('\n')
}

/**
 * Conversation for one request: the fixed system prompt first, then the
 * remembered turns — oldest first, capped — then the new user turn.
 * Stored system rows are dropped so the persona stays single.
 */
export function buildChatRequest(history: ChatMessage[], userMessage: string): ChatMessage[] {
  const turns = history.filter(m => m.role !== 'system').slice(-CHAT_HISTORY_CAP)
  return [
    { role: 'system', content: buildChatSystemPrompt() },
    ...turns,
    { role: 'user', content: userMessage },
  ]
}

/**
 * Does the operator's/us crew's seat model fit this route? Hosted providers
 * need the `provider/model` shape; local ids are bare.
 */
export function seatFitsRoute(route: ChatRoute, seatModel: string): boolean {
  const seat = seatModel.trim()
  if (!seat) return false
  if (route.name === 'local') return true
  return seat.includes('/')
}

interface ChatPart {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

interface ChatPayload {
  choices?: Array<{ delta?: ChatPart; message?: ChatPart }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

interface TurnState {
  content: string
  reasoning: string
  tokensIn: number
  tokensOut: number
}

function deltaEntries(
  part: ChatPart | undefined,
  s: TurnState,
  onDelta?: (piece: string) => void,
  onReasoning?: (piece: string) => void,
): void {
  if (!part) return
  const piece = readText(part.content)
  if (piece) {
    s.content += piece
    onDelta?.(piece)
    return
  }
  // Reasoning (DeepSeek/Qwen/OpenAI-compatible `reasoning_content`) used to be
  // collected and thrown away: the operator saw a spinner for thirty seconds
  // with no sign the model was working. It now streams through its own
  // callback so the surface can show the thinking as it happens.
  const reasoning = readText(part.reasoning_content) || readText(part.reasoning)
  if (reasoning) {
    s.reasoning += reasoning
    onReasoning?.(reasoning)
  }
}

/**
 * Turn an HTTP failure into something the operator can act on.
 *
 * A dead tunnel answers with an HTML page and a 5xx, which surfaced as
 * "530 — an HTML page, not a model reply": true, and useless. The endpoint is
 * almost always a Colab/ngrok/Cloudflare URL that changed when the box
 * restarted, so the fix is `/connect`, not a bug report.
 */
export function explainChatFailure(routeName: string, status: number, raw: string): string {
  const body = describeBody(raw)
  const looksHtml = /^\s*<(?:!doctype|html|head|body)/i.test(raw.trim())
  if (status >= 500 || looksHtml) {
    return `${routeName} chat request failed: ${status} — ${body}. The model endpoint is not answering; ` +
      `a tunnel URL changes when its host restarts, so run /connect with the current one.`
  }
  if (status === 401 || status === 403) {
    return `${routeName} chat request failed: ${status} — ${body}. The API key was refused; run /connect to set a valid one.`
  }
  return `${routeName} chat request failed: ${status} — ${body}`
}

function usageFrom(data: ChatPayload, s: TurnState): void {
  if (!data.usage) return
  s.tokensIn = data.usage.prompt_tokens ?? 0
  s.tokensOut = data.usage.completion_tokens ?? 0
}

export interface ChatResult {
  text: string
  tokensIn: number
  tokensOut: number
  /** Raw thinking, when the server streamed any (already shown live). */
  reasoning?: string
  /** How many old turns were dropped so the whole conversation fit the window. */
  droppedTurns?: number
}

/**
 * One streamed chat completion. `onDelta` receives every content piece as
 * it arrives; servers that answer plain JSON deliver one turn at once (the
 * text still completes). Usage is recorded like every provider route.
 */
export async function chatComplete(
  route: ChatRoute,
  messages: ChatMessage[],
  onDelta?: (piece: string) => void,
  signal?: AbortSignal,
  onReasoning?: (piece: string) => void,
): Promise<ChatResult> {
  const model = route.model.trim().replace(/\/+$/, '')
  if (!model) {
    throw new Error(
      route.name === 'openrouter'
        ? 'no model id configured for the chat route — run /connect'
        : 'no model id configured for the chat route',
    )
  }

  // Hosted routes honour RPM caps; the local tunnel has no such cap and its
  // header/timeout posture dominates instead (mirrors LocalProvider).
  const isLocal = route.name === 'local'
  if (!isLocal) await throttleShared(resolveThrottleMs())

  // Auto-compaction (2026-11-01, operator request): a conversation that grows
  // past the model's window is fitted before it is sent, oldest turns first.
  // Sending it whole made a 13K model head-truncate its own instructions.
  const fitted = clampMessages(messages, resolvePromptBudget())
  messages = fitted.messages as ChatMessage[]
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.apiKey}`,
    ...(route.headers ?? {}),
  }
  const bodyJSON = JSON.stringify({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  })
  const init: Parameters<typeof undiciFetch>[1] = {
    method: 'POST',
    headers: baseHeaders,
    body: bodyJSON,
    ...(signal ? { signal } : {}),
    ...(isLocal ? { dispatcher: NO_TIMEOUT_CHAT } : {}),
  }

  const response = route.name === 'openrouter'
    ? await fetchWithRetry(undiciFetch, `${route.baseURL}/chat/completions`, init, resolveRetryConfig())
    : await undiciFetch(`${route.baseURL}/chat/completions`, init)

  if (!response.ok) {
    const raw = await response.text()
    throw new Error(explainChatFailure(route.name, response.status, raw))
  }
  if (!response.body) throw new Error(`${route.name} chat response had no body`)

  const decoder = new TextDecoder()
  const s: TurnState = { content: '', reasoning: '', tokensIn: 0, tokensOut: 0 }

  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return
    let data: ChatPayload
    try {
      data = JSON.parse(payload) as ChatPayload
    } catch {
      return
    }
    deltaEntries(data.choices?.[0]?.delta ?? data.choices?.[0]?.message, s, onDelta, onReasoning)
    usageFrom(data, s)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    // Some OpenAI-compatible servers wrap everything despite `stream: true`.
    const raw = (await response.text()).trim()
    if (!raw.includes('data:')) {
      let data: ChatPayload
      try {
        data = JSON.parse(raw) as ChatPayload
      } catch {
        throw new Error(`${route.name} returned invalid JSON: ${describeBody(raw)}`)
      }
      deltaEntries(data.choices?.[0]?.delta ?? data.choices?.[0]?.message, s, onDelta, onReasoning)
      usageFrom(data, s)
    } else {
      for (const line of raw.split('\n')) consumeLine(line)
    }
  } else {
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as BufferSource, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeLine(buffer)
  }

  if (s.tokensIn || s.tokensOut) {
    recordUsage(route.name, model, s.tokensIn, s.tokensOut)
  }
  const text = stripThinking((s.content || s.reasoning).trim())
  if (!text) throw new Error(`${route.name} returned no usable assistant content`)
  return {
    text,
    tokensIn: s.tokensIn || fitted.after,
    tokensOut: s.tokensOut,
    reasoning: s.reasoning,
    droppedTurns: fitted.dropped,
  }
}

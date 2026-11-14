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
import {
  userContent,
  type ChatPart as ContentPart,
} from './providers/chat'
import { wireTool as wireToolSpec } from './providers/request-body'
import type { ToolSpec } from './types'
import { Agent, fetch as undiciFetch } from 'undici'

/**
 * One tool call the model asked for.
 *
 * The arguments arrive as a JSON STRING (the wire shape), so they are parsed
 * where they are used, not here.
 */
export interface ToolCall {
  /** The wire's id, so the answer can be matched to the call. */
  id: string
  /** The tool's name. */
  name: string
  /** The arguments, as the model wrote them. */
  arguments: string
}

/** What the chat needs to offer tools and run them. */
export interface ChatToolOptions {
  /** The tools the model may call. */
  tools?: ToolSpec[]
  /**
   * Run one tool the model asked for and return its output.
   *
   * The factory does not know what a tool MEANS: the MCP client does. So
   * the caller injects the runner, and the chat only owns the LOOP: ask,
   * run, feed the result back, ask again.
   */
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Told about every call, so the operator can see the model reach out. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void
}

/** How many times the model may call tools in one turn. */
const MAX_TOOL_ROUNDS = 4

/** How much of a tool's output rides back into the conversation. */
const MAX_TOOL_OUTPUT_CHARS = 4000

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * Image attachments for this turn (2026-11-10): data URLs or https URLs.
   *
   * WHY A SEPARATE FIELD AND NOT A PARTS ARRAY: the whole prompt-budget
   * layer measures `content` as a string (`clampMessages`, `estimateTokens`)
   * and the compaction keeps head and tail of a turn's TEXT. An image has
   * no text to trim, so it rides beside the text and is converted to the
   * OpenAI content-parts shape only on the wire -- exactly where the
   * provider layer already does it for the role providers
   * (`providers/chat.ts` -> `userContent`).
   *
   * A turn with images costs tokens on the provider's side, not in the
   * text budget, so the budget stays a budget of WORDS.
   */
  images?: string[]
  /**
   * The tool calls this assistant turn made (2026-11-11).
   *
   * Only on an assistant turn; the answers ride in the `tool` turns that
   * follow, each carrying its `toolCallId`.
   */
  toolCalls?: ToolCall[]
  /** The call this `tool` turn answers. */
  toolCallId?: string
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
  // HONOUR OPENROUTER_BASE_URL (2026-11-13): the connection list already read
  // it (so /model listed a stub/proxy's catalogue), but the chat route
  // hardcoded the public URL — a custom base answered /models yet every chat
  // turn went to the real site and could sit unanswered indefinitely. One
  // source of truth for the base, or the plate and the wire disagree.
  const base = (env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  return {
    route: { name: 'openrouter', baseURL: base, apiKey: key, model },
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
 *
 * `images` ride the NEW turn only (2026-11-10): they are what the operator
 * attached to THIS message, and re-sending a 4MB picture on every later
 * turn of the conversation would cost more than the picture is worth.
 */
export function buildChatRequest(
  history: ChatMessage[],
  userMessage: string,
  images?: string[],
): ChatMessage[] {
  const turns = history.filter(m => m.role !== 'system').slice(-CHAT_HISTORY_CAP)
  const turn: ChatMessage = {
    role: 'user',
    content: userMessage,
  }
  const attached = (images ?? []).map(url => url.trim()).filter(Boolean)
  if (attached.length > 0) turn.images = attached
  return [
    { role: 'system', content: buildChatSystemPrompt() },
    ...turns,
    turn,
  ]
}

/**
 * The wire shape of a conversation: a turn with images becomes content
 * PARTS (text + image_url), exactly like the role providers do
 * (`providers/chat.ts`). A turn without images stays a plain string, so
 * the ordinary request body is byte-identical to what it always was.
 *
 * The tool turns (2026-11-11) have their own shapes: an assistant turn
 * that called tools carries `tool_calls`, and a `tool` turn carries the id
 * of the call it answers.
 */
export function toWireMessages(
  messages: ChatMessage[],
): Array<{ role: ChatMessage['role']; content: string | ContentPart[] }> {
  return messages.map(message => {
    if (message.role === 'tool') {
      return {
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId ?? '',
      } as { role: ChatMessage['role']; content: string | ContentPart[] }
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: message.role,
        content: message.content,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      } as { role: ChatMessage['role']; content: string | ContentPart[] }
    }
    return message.images && message.images.length > 0
      ? {
          role: message.role,
          content: userContent(message.content, message.images),
        }
      : { role: message.role, content: message.content }
  })
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
  tool_calls?: ToolCallChunk[]
}

/** One tool call as the wire sends it (a piece of a bigger call). */
interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/**
 * The tool calls of one turn, collected from the stream.
 *
 * A streamed call arrives in pieces: the name in the first chunk, the
 * arguments in several more, each keyed by its `index`. So the pieces are
 * gathered per index and stitched at the end.
 */
class ToolCallAccumulator {
  private readonly drafts = new Map<number, { id: string; name: string; args: string }>()

  /** Take one chunk's worth of calls. */
  add(chunks: ToolCallChunk[] | undefined): void {
    for (const chunk of chunks ?? []) {
      const index = typeof chunk.index === 'number' ? chunk.index : 0
      const draft = this.drafts.get(index) ?? { id: '', name: '', args: '' }
      if (chunk.id) draft.id = chunk.id
      const name = chunk.function?.name
      if (name) {
        // The name normally arrives once. A server that repeats it sends the
        // SAME name, and one that splits it sends a longer one -- both are
        // handled by taking the longer name.
        if (!draft.name || name.length > draft.name.length) draft.name = name
      }
      const args = chunk.function?.arguments
      if (args) draft.args += args
      this.drafts.set(index, draft)
    }
  }

  /** The calls, in the order the model made them. */
  list(): ToolCall[] {
    return [...this.drafts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, draft]) => ({
        id: draft.id || `call_${index}`,
        name: draft.name,
        arguments: draft.args || '{}',
      }))
      .filter(call => call.name.length > 0)
  }
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
  toolCalls?: ToolCallAccumulator,
): void {
  if (!part) return
  if (toolCalls && part.tool_calls) toolCalls.add(part.tool_calls)
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
  toolOptions?: ChatToolOptions,
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
  //
  // The fit happens ONCE, before the tool loop: the loop's exchange (the
  // assistant's call, the tool's answer) must stay together, and a second
  // fit could drop the call and keep its answer.
  const fitted = clampMessages(messages, resolvePromptBudget())
  const opening = fitted.messages as ChatMessage[]
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.apiKey}`,
    ...(route.headers ?? {}),
  }

  // The tools the model may call. A turn with no tools sends no `tools`
  // field, so an ordinary request body stays byte-identical to what it
  // always was.
  const tools = toolOptions?.tools ?? []
  const exchange: ChatMessage[] = []
  let tokensIn = 0
  let tokensOut = 0
  let reasoning = ''
  let droppedTurns = fitted.dropped
  let text = ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const bodyJSON = JSON.stringify({
      model,
      // The images ride the wire as content PARTS (2026-11-10). A turn with
      // no images is still a plain string, so an ordinary request body is
      // byte-identical to what it always was.
      messages: toWireMessages([...opening, ...exchange]),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools: tools.map(wireToolSpec), tool_choice: 'auto' } : {}),
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
    const calls = new ToolCallAccumulator()

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
      deltaEntries(data.choices?.[0]?.delta ?? data.choices?.[0]?.message, s, onDelta, onReasoning, calls)
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
        deltaEntries(data.choices?.[0]?.delta ?? data.choices?.[0]?.message, s, onDelta, onReasoning, calls)
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

    tokensIn += s.tokensIn
    tokensOut += s.tokensOut
    reasoning = s.reasoning || reasoning
    text = stripThinking((s.content || s.reasoning).trim())

    // No tools, no runner, or the round budget spent: the answer is the
    // answer.
    const requested = calls.list()
    if (!toolOptions?.executeTool || requested.length === 0) break
    if (round === MAX_TOOL_ROUNDS - 1) break

    // The exchange rides back into the conversation: what the model asked
    // for, and what each tool answered.
    exchange.push({
      role: 'assistant',
      content: text,
      toolCalls: requested,
    })
    for (const call of requested) {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(call.arguments || '{}') as unknown
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        args = {}
      }
      let output = ''
      try {
        toolOptions.onToolCall?.(call.name, args)
        output = await toolOptions.executeTool(call.name, args)
      } catch (error) {
        output = `the tool failed: ${error instanceof Error ? error.message : String(error)}`
      }
      const clipped =
        output.length > MAX_TOOL_OUTPUT_CHARS
          ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[truncated ${output.length - MAX_TOOL_OUTPUT_CHARS} characters]`
          : output
      exchange.push({
        role: 'tool',
        content: clipped,
        toolCallId: call.id,
      })
    }
  }

  if (tokensIn || tokensOut) {
    recordUsage(route.name, model, tokensIn, tokensOut)
  }
  if (!text) throw new Error(`${route.name} returned no usable assistant content`)
  return {
    text,
    tokensIn: tokensIn || fitted.after,
    tokensOut,
    reasoning: reasoning || undefined,
    droppedTurns,
  }
}

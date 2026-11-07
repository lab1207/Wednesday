/**
 * One SSE reader for every provider (2026-11-05).
 *
 * `providers/local.ts` grew a careful stream reader: it accepts both SSE and
 * a server that answers plain JSON even when `stream: true` was asked for
 * (the Colab FastAPI trio does exactly that), it collects the reasoning
 * channel, and it picks the usage chunk out of the tail. `providers/zen.ts`
 * grew a second, smaller one. The other two providers did not stream at all
 * - OpenRouter and NVIDIA read the whole body with `await response.text()`,
 * so the operator watched a silent spinner for a minute and, if the socket
 * dropped, lost every token of the answer.
 *
 * This module is the shared reader: the same body shape, the same reasoning
 * channel, the same usage capture, the same non-SSE fallback. A provider
 * that streams now gets the operator's live view for free.
 */
import type { CompletionHooks } from '../types'

export interface StreamedChat {
  content: string
  reasoning: string
  promptTokens: number
  completionTokens: number
  /** True when the server answered with a plain JSON body, not SSE. */
  buffered: boolean
  /** The parsed JSON body, when the server answered with one. */
  raw?: unknown
}

interface DeltaLike {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

interface ChoiceLike {
  delta?: DeltaLike
  message?: DeltaLike
}

interface ChunkLike {
  choices?: ChoiceLike[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The text of a content field, whatever shape it came in.
 *
 * OpenAI-compatible servers answer with a STRING for most models and with an
 * ARRAY of parts for the ones that support multi-part content. Reading only
 * the string case is how a perfectly good answer came back empty.
 */
function readContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const part of value) {
    if (typeof part === 'string') {
      out += part
      continue
    }
    if (typeof part === 'object' && part !== null) {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') out += text
    }
  }
  return out
}

/**
 * Read a chat completion from a response that may be SSE or plain JSON.
 *
 * Never throws on a malformed chunk: a single bad line is skipped, because
 * one broken delta must not destroy an answer that is otherwise complete.
 */
export async function consumeChatStream(
  response: Response,
  hooks?: CompletionHooks,
): Promise<StreamedChat> {
  const contentType = response.headers.get('content-type') ?? ''
  const body = response.body

  if (!body) {
    throw new Error('Model response had no body')
  }

  let content = ''
  let reasoning = ''
  let promptTokens = 0
  let completionTokens = 0
  let sawUsage = false

  const consumeData = (data: ChunkLike): void => {
    const choice = data.choices?.[0]
    const part = choice?.delta ?? choice?.message
    if (part) {
      const piece = readContent(part.content)
      if (piece) {
        content += piece
      } else {
        const thought =
          readText(part.reasoning_content) || readText(part.reasoning)
        if (thought) {
          reasoning += thought
          hooks?.onReasoning?.(thought)
        }
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
    let data: ChunkLike
    try {
      data = JSON.parse(payload) as ChunkLike
    } catch {
      return
    }
    consumeData(data)
  }

  // A server that answers plain JSON despite `stream: true`.
  if (!contentType.includes('text/event-stream')) {
    const raw = (await response.text()).trim()
    if (!raw.includes('data:')) {
      let data: ChunkLike
      try {
        data = JSON.parse(raw) as ChunkLike
      } catch {
        throw new Error('Model returned no usable assistant content')
      }
      consumeData(data)
      return {
        content,
        reasoning,
        promptTokens: sawUsage ? promptTokens : 0,
        completionTokens: sawUsage ? completionTokens : 0,
        buffered: true,
        raw: data,
      }
    }
    // SSE bytes under a non-SSE content-type: feed the buffered text through
    // the line parser as the first chunk.
    for (const line of raw.split('\n')) consumeLine(line)
    return {
      content,
      reasoning,
      promptTokens,
      completionTokens,
      buffered: false,
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''
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
  if (buffer.trim()) consumeLine(buffer)

  return {
    content,
    reasoning,
    promptTokens: sawUsage ? promptTokens : 0,
    completionTokens: sawUsage ? completionTokens : 0,
    buffered: false,
  }
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import {
  CHAT_LOCAL_DEFAULT_MODEL,
  type ChatMessage,
  type ChatRoute,
  buildChatRequest,
  chatComplete,
  resolveChatRoute,
  seatFitsRoute,
} from './chat-stream'

/**
 * Offline proof of the real chat loop (2026-10-30): one streamed,
 * OpenAI-compatible conversation path for every route. The fake server
 * captures the wire shape (messages carry the system persona + remembered
 * turns), streams content deltas `onDelta` sees live, and the plain-JSON
 * server shape (Colab trio-style) still completes.
 */

interface CapturedRequest {
  url: string
  authorization: string | undefined
  body: {
    model?: string
    messages?: Array<{ role?: string; content?: string }>
    stream?: boolean
  }
}

function sseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function clearChatEnv(): void {
  delete process.env.FACTORY_LLM_PROVIDER
  delete process.env.LOCAL_LLM_BASE_URL
  delete process.env.LOCAL_LLM_MODEL
  delete process.env.LOCAL_LLM_API_KEY
  delete process.env.OPENROUTER_API_KEY
  delete process.env.DSH_LLM_MODEL
  delete process.env.NVIDIA_API_KEY
  delete process.env.NVIDIA_LLM_MODEL
  delete process.env.FACTORY_CREW_PLANNER_MODEL
  delete process.env.FACTORY_CREW_CODER_MODEL
  delete process.env.FACTORY_CREW_VISION_MODEL
}

interface CapturingServer {
  server: Server
  requests: CapturedRequest[]
}

function noise(): void { /* placeholder replaced below */ }

async function main(): Promise<void> {
  void noise
  clearChatEnv()

  // ── 1. buildChatRequest: persona first, memory capped, system deduped ── */
  {
    const first = buildChatRequest([], 'hello')
    assert.equal(first[0]?.role, 'system')
    assert.ok(first[0]?.content.includes('You are Wednesday'), 'persona rides the chat system prompt')

    const history: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` })
    }
    // A stray system row in the history is dropped (persona stays single).
    history.push({ role: 'system', content: 'injected' })
    const messages = buildChatRequest(history, 'and now?')
    assert.equal(messages.length, 14) // system + last 12 remembered + new user
    assert.ok(!messages.some(m => m.role === 'system' && m.content === 'injected'))
    assert.equal(messages[1]?.content, 'q4', 'the cap keeps the most recent turns')

    // Cap: with more than 12 remembered turns, only the last 12 ride along.
    const long: ChatMessage[] = [{ role: 'user', content: 'too old' }]
    for (let i = 0; i < 10; i++) {
      long.push({ role: 'user', content: `t${i}` }, { role: 'assistant', content: `r${i}` })
    }
    const capped = buildChatRequest(long, 'next question')
    assert.equal(capped.length, 14)
    assert.ok(!capped.some(m => m.content === 'too old'), 'oldest turns fall off first')
  }

  // ── 2. route resolution: named blockers, no request attempted ── */
  {
    clearChatEnv()
    const openrouterBlocked = resolveChatRoute(null)
    assert.ok('blocker' in openrouterBlocked)

    process.env.FACTORY_LLM_PROVIDER = 'local'
    const localBlocked = resolveChatRoute(null)
    assert.ok('blocker' in localBlocked)

    process.env.FACTORY_LLM_PROVIDER = 'zen'
    const zenBlocked = resolveChatRoute(null)
    assert.ok('blocker' in zenBlocked && zenBlocked.blocker.includes('retired'))

    delete process.env.FACTORY_LLM_PROVIDER
    process.env.OPENROUTER_API_KEY = 'test-or-key'
    assert.ok(!('blocker' in resolveChatRoute(null)))
  }

  // ── 3. local route, live: streamed deltas + captured memory ── */
  {
    const { server, requests } = await new Promise<CapturingServer>(resolve => {
      const captured: CapturedRequest[] = []
      const s = createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += String(chunk) })
        req.on('end', () => {
          captured.push({
            url: req.url ?? '',
            authorization: req.headers.authorization,
            body: JSON.parse(raw || '{}') as CapturedRequest['body'],
          })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(sseLine({ choices: [{ index: 0, delta: { content: 'CHAT_' } }] }))
          res.write(sseLine({ choices: [{ index: 0, delta: { content: 'OK' } }] }))
          res.write(sseLine({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
          res.end('data: [DONE]\n\n')
        })
      })
      s.listen(0, '127.0.0.1', () => resolve({ server: s, requests: captured }))
    })
    const port = (server.address() as AddressInfo).port
    process.env.FACTORY_LLM_PROVIDER = 'local'
    process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
    process.env.LOCAL_LLM_MODEL = 'test-chat-model'
    process.env.LOCAL_LLM_API_KEY = 'test-chat-key'

    const resolved = resolveChatRoute(null)
    assert.ok(!('blocker' in resolved))
    const route = (resolved as { route: ChatRoute }).route
    assert.equal(route.name, 'local')
    assert.equal(route.model, 'test-chat-model')

    const live: string[] = []
    const turn1 = await chatComplete(
      route,
      buildChatRequest([], 'what is a ferrite bead?'),
      piece => { live.push(piece) },
    )
    assert.equal(turn1.text, 'CHAT_OK')
    assert.deepEqual(live, ['CHAT_', 'OK'], 'deltas stream live, not one buffered blob')
    assert.equal(turn1.tokensIn, 5)
    assert.equal(turn1.tokensOut, 2)

    assert.equal(requests[0]?.url, '/v1/chat/completions')
    assert.equal(requests[0]?.authorization, 'Bearer test-chat-key')
    assert.equal(requests[0]?.body.stream, true)
    assert.equal(requests[0]?.body.model, 'test-chat-model')
    assert.equal(requests[0]?.body.messages?.[0]?.role, 'system')
    assert.equal(requests[0]?.body.messages?.[1]?.role, 'user')
    assert.equal(requests[0]?.body.messages?.[1]?.content, 'what is a ferrite bead?')

    // Turn 2: memory travels — prior turns precede the new question.
    const history: ChatMessage[] = [
      { role: 'user', content: 'what is a ferrite bead?' },
      { role: 'assistant', content: turn1.text },
    ]
    await chatComplete(route, buildChatRequest(history, 'give me one example'))
    const second = requests[1]?.body.messages ?? []
    assert.equal(second.length, 4) // system + user + assistant + new user
    assert.equal(second[2]?.content, 'CHAT_OK', 'the remembered assistant answer rides along')
    assert.equal(second[3]?.content, 'give me one example')

    // Crew-seat override: a bare seat id fits the local route and wins.
    const seatResolved = resolveChatRoute('qwen3-8-27b')
    assert.ok(!('blocker' in seatResolved))
    assert.equal((seatResolved as { route: ChatRoute }).route.model, 'qwen3-8-27b')

    server.close()
  }

  // ── 4. plain-JSON server (Colab trio shape) completes without SSE ── */
  {
    const { server, requests } = await new Promise<CapturingServer>(resolve => {
      const captured: CapturedRequest[] = []
      const s = createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += String(chunk) })
        req.on('end', () => {
          captured.push({
            url: req.url ?? '',
            authorization: undefined,
            body: JSON.parse(raw || '{}') as CapturedRequest['body'],
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'cmpl-chat-json',
            object: 'chat.completion',
            created: 1,
            model: 'test-chat-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'PLAIN_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }))
        })
      })
      s.listen(0, '127.0.0.1', () => resolve({ server: s, requests: captured }))
    })
    const port = (server.address() as AddressInfo).port
    process.env.FACTORY_LLM_PROVIDER = 'local'
    process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
    process.env.LOCAL_LLM_MODEL = 'test-chat-model'

    const resolved = resolveChatRoute(null)
    const route = (resolved as { route: ChatRoute }).route
    const seen: string[] = []
    const answer = await chatComplete(
      route,
      buildChatRequest([], 'json server please'),
      piece => { seen.push(piece) },
    )
    assert.equal(answer.text, 'PLAIN_OK')
    assert.ok(seen.length >= 1, 'single-shape servers deliver one turn of text')
    assert.equal(answer.tokensIn, 3)
    assert.equal(answer.tokensOut, 1)
    assert.equal(requests[0]?.body.stream, true)
    server.close()
  }

  // ── 5. seat/route fit guards ── */
  {
    const localRoute: ChatRoute = { name: 'local', baseURL: 'http://x/v1', apiKey: 'k', model: 'm' }
    const hostedRoute: ChatRoute = { name: 'openrouter', baseURL: 'http://x/v1', apiKey: 'k', model: 'a/b' }
    assert.equal(seatFitsRoute(localRoute, 'qwen3-8-27b'), true)
    assert.equal(seatFitsRoute(hostedRoute, 'qwen3-8-27b'), false, 'bare local id must not reach a hosted route')
    assert.equal(seatFitsRoute(hostedRoute, 'acme/hosted'), true)
  }

  // ── 6. hosted fallback: a foreign seat yields the route's own model ── */
  {
    clearChatEnv()
    process.env.FACTORY_LLM_PROVIDER = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'test-or-key'
    process.env.DSH_LLM_MODEL = 'acme/hosted-default'
    const resolved = resolveChatRoute('qwen3-8-27b')
    assert.ok(!('blocker' in resolved))
    assert.equal(
      (resolved as { route: ChatRoute }).route.model,
      'acme/hosted-default',
      'a foreign seat id falls back to the route model',
    )
  }

  // ── 7. reasoning streams live, and a dead endpoint explains itself ── */
  {
    const server = createServer((req, res) => {
      req.on('data', () => { /* drain */ })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sseLine({ choices: [{ index: 0, delta: { reasoning_content: 'checking the repo' } }] }))
        res.write(sseLine({ choices: [{ index: 0, delta: { reasoning_content: ' … done' } }] }))
        res.write(sseLine({ choices: [{ index: 0, delta: { content: 'ANSWER' } }] }))
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    process.env.FACTORY_LLM_PROVIDER = 'local'
    process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
    process.env.LOCAL_LLM_MODEL = 'test-chat-model'
    const route = (resolveChatRoute(null) as { route: ChatRoute }).route
    const thinking: string[] = []
    const answer = await chatComplete(
      route,
      buildChatRequest([], 'why is the build red?'),
      undefined,
      undefined,
      piece => { thinking.push(piece) },
    )
    assert.deepEqual(thinking, ['checking the repo', ' … done'], 'reasoning streams before the answer')
    assert.equal(answer.text, 'ANSWER')
    assert.equal(answer.reasoning, 'checking the repo … done')
    server.close()

    // A dead tunnel: 530 + an HTML page must point the operator at /connect
    // instead of reporting "an HTML page, not a model reply" with no next step.
    const dead = createServer((req, res) => {
      req.on('data', () => { /* drain */ })
      req.on('end', () => {
        res.writeHead(530, { 'content-type': 'text/html' })
        res.end('<!DOCTYPE html><html><body>Cloudflare Tunnel error</body></html>')
      })
    })
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as AddressInfo).port
    process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${deadPort}/v1`
    const deadRoute = (resolveChatRoute(null) as { route: ChatRoute }).route
    await assert.rejects(
      () => chatComplete(deadRoute, buildChatRequest([], 'hi')),
      (err: Error) => err.message.includes('530') && err.message.includes('/connect'),
      'a dead endpoint names the remedy',
    )
    dead.close()
  }

  // The local default never splits from LocalProvider without a reason.
  assert.equal(CHAT_LOCAL_DEFAULT_MODEL, 'qwen2.5-coder-3b-instruct')

  clearChatEnv()
  console.log('CHAT STREAM TEST: PASS')
}

main().catch(err => {
  console.error('CHAT STREAM TEST: FAIL')
  console.error(err)
  process.exit(1)
})

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE TEST'S OWN STATE HOME (must be first: it sets the env var before
// `factory/paths.ts` is evaluated, so the MCP registry is the test's own).
import '../harness/test-state-home.js'

import { addMcpServer, recordMcpServerState } from './config.js'
import { mcpChatToolOptions } from './tools.js'
import { chatComplete, type ChatRoute } from '../model-router/chat-stream.js'

/**
 * THE MODEL CALLS AN MCP TOOL (2026-11-11).
 *
 * The whole chain, end to end: the model asks for a tool, the tool runs on
 * the MCP server that owns it, the answer rides back into the conversation,
 * and the model finishes its sentence.
 *
 * The chat server is a real OpenAI-compatible one: it answers the FIRST
 * request with a tool call and the SECOND with the final text, and the test
 * reads both request bodies. So what is proved is the WIRE, not a mock of
 * the factory's own code.
 */

const work = mkdtempSync(join(tmpdir(), 'wednesday-chat-mcp-'))

/** The MCP server the tool lives on. */
const serverScript = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf('\\n')
  }
})
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n') }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture-server', version: '1' } } })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'echo the text back',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(message.params.arguments.text) }] } })
  }
}
`
const serverPath = join(work, 'fixture-server.mjs')
writeFileSync(serverPath, serverScript)

// ---------------------------------------------------------------------------
// THE CHAT SERVER: a tool call, then the answer.
// ---------------------------------------------------------------------------

const requests: any[] = []
const chatServer: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => { raw += String(chunk) })
  request.on('end', () => {
    const body = JSON.parse(raw)
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = {
      id: 'chat-mcp',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'qwen3-5-4b',
    }
    const chunk = (delta: unknown, finish: unknown = null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const hasToolAnswer = body.messages.some(
      (message: any) => message.role === 'tool',
    )
    if (hasTools && !hasToolAnswer) {
      // The model asks for the tool.
      response.write(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'mcp__fixture__echo', arguments: '{"text":"hi"}' },
            },
          ],
        }),
      )
      response.write(chunk({}, 'tool_calls'))
    } else {
      // The model has the answer and finishes.
      const text = hasToolAnswer
        ? 'the tool said: echo:hi'
        : 'plain answer'
      for (const piece of text.split(' ')) {
        response.write(chunk({ content: `${piece} ` }))
      }
      response.write(chunk({}, 'stop'))
    }
    response.end('data: [DONE]\n\n')
  })
})
chatServer.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { chatServer.once('listening', resolve) })
const port = (chatServer.address() as AddressInfo).port

const route: ChatRoute = {
  name: 'local',
  baseURL: `http://127.0.0.1:${port}/v1`,
  apiKey: 'local',
  model: 'qwen3-5-4b',
}

// ---------------------------------------------------------------------------
// 1. WITH NO MCP SERVER ATTACHED, THE REQUEST CARRIES NO TOOLS.
// ---------------------------------------------------------------------------

{
  const options = await mcpChatToolOptions(route.model, route.name)
  assert.equal(options, undefined, 'no server, no tools')
  await chatComplete(route, [{ role: 'user', content: 'hello' }])
  assert.equal(requests[0]!.tools, undefined, 'the body carries no tools field')
  assert.equal(
    requests[0]!.messages.length,
    1,
    'the body is the ordinary one (the user turn, unchanged)',
  )
  assert.equal(requests[0]!.messages[0].role, 'user')
  assert.equal(requests[0]!.messages[0].content, 'hello')
}

// ---------------------------------------------------------------------------
// 2. WITH A SERVER ATTACHED, THE MODEL CALLS THE TOOL AND GETS THE ANSWER.
// ---------------------------------------------------------------------------

{
  await addMcpServer({
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    enabled: true,
  })
  // The connection state the factory records after `/mcp connect`.
  await recordMcpServerState('fixture', {
    status: 'connected',
    serverInfo: 'fixture-server',
    protocolVersion: '2024-11-05',
    tools: 1,
    toolDefinitions: [
      {
        name: 'echo',
        description: 'echo the text back',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
    checkedAt: Date.now(),
  })

  const calls: string[] = []
  const options = await mcpChatToolOptions(route.model, route.name, name => calls.push(name))
  assert.ok(options, 'the tools are offered')
  assert.equal(options!.tools!.length, 1)
  assert.equal(options!.tools![0]!.name, 'mcp__fixture__echo')

  const answer = await chatComplete(
    route,
    [{ role: 'user', content: 'what does the echo tool say?' }],
    undefined,
    undefined,
    undefined,
    options,
  )

  assert.equal(answer.text, 'the tool said: echo:hi', 'the model finished the sentence')
  assert.deepEqual(calls, ['mcp__fixture__echo'], 'the operator saw the call')

  // The first request carried the tools.
  assert.ok(Array.isArray(requests[1]!.tools), 'the body carries the tools')
  assert.equal(requests[1]!.tools[0].function.name, 'mcp__fixture__echo')

  // The second request carried the call AND its answer.
  const second = requests[2]!
  const assistant = second.messages.find(
    (message: any) => message.role === 'assistant' && message.tool_calls,
  )
  assert.ok(assistant, 'the assistant turn carries the tool call')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.tool_calls[0].function.name, 'mcp__fixture__echo')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"text":"hi"}')

  const toolTurn = second.messages.find((message: any) => message.role === 'tool')
  assert.ok(toolTurn, 'the tool turn rides back into the conversation')
  assert.equal(toolTurn.tool_call_id, 'call_1')
  assert.equal(toolTurn.content, 'echo:hi', 'the tool really ran on the server')
}

chatServer.close()

console.log(
  'CHAT MCP TEST: PASS (no server means no tools on the wire, and with one attached the model calls the tool, the tool runs on the real MCP server, and the answer rides back into the conversation)',
)

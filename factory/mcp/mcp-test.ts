import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

// THE TEST'S OWN STATE HOME (must be first: it sets the env var before
// `factory/paths.ts` is evaluated).
import '../test-state-home.js'

import {
  addMcpServer,
  loadMcpRegistry,
  removeMcpServer,
  setMcpServerEnabled,
  type McpServer,
} from './config.js'
import { connectMcpServer, callMcpTool } from './client.js'
import { mcpToolBindings, mcpToolSpecs, mcpWireName, runMcpTool } from './tools.js'

/**
 * THE OPERATOR'S MCP SERVERS (2026-11-11).
 *
 * The ask: "an MCP server the operator can attach, listed and connected from
 * the terminal".
 *
 * The proof is a REAL server: a child process that speaks MCP over stdio,
 * and an HTTP endpoint that speaks it over the wire. A mock of the factory's
 * own client would prove nothing about the protocol.
 */

// ---------------------------------------------------------------------------
// A REAL MCP SERVER, OVER STDIO.
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'wednesday-mcp-'))

/**
 * The server script.
 *
 * It speaks the protocol the factory speaks: `initialize` -> the
 * `notifications/initialized` notification -> `tools/list` -> `tools/call`.
 * The answer of `tools/call` echoes the arguments, so the test can prove the
 * arguments arrived intact.
 */
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
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-server', version: '1.2.3' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
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
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: 'echo:' + String(message.params.arguments.text) }],
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
}
`

const serverPath = join(work, 'fixture-server.mjs')
writeFileSync(serverPath, serverScript)

const stdioServer: McpServer = {
  name: 'fixture',
  transport: 'stdio',
  command: process.execPath,
  args: [serverPath],
  enabled: true,
}

// ---------------------------------------------------------------------------
// 1. THE STDIO SERVER CONNECTS, AND ITS TOOLS ARE FOUND.
// ---------------------------------------------------------------------------

{
  const connection = await connectMcpServer(stdioServer)
  assert.equal(connection.serverInfo?.name, 'fixture-server')
  assert.equal(connection.serverInfo?.version, '1.2.3')
  assert.equal(connection.protocolVersion, '2024-11-05')
  assert.equal(connection.tools.length, 1)
  assert.equal(connection.tools[0]!.name, 'echo')
  assert.equal(connection.tools[0]!.description, 'echo the text back')
  assert.ok(connection.tools[0]!.inputSchema, 'the tool carries its schema')
}

// A TOOL CALL RUNS, AND THE ARGUMENTS ARRIVE.
{
  const result = await callMcpTool(stdioServer, 'echo', { text: 'hello' })
  assert.equal(result.text, 'echo:hello')
  assert.equal(result.isError, false)
}

// A SERVER THAT IS NOT THERE SAYS SO, BY NAME.
{
  const missing: McpServer = {
    name: 'missing',
    transport: 'stdio',
    command: join(work, 'not-a-program.exe'),
    enabled: true,
  }
  await assert.rejects(
    connectMcpServer(missing),
    /exited|could not be started|ENOENT|not recognized/,
  )
}

// ---------------------------------------------------------------------------
// 2. THE HTTP SERVER.
// ---------------------------------------------------------------------------

let httpCalls = 0
const httpServer = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += String(chunk) })
  request.on('end', () => {
    httpCalls += 1
    let message: any = {}
    try { message = JSON.parse(body) } catch { /* answered below anyway */ }
    const answer = (result: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    if (message.method === 'initialize') {
      answer({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '2' },
      })
      return
    }
    if (message.method === 'tools/list') {
      answer({
        tools: [
          {
            name: 'ping',
            description: 'answer with pong',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })
      return
    }
    if (message.method === 'tools/call') {
      answer({ content: [{ type: 'text', text: 'pong' }] })
      return
    }
    response.writeHead(202).end()
  })
})
httpServer.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { httpServer.once('listening', resolve) })
const httpPort = (httpServer.address() as AddressInfo).port

{
  const httpMcp: McpServer = {
    name: 'http-fixture',
    transport: 'http',
    url: `http://127.0.0.1:${httpPort}/mcp`,
    enabled: true,
  }
  const connection = await connectMcpServer(httpMcp)
  assert.equal(connection.serverInfo?.name, 'http-fixture')
  assert.equal(connection.tools[0]!.name, 'ping')
  const result = await callMcpTool(httpMcp, 'ping', {})
  assert.equal(result.text, 'pong')
  assert.ok(httpCalls >= 3, 'the HTTP transport really talked to the server')
}
httpServer.close()

// ---------------------------------------------------------------------------
// 3. THE REGISTRY.
// ---------------------------------------------------------------------------

{
  const path = join(work, 'mcp.json')
  const added = await addMcpServer(stdioServer, path)
  assert.ok(added.ok, added.error)
  const again = await addMcpServer(stdioServer, path)
  assert.equal(again.ok, false, 'a name may only be used once')
  assert.match(again.error ?? '', /already attached/)

  const bad = await addMcpServer({ ...stdioServer, name: 'bad name' }, path)
  assert.equal(bad.ok, false, 'a name with a space is refused')

  const { registry } = await loadMcpRegistry(path)
  assert.equal(registry.servers.length, 1)

  const off = await setMcpServerEnabled('fixture', false, path)
  assert.ok(off.ok)
  const disabled = await loadMcpRegistry(path)
  assert.equal(disabled.registry.servers[0]!.enabled, false)

  const removed = await removeMcpServer('fixture', path)
  assert.ok(removed.ok)
  const empty = await loadMcpRegistry(path)
  assert.equal(empty.registry.servers.length, 0)

  const missing = await removeMcpServer('fixture', path)
  assert.equal(missing.ok, false)
}

// A BROKEN REGISTRY IS REPORTED, NOT SILENTLY EMPTYED.
{
  const path = join(work, 'broken.json')
  writeFileSync(path, '{ this is not json')
  const { registry, error } = await loadMcpRegistry(path)
  assert.equal(registry.servers.length, 0)
  assert.ok(error, 'the broken registry is reported')
  assert.match(error!, /could not be read/)
}

// ---------------------------------------------------------------------------
// 4. THE TOOLS THE MODEL IS OFFERED.
// ---------------------------------------------------------------------------

{
  const registry = {
    servers: [
      {
        ...stdioServer,
        state: {
          status: 'connected' as const,
          tools: 1,
          toolDefinitions: [
            {
              name: 'echo',
              description: 'echo the text back',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
      },
      {
        name: 'off',
        transport: 'stdio' as const,
        command: 'node',
        enabled: false,
        state: {
          status: 'connected' as const,
          tools: 1,
          toolDefinitions: [{ name: 'hidden' }],
        },
      },
    ],
  }
  const bindings = mcpToolBindings(registry)
  assert.equal(bindings.length, 1, 'a disabled server offers nothing')
  assert.equal(bindings[0]!.wireName, 'mcp__fixture__echo')

  const specs = mcpToolSpecs(bindings)
  assert.equal(specs[0]!.name, 'mcp__fixture__echo')
  assert.equal(specs[0]!.description, 'echo the text back')
  assert.ok(specs[0]!.parameters, 'the schema rides along')

  assert.equal(mcpWireName('fixture', 'echo'), 'mcp__fixture__echo')

  // The call RUNS on the server that owns the tool.
  const output = await runMcpTool(bindings, 'mcp__fixture__echo', { text: 'round trip' })
  assert.equal(output, 'echo:round trip')

  // A tool the model invented is refused.
  await assert.rejects(
    runMcpTool(bindings, 'mcp__fixture__made_up', {}),
    /no attached server offers/,
  )
}

// ---------------------------------------------------------------------------
// 5. THE COMMAND — removed 2026-11-14 with the terminal harness.
//
// The registry, the transports and the wire names are asserted above. The
// slash-command renderer that used to be checked here is gone with the TUI.
// ---------------------------------------------------------------------------

console.log(
  'MCP TEST: PASS (a real stdio server connects and its tool runs, a real HTTP server answers, the registry refuses a duplicate and a broken file, and only enabled servers are offered to the model)',
)

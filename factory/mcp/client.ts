/**
 * A MINIMAL MCP CLIENT (2026-11-11).
 *
 * THE ASK: "an MCP server the operator can attach, listed and connected from
 * the terminal".
 *
 * WHY THE FACTORY IS THE CLIENT AND NOT THE ACP WORKER:
 *
 * The obvious route was the ACP `session/new` call, whose parameters already
 * carry an `mcpServers` array -- and the dsh ACP bridge REFUSES a non-empty
 * one (`dsh/packages/acp/acp/src/index.ts`: "mcpServers is not supported").
 * The provisioned runtime carries no `dsh-mcp-client` either. So the ACP
 * worker cannot take an MCP server, and pretending otherwise would make
 * `/mcp` a command that lists things nothing can use.
 *
 * So Wednesday speaks MCP itself. The protocol is small:
 *
 *   - `initialize` -> the server answers with its name and protocol version.
 *   - `notifications/initialized` -> the client says "ready".
 *   - `tools/list` -> the server answers with its tools and their schemas.
 *   - `tools/call` -> the client asks for one tool to run.
 *
 * The stdio transport is newline-delimited JSON-RPC on the child's stdin and
 * stdout. The HTTP transport POSTs the same JSON-RPC message and reads back
 * either a JSON body or an SSE stream.
 *
 * NO NEW DEPENDENCY: the factory ships one installable application with a
 * small dependency list, and MCP over these two transports is JSON-RPC over
 * a pipe or a POST. `undici` (already a dependency) is the HTTP client.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { McpServer, McpTool } from './config'

/** The protocol version Wednesday speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** How long a handshake or a tool call may take. */
const DEFAULT_TIMEOUT_MS = 20_000

/** What a successful handshake found. */
export interface McpConnection {
  /** The server's own name. */
  serverInfo?: { name: string; version?: string }
  /** The protocol version the server speaks. */
  protocolVersion?: string
  /** The tools it exposes. */
  tools: McpTool[]
}

/** The result of one tool call. */
export interface McpToolResult {
  /** The tool's output, flattened to text. */
  text: string
  /** Did the tool itself report a failure? */
  isError: boolean
}

/** A JSON-RPC message. */
interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Quote an argument for the Windows shell fallback.
 *
 * The fallback runs the command through `cmd.exe`, which splits on spaces.
 * An argument with a space has to arrive as one argument.
 */
function quoteForShell(argument: string): string {
  if (!/[\s"^&|<>()%!]/.test(argument)) return argument
  return `"${argument.replace(/"/g, '""')}"`
}

/**
 * Start the server process.
 *
 * WINDOWS: an MCP server is usually launched through a shim (`npx`, `uvx`),
 * and on Windows those are `.cmd` files, which `spawn` cannot execute
 * directly -- the same lesson as `npm-command.ts`. So the spawn is tried
 * WITHOUT a shell first (safe, no quoting rules), and only if the OS says
 * "no such file" is it retried through the shell, with every argument
 * quoted by hand.
 */
async function startServerProcess(
  server: McpServer,
): Promise<ChildProcessWithoutNullStreams> {
  const args = server.args ?? []
  const options = {
    cwd: server.cwd || undefined,
    env: { ...process.env, ...(server.env ?? {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] as const,
  }
  const child = spawn(server.command!, args, options) as ChildProcessWithoutNullStreams
  const failure = await spawnFailure(child)
  if (!failure) return child
  child.kill()

  const code = (failure as NodeJS.ErrnoException).code
  if (process.platform !== 'win32' || code !== 'ENOENT') throw failure

  // Windows: the command is a `.cmd` shim. The shell runs it; every
  // argument is quoted here because Node's shell mode does not quote.
  const commandLine = [server.command!, ...args].map(quoteForShell).join(' ')
  const shellChild = spawn(commandLine, { ...options, shell: true }) as ChildProcessWithoutNullStreams
  const secondFailure = await spawnFailure(shellChild)
  if (secondFailure) throw secondFailure
  return shellChild
}

/** The error the spawn produced, if it failed straight away. */
function spawnFailure(
  child: ChildProcessWithoutNullStreams,
): Promise<Error | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), 200)
    child.once('error', error => {
      clearTimeout(timer)
      resolve(error)
    })
    child.once('spawn', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** The lines a server process wrote, and the ones waiting for an answer. */
class JsonRpcLines {
  private buffer = ''
  private readonly waiting = new Map<
    number,
    { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }
  >()

  constructor(private readonly onLine?: (line: string) => void) {}

  /** Feed a chunk of the child's stdout. */
  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.handle(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /** One decoded message. */
  private handle(line: string): void {
    this.onLine?.(line)
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      // A server that prints something that is not JSON (a banner, a warning)
      // must not break the conversation.
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = this.waiting.get(message.id)
    if (!waiter) return
    this.waiting.delete(message.id)
    waiter.resolve(message)
  }

  /** Wait for the answer to a request. */
  await_(id: number, timeoutMs: number): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  /**
   * Fail every waiting request.
   *
   * A server that dies mid-handshake must not leave the factory waiting for
   * the full timeout: the process is gone, and "the server exited" is a
   * better answer than "no answer for twenty seconds".
   */
  failAll(error: Error): void {
    for (const [id, waiter] of [...this.waiting]) {
      this.waiting.delete(id)
      waiter.reject(error)
    }
  }
}

/** Send a request and wait for its answer. */
async function request(
  child: ChildProcessWithoutNullStreams,
  lines: JsonRpcLines,
  id: number,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const answer = lines.await_(id, timeoutMs)
  const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
  child.stdin.write(message)
  const response = await answer
  if (response.error) {
    throw new Error(response.error.message ?? `${method} failed`)
  }
  return response.result
}

/** Connect to a stdio server and list its tools. */
async function connectStdio(
  server: McpServer,
  timeoutMs: number,
): Promise<McpConnection> {
  let started: ChildProcessWithoutNullStreams
  try {
    started = await startServerProcess(server)
  } catch (error) {
    throw new Error(
      `the server could not be started: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const child = started

  let spawnError: Error | undefined
  child.on('error', error => {
    spawnError = error
  })

  const lines = new JsonRpcLines()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => lines.push(String(chunk)))
  // The server's own diagnostics are not the conversation: they are kept out
  // of the way, but they are not lost either (the first line of a failure
  // usually says what went wrong).
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
    if (stderr.length > 4000) stderr = stderr.slice(-4000)
  })
  // A server that dies must not make the factory wait for the timeout.
  child.on('exit', code => {
    lines.failAll(new Error(`the server exited (code ${code ?? 'null'})`))
  })

  try {
    // Give the process a moment to fail loudly (a missing executable is
    // reported as an 'error' event, not as an exit).
    await new Promise(resolve => setTimeout(resolve, 60))
    if (spawnError) throw spawnError

    const initialize = (await request(
      child,
      lines,
      1,
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wednesday', version: '1' },
      },
      timeoutMs,
    )) as {
      protocolVersion?: string
      serverInfo?: { name?: string; version?: string }
    } | undefined

    // "I am ready" -- a notification, so no answer is expected.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )

    const listed = (await request(child, lines, 2, 'tools/list', {}, timeoutMs)) as {
      tools?: McpTool[]
    } | undefined

    return {
      serverInfo: initialize?.serverInfo?.name
        ? {
            name: initialize.serverInfo.name,
            version: initialize.serverInfo.version,
          }
        : undefined,
      protocolVersion: initialize?.protocolVersion,
      tools: Array.isArray(listed?.tools) ? listed.tools : [],
    }
  } catch (error) {
    const detail = stderr.trim().split('\n').slice(-3).join(' ').trim()
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(detail ? `${reason} (${detail})` : reason)
  } finally {
    child.stdin.end()
    child.kill()
  }
}

/** One HTTP JSON-RPC exchange. */
async function httpExchange(
  server: McpServer,
  body: unknown,
  timeoutMs: number,
  sessionId?: string,
): Promise<{ status: number; text: string; sessionId?: string }> {
  const url = new URL(server.url!)
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(server.headers ?? {}),
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
      },
      response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          text += String(chunk)
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            text,
            sessionId: response.headers['mcp-session-id'] as string | undefined,
          })
        })
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`))
    })
    request.on('error', error => reject(error))
    request.write(payload)
    request.end()
  })
}

/** Pull the JSON-RPC answer out of an HTTP response (JSON or SSE). */
function parseHttpAnswer(text: string): JsonRpcMessage | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return undefined
    }
  }
  // SSE: the answer is in a `data:` line.
  for (const line of trimmed.split('\n')) {
    const payload = line.trim()
    if (!payload.startsWith('data:')) continue
    const body = payload.slice(5).trim()
    if (!body || body === '[DONE]') continue
    try {
      return JSON.parse(body) as JsonRpcMessage
    } catch {
      // Keep looking: an SSE stream can carry several events.
    }
  }
  return undefined
}

/** Connect to an HTTP server and list its tools. */
async function connectHttp(
  server: McpServer,
  timeoutMs: number,
): Promise<McpConnection> {
  const initializeResponse = await httpExchange(
    server,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wednesday', version: '1' },
      },
    },
    timeoutMs,
  )
  if (initializeResponse.status >= 400) {
    throw new Error(`the server answered ${initializeResponse.status}: ${initializeResponse.text.slice(0, 200)}`)
  }
  const initialize = parseHttpAnswer(initializeResponse.text)
  if (initialize?.error) {
    throw new Error(initialize.error.message ?? 'initialize failed')
  }

  // The "ready" notification (no answer expected).
  await httpExchange(
    server,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    timeoutMs,
    initializeResponse.sessionId,
  ).catch(() => undefined)

  const listedResponse = await httpExchange(
    server,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    timeoutMs,
    initializeResponse.sessionId,
  )
  if (listedResponse.status >= 400) {
    throw new Error(`the server answered ${listedResponse.status}: ${listedResponse.text.slice(0, 200)}`)
  }
  const listed = parseHttpAnswer(listedResponse.text)
  if (listed?.error) {
    throw new Error(listed.error.message ?? 'tools/list failed')
  }
  const result = listed?.result as { tools?: McpTool[] } | undefined

  const serverInfo = (initialize?.result as
    | { serverInfo?: { name?: string; version?: string } }
    | undefined)?.serverInfo

  return {
    serverInfo: serverInfo?.name
      ? { name: serverInfo.name, version: serverInfo.version }
      : undefined,
    protocolVersion: (initialize?.result as { protocolVersion?: string } | undefined)
      ?.protocolVersion,
    tools: Array.isArray(result?.tools) ? result.tools : [],
  }
}

/**
 * Connect to a server and list its tools.
 *
 * @param server - the server from the registry.
 * @param timeoutMs - how long the handshake may take.
 * @returns what the server said about itself and what it exposes.
 * @throws when the server cannot be reached or does not answer.
 */
export async function connectMcpServer(
  server: McpServer,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpConnection> {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('a stdio server needs a command to start')
    return connectStdio(server, timeoutMs)
  }
  if (!server.url) throw new Error('an http server needs a url')
  return connectHttp(server, timeoutMs)
}

/**
 * Call one tool on a server.
 *
 * The call opens its own connection: an MCP server is a process (stdio) or
 * an endpoint (http), and the factory does not keep a pool of them for a
 * terminal that may run for hours.
 */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpToolResult> {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('a stdio server needs a command to start')
    const child = await startServerProcess(server)
    const lines = new JsonRpcLines()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => lines.push(String(chunk)))
    child.stderr.resume()
    child.on('exit', code => {
      lines.failAll(new Error(`the server exited (code ${code ?? 'null'})`))
    })
    let spawnError: Error | undefined
    child.on('error', error => {
      spawnError = error
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 60))
      if (spawnError) throw spawnError
      await request(
        child,
        lines,
        1,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'wednesday', version: '1' },
        },
        timeoutMs,
      )
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      )
      const result = (await request(
        child,
        lines,
        2,
        'tools/call',
        { name: toolName, arguments: args },
        timeoutMs,
      )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      return {
        text: flattenContent(result?.content),
        isError: result?.isError === true,
      }
    } finally {
      child.stdin.end()
      child.kill()
    }
  }

  if (!server.url) throw new Error('an http server needs a url')
  const initializeResponse = await httpExchange(
    server,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wednesday', version: '1' },
      },
    },
    timeoutMs,
  )
  await httpExchange(
    server,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    timeoutMs,
    initializeResponse.sessionId,
  ).catch(() => undefined)
  const called = await httpExchange(
    server,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
    timeoutMs,
    initializeResponse.sessionId,
  )
  if (called.status >= 400) {
    throw new Error(`the server answered ${called.status}: ${called.text.slice(0, 200)}`)
  }
  const answer = parseHttpAnswer(called.text)
  if (answer?.error) {
    throw new Error(answer.error.message ?? 'tools/call failed')
  }
  const result = answer?.result as
    | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    | undefined
  return {
    text: flattenContent(result?.content),
    isError: result?.isError === true,
  }
}

/** The tool's content blocks, flattened to text. */
function flattenContent(
  content: Array<{ type?: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

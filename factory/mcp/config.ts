/**
 * THE OPERATOR'S MCP SERVERS — the registry (2026-11-11).
 *
 * THE ASK: "an MCP server the operator can attach, listed and connected from
 * the terminal".
 *
 * WHY A REGISTRY AND NOT A CONFIG FILE THE OPERATOR EDITS BY HAND:
 *
 * `/mcp` has to LIST the servers and their state, so the factory needs to
 * read them. A file the operator hand-edits is a file the factory has to
 * parse defensively, and a parse failure is a silent no-op: the operator
 * typed `/mcp`, saw nothing, and learned nothing. The registry is JSON the
 * factory writes, with a shape it controls, and a broken file is REPORTED.
 *
 * WHERE IT LIVES: `~/.wednesday/state/mcp.json` — beside the other operator
 * state. It is the operator's own file: it holds the commands and the URLs
 * of servers they chose to attach.
 *
 * THE SECRETS RULE: a server's `env` and `headers` can carry a token. The
 * registry stores them (that is the operator's own machine and their own
 * file), but they are NEVER printed: the command shows the KEY NAMES, not
 * the values, and the redaction pass runs over every receipt as a second
 * line of defence.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { STATE_HOME } from '../paths'

/** How a server is reached. */
export type McpTransport = 'stdio' | 'http'

/** One MCP server the operator attached. */
export interface McpServer {
  /** The local namespace: `mcp__<name>__<tool>`. Letters, digits, dash, underscore. */
  name: string
  transport: McpTransport
  /** stdio: the executable to start. */
  command?: string
  /** stdio: its arguments. */
  args?: string[]
  /** stdio: extra environment for the child. The VALUES are never printed. */
  env?: Record<string, string>
  /** stdio: the child's working directory. */
  cwd?: string
  /** http: the endpoint. */
  url?: string
  /** http: extra headers. The VALUES are never printed. */
  headers?: Record<string, string>
  /** A disabled server stays in the registry and is not offered to the model. */
  enabled: boolean
  /** What the last connection attempt found. */
  state?: McpServerState
}

/** One tool a server exposes. */
export interface McpTool {
  /** The server's own name for it. */
  name: string
  /** What the tool does, in the server's words. */
  description?: string
  /** The JSON Schema of its arguments. */
  inputSchema?: Record<string, unknown>
}

/** What the last connection attempt found. */
export interface McpServerState {
  /** 'connected' when the handshake and the tool listing worked. */
  status: 'connected' | 'failed' | 'never'
  /** The server's own name, when it answered. */
  serverInfo?: string
  /** The protocol version it speaks. */
  protocolVersion?: string
  /** How many tools it exposes. */
  tools?: number
  /** The tools it exposes, with their schemas: the model needs them to call. */
  toolDefinitions?: McpTool[]
  /** Why it failed, when it did. */
  error?: string
  /** When it was last tried (epoch ms). */
  checkedAt?: number
}

/** The whole registry. */
export interface McpRegistry {
  servers: McpServer[]
}

/** Where the registry lives. */
export function mcpRegistryPath(): string {
  return join(STATE_HOME, 'mcp.json')
}

/** The names a server may have (they become a tool namespace). */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Is this a usable server name? */
export function isValidServerName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/**
 * Read the registry.
 *
 * A missing file is an empty registry (the normal state of a machine where
 * the operator has attached nothing). A BROKEN file is reported, because a
 * registry the factory cannot read is a registry the operator must be told
 * about -- silently pretending it is empty would lose their servers on the
 * next write.
 */
export async function loadMcpRegistry(
  path: string = mcpRegistryPath(),
): Promise<{ registry: McpRegistry; error?: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { registry: { servers: [] } }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<McpRegistry>
    const servers = Array.isArray(parsed.servers) ? parsed.servers : []
    return {
      registry: {
        servers: servers.filter(isServerShape).map(normalizeServer),
      },
    }
  } catch (error) {
    return {
      registry: { servers: [] },
      error: `the MCP registry at ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/** Is this object shaped like a server? */
function isServerShape(value: unknown): value is McpServer {
  if (!value || typeof value !== 'object') return false
  const server = value as Partial<McpServer>
  return (
    typeof server.name === 'string' &&
    (server.transport === 'stdio' || server.transport === 'http')
  )
}

/** Fill in the optional fields, so the rest of the code never checks twice. */
function normalizeServer(server: McpServer): McpServer {
  return {
    ...server,
    args: server.args ?? [],
    env: server.env ?? {},
    headers: server.headers ?? {},
    enabled: server.enabled !== false,
  }
}

/** Write the registry. The write is atomic: a half-written registry is worse than none. */
export async function saveMcpRegistry(
  registry: McpRegistry,
  path: string = mcpRegistryPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** Add a server (or refuse: a name may only be used once). */
export async function addMcpServer(
  server: McpServer,
  path: string = mcpRegistryPath(),
): Promise<{ ok: boolean; error?: string }> {
  const { registry, error } = await loadMcpRegistry(path)
  if (error) return { ok: false, error }
  if (!isValidServerName(server.name)) {
    return {
      ok: false,
      error: `"${server.name}" is not a usable name — use letters, digits, dash and underscore (max 32)`,
    }
  }
  if (registry.servers.some(existing => existing.name === server.name)) {
    return { ok: false, error: `a server named "${server.name}" is already attached` }
  }
  if (server.transport === 'stdio' && !server.command) {
    return { ok: false, error: 'a stdio server needs a command to start' }
  }
  if (server.transport === 'http' && !server.url) {
    return { ok: false, error: 'an http server needs a url' }
  }
  registry.servers.push(normalizeServer(server))
  await saveMcpRegistry(registry, path)
  return { ok: true }
}

/** Remove a server by name. */
export async function removeMcpServer(
  name: string,
  path: string = mcpRegistryPath(),
): Promise<{ ok: boolean; error?: string }> {
  const { registry, error } = await loadMcpRegistry(path)
  if (error) return { ok: false, error }
  const before = registry.servers.length
  registry.servers = registry.servers.filter(server => server.name !== name)
  if (registry.servers.length === before) {
    return { ok: false, error: `no server named "${name}" is attached` }
  }
  await saveMcpRegistry(registry, path)
  return { ok: true }
}

/** Turn a server on or off. */
export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  path: string = mcpRegistryPath(),
): Promise<{ ok: boolean; error?: string }> {
  const { registry, error } = await loadMcpRegistry(path)
  if (error) return { ok: false, error }
  const server = registry.servers.find(candidate => candidate.name === name)
  if (!server) return { ok: false, error: `no server named "${name}" is attached` }
  server.enabled = enabled
  await saveMcpRegistry(registry, path)
  return { ok: true }
}

/** Record what a connection attempt found. */
export async function recordMcpServerState(
  name: string,
  state: McpServerState,
  path: string = mcpRegistryPath(),
): Promise<void> {
  const { registry } = await loadMcpRegistry(path)
  const server = registry.servers.find(candidate => candidate.name === name)
  if (!server) return
  server.state = state
  await saveMcpRegistry(registry, path)
}

/**
 * The servers the model may use: the enabled ones, with their cached tools.
 *
 * A server whose last connection failed is still offered (the operator may
 * have fixed it since), but its state is carried along so the harness can
 * say so.
 */
export function usableMcpServers(registry: McpRegistry): McpServer[] {
  return registry.servers.filter(server => server.enabled)
}

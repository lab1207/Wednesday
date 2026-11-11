/**
 * `/mcp` — the operator's MCP servers (2026-11-11).
 *
 * THE ASK: "an MCP server the operator can attach, listed and connected from
 * the terminal".
 *
 * THE GRAMMAR:
 *
 *   /mcp                            the servers, with their state
 *   /mcp add <name> stdio <cmd> ..  attach a server that runs as a process
 *   /mcp add <name> http <url>      attach a server that answers over HTTP
 *   /mcp connect <name>             connect now and list its tools
 *   /mcp enable <name>              offer it to the model again
 *   /mcp disable <name>             keep it, but do not offer it
 *   /mcp show <name>                what it is, and what it exposes
 *   /mcp remove <name>              detach it
 *
 * EVERY RECEIPT SAYS THE STATE. "Attached" and "working" are different
 * claims: a server can be attached and still be down, and an operator who
 * cannot tell the difference will blame the model for not using the tool.
 */

import {
  addMcpServer,
  loadMcpRegistry,
  mcpRegistryPath,
  recordMcpServerState,
  removeMcpServer,
  setMcpServerEnabled,
  type McpServer,
} from '../mcp/config'
import { connectMcpServer } from '../mcp/client'

/** The surface this command needs (the harness's ReplUi satisfies it). */
export interface McpUi {
  note(text: string): void
  error(text: string): void
}

/**
 * Split a line into tokens, honouring quotes.
 *
 * A server's arguments often contain spaces (`--root "C:\My Server"`), so
 * the grammar needs quoting. An unbalanced quote stays literal rather than
 * swallowing the rest of the line.
 */
export function tokenizeMcp(line: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index]!)) index += 1
    if (index >= line.length) break
    const open = line[index]!
    const quote = open === '"' || open === "'" ? open : null
    if (quote) index += 1
    let token = ''
    let closed = !quote
    while (index < line.length) {
      const character = line[index]!
      if (character === '\\' && line[index + 1] === '"') {
        token += '"'
        index += 2
        continue
      }
      if (quote && character === quote) {
        closed = true
        index += 1
        break
      }
      if (!quote && /\s/.test(character)) break
      token += character
      index += 1
    }
    if (!closed && quote) token = open + token
    tokens.push(token)
  }
  return tokens
}

/** One line per server. */
export function serverLine(server: McpServer): string {
  const state = server.state
  const status =
    state?.status === 'connected'
      ? `connected · ${state.tools ?? 0} tool${state.tools === 1 ? '' : 's'}`
      : state?.status === 'failed'
        ? `FAILED · ${state.error ?? 'unknown reason'}`
        : 'not connected yet'
  const target =
    server.transport === 'stdio'
      ? `${server.command ?? '?'} ${(server.args ?? []).join(' ')}`.trim()
      : (server.url ?? '?')
  const off = server.enabled ? '' : ' · OFF'
  return `  ${server.name}  [${server.transport}]  ${status}${off}\n      ${target}`
}

/**
 * Run the `/mcp` command.
 *
 * @param ui - where the receipts go.
 * @param arg - the rest of the line.
 */
export async function mcpFlow(ui: McpUi, arg: string): Promise<void> {
  const parts = tokenizeMcp(arg.trim())
  const verb = (parts[0] ?? '').toLowerCase()

  if (!verb) {
    const { registry, error } = await loadMcpRegistry()
    if (error) ui.error(error)
    if (registry.servers.length === 0) {
      ui.note('no MCP servers attached.')
      ui.note('  add: /mcp add <name> stdio <command> [args...]   ·   /mcp add <name> http <url>')
      return
    }
    ui.note(`mcp servers: ${registry.servers.length}`)
    for (const server of registry.servers) ui.note(serverLine(server))
    ui.note('  connect: /mcp connect <name>   remove: /mcp remove <name>   on/off: /mcp enable|disable <name>')
    return
  }

  if (verb === 'add') {
    const name = parts[1] ?? ''
    const transport = (parts[2] ?? '').toLowerCase()
    if (!name || !transport) {
      ui.error('add what? /mcp add <name> stdio <command> [args...]   ·   /mcp add <name> http <url>')
      return
    }
    const server: McpServer = {
      name,
      transport: transport === 'http' || transport === 'streamable-http' ? 'http' : 'stdio',
      enabled: true,
    }
    if (server.transport === 'http') {
      server.url = parts[3]
      if (!server.url) {
        ui.error('an http server needs a url: /mcp add <name> http <url>')
        return
      }
    } else {
      server.command = parts[3]
      server.args = parts.slice(4)
      if (!server.command) {
        ui.error('a stdio server needs a command: /mcp add <name> stdio <command> [args...]')
        return
      }
    }
    const added = await addMcpServer(server)
    if (!added.ok) {
      ui.error(`server not attached: ${added.error}`)
      return
    }
    ui.note(`mcp server attached: ${name} (${server.transport})`)
    // ATTACHING IS NOT CONNECTING. The server may be down, and the
    // operator is told which of the two happened.
    await connectAndReport(ui, name)
    return
  }

  if (verb === 'remove' || verb === 'rm') {
    const name = parts[1] ?? ''
    if (!name) {
      ui.error('remove which server? /mcp remove <name>')
      return
    }
    const removed = await removeMcpServer(name)
    if (!removed.ok) {
      ui.error(removed.error ?? 'the server was not removed')
      return
    }
    ui.note(`mcp server detached: ${name}`)
    return
  }

  if (verb === 'enable' || verb === 'disable' || verb === 'on' || verb === 'off') {
    const name = parts[1] ?? ''
    if (!name) {
      ui.error(`which server? /mcp ${verb} <name>`)
      return
    }
    const enabled = verb === 'enable' || verb === 'on'
    const changed = await setMcpServerEnabled(name, enabled)
    if (!changed.ok) {
      ui.error(changed.error ?? 'the server was not changed')
      return
    }
    ui.note(
      enabled
        ? `mcp server ${name} is enabled — the model may use its tools`
        : `mcp server ${name} is disabled — it stays attached, but no tool is offered`,
    )
    return
  }

  if (verb === 'connect') {
    const name = parts[1] ?? ''
    if (!name) {
      ui.error('connect which server? /mcp connect <name>')
      return
    }
    await connectAndReport(ui, name)
    return
  }

  if (verb === 'show') {
    const name = parts[1] ?? ''
    if (!name) {
      ui.error('show which server? /mcp show <name>')
      return
    }
    const { registry } = await loadMcpRegistry()
    const server = registry.servers.find(candidate => candidate.name === name)
    if (!server) {
      ui.error(`no server named "${name}" is attached`)
      return
    }
    ui.note(serverLine(server))
    if (server.env && Object.keys(server.env).length > 0) {
      // The KEY NAMES, never the values: an env entry can hold a token.
      ui.note(`      env: ${Object.keys(server.env).join(', ')} (values are not shown)`)
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      ui.note(`      headers: ${Object.keys(server.headers).join(', ')} (values are not shown)`)
    }
    for (const tool of server.state?.toolDefinitions ?? []) {
      ui.note(`      tool: mcp__${server.name}__${tool.name}`)
    }
    return
  }

  ui.error(`unknown: /mcp ${verb} — try: /mcp · add · connect · enable · disable · show · remove`)
}

/**
 * Connect to a server, record what happened, and say so.
 *
 * The state is recorded either way: a failed connection is information the
 * operator needs, and the next `/mcp` must not say "not connected yet" about
 * a server that was tried and refused.
 */
async function connectAndReport(ui: McpUi, name: string): Promise<void> {
  const { registry } = await loadMcpRegistry()
  const server = registry.servers.find(candidate => candidate.name === name)
  if (!server) {
    ui.error(`no server named "${name}" is attached`)
    return
  }
  try {
    const connection = await connectMcpServer(server)
    await recordMcpServerState(name, {
      status: 'connected',
      serverInfo: connection.serverInfo?.name,
      protocolVersion: connection.protocolVersion,
      tools: connection.tools.length,
      toolDefinitions: connection.tools,
      checkedAt: Date.now(),
    })
    const who = connection.serverInfo?.name
      ? ` (server "${connection.serverInfo.name}"${connection.serverInfo.version ? ` ${connection.serverInfo.version}` : ''})`
      : ''
    ui.note(`mcp connected: ${name}${who} · ${connection.tools.length} tool(s)`)
    for (const tool of connection.tools) {
      ui.note(`  mcp__${name}__${tool.name}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await recordMcpServerState(name, {
      status: 'failed',
      error: reason,
      checkedAt: Date.now(),
    })
    ui.error(`mcp ${name} did not connect: ${reason}`)
  }
}

/** Where the registry lives (for the operator who wants to look). */
export function mcpRegistryLocation(): string {
  return mcpRegistryPath()
}

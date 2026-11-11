/**
 * THE MCP TOOLS THE MODEL MAY CALL (2026-11-11).
 *
 * The registry holds the servers; this module turns the tools they expose
 * into the shape the model router sends on the wire, and runs a call the
 * model asked for.
 *
 * THE NAMING: `mcp__<server>__<tool>`. Two servers may expose a tool with
 * the same name, and the model has to be able to tell them apart -- so the
 * server's name is part of the tool's name. The DSH MCP client uses the
 * same convention, so a tool the operator knows from another harness reads
 * the same here.
 */

import type { ToolSpec } from '../model-router/types'
import type { ChatToolOptions } from '../model-router/chat-stream'
import { canUseNativeTools } from '../model-router/providers/request-body'
import { callMcpTool } from './client'
import { loadMcpRegistry, type McpRegistry, type McpServer, type McpTool } from './config'

/** One tool, bound to the server that owns it. */
export interface McpToolBinding {
  /** The server that owns the tool. */
  server: McpServer
  /** The tool's own definition. */
  tool: McpTool
  /** The name the model sees. */
  wireName: string
}

/** The name the model sees for a tool. */
export function mcpWireName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * The tools the attached servers expose.
 *
 * Only the ENABLED servers, and only the tools that were discovered by a
 * successful connection: a tool the factory has never seen has no schema,
 * and a model cannot call a tool it cannot describe.
 */
export function mcpToolBindings(registry: McpRegistry): McpToolBinding[] {
  const bindings: McpToolBinding[] = []
  for (const server of registry.servers) {
    if (!server.enabled) continue
    if (server.state?.status !== 'connected') continue
    for (const tool of server.state.toolDefinitions ?? []) {
      bindings.push({
        server,
        tool,
        wireName: mcpWireName(server.name, tool.name),
      })
    }
  }
  return bindings
}

/** The wire shape of the bound tools. */
export function mcpToolSpecs(bindings: McpToolBinding[]): ToolSpec[] {
  return bindings.map(binding => ({
    name: binding.wireName,
    description:
      binding.tool.description ?? `${binding.server.name}: ${binding.tool.name}`,
    parameters:
      binding.tool.inputSchema ?? { type: 'object', properties: {} },
  }))
}

/**
 * Run a tool the model asked for.
 *
 * @param bindings - the tools the model was offered.
 * @param wireName - the name the model used.
 * @param args - the arguments the model wrote.
 * @returns the tool's output, as text.
 * @throws when the tool is not one of the offered ones (a model may invent a
 * name) or when the server refuses.
 */
export async function runMcpTool(
  bindings: McpToolBinding[],
  wireName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const binding = bindings.find(candidate => candidate.wireName === wireName)
  if (!binding) {
    throw new Error(`no attached server offers a tool called "${wireName}"`)
  }
  const result = await callMcpTool(binding.server, binding.tool.name, args)
  const text = result.text.trim()
  if (result.isError) {
    throw new Error(text || 'the tool reported a failure')
  }
  return text
}

/**
 * The tool options for one chat turn.
 *
 * TWO GATES, both of them refusals:
 *
 *  - The MODEL must be known to do native tool calls. A model that is not
 *    will answer with prose about the tools instead of calling them, and
 *    prose that looks like a tool call is worse than no tools at all.
 *  - There must be at least one tool to offer. With none, the request body
 *    carries no `tools` field and is byte-identical to what it always was.
 *
 * @param model - the routed model id.
 * @param provider - the routed provider, so the registry can refine the match.
 * @param onToolCall - told about every call the model makes.
 * @returns the options, or undefined when there is nothing to offer.
 */
export async function mcpChatToolOptions(
  model: string,
  provider?: string,
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
): Promise<ChatToolOptions | undefined> {
  if (!canUseNativeTools(model, provider)) return undefined
  const { registry } = await loadMcpRegistry()
  const bindings = mcpToolBindings(registry)
  if (bindings.length === 0) return undefined
  const specs = mcpToolSpecs(bindings)
  return {
    tools: specs,
    executeTool: async (name, args) => runMcpTool(bindings, name, args),
    onToolCall,
  }
}

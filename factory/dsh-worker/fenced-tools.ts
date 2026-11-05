import { exec } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface FencedToolCall {
  name: string
  args: Record<string, unknown>
}

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/g

/**
 * Small models (e.g. a 3B coder on a remote GPU) sometimes answer with the
 * tool call written as TEXT — a fenced JSON block like
 *   ```json {"name":"write","file_path":"index.html","content":"..."} ```
 * instead of a native tool-call block. A text tool call never executes, so
 * the turn "succeeds" while the workspace stays untouched. This extracts
 * those fenced calls so the host can run them as a fallback.
 *
 * Accepted shapes: {"name": "...", "arguments": {...}, ...} and the flat
 * {"name": "...", "file_path": "...", ...} form the 3B model actually emits.
 */
export function extractFencedToolCalls(text: string): FencedToolCall[] {
  const calls: FencedToolCall[] = []
  for (const match of text.matchAll(FENCE_RE)) {
    const body = (match[1] ?? '').trim()
    if (!body.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const name = record.name
    if (typeof name !== 'string' || name.length === 0) continue
    const args: Record<string, unknown> = {}
    const inner = record.arguments
    if (typeof inner === 'string') {
      try {
        const innerParsed: unknown = JSON.parse(inner)
        if (typeof innerParsed === 'object' && innerParsed !== null) {
          Object.assign(args, innerParsed as Record<string, unknown>)
        }
      } catch {
        // fall through to the flat keys below
      }
    } else if (typeof inner === 'object' && inner !== null) {
      Object.assign(args, inner as Record<string, unknown>)
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'name' && key !== 'arguments') args[key] = value
    }
    calls.push({ name: name.toLowerCase(), args })
  }
  return calls
}

function confinedPath(workspace: string, raw: unknown): string {
  const rel = typeof raw === 'string' && raw.length > 0 ? raw : ''
  const target = resolve(workspace, isAbsolute(rel) ? rel : rel)
  const base = resolve(workspace)
  if (target !== base && !target.startsWith(base + '/') && !target.startsWith(base + '\\')) {
    throw new Error(`path escapes workspace: ${rel}`)
  }
  return target
}

function pick(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined) return value
  }
  return undefined
}

const MAX_OUTPUT = 4000

function clip(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n[... truncated ${text.length - MAX_OUTPUT} characters]`
}

async function runOne(workspace: string, call: FencedToolCall): Promise<string> {
  const { name, args } = call
  if (name === 'read' || name === 'read_file' || name === 'cat') {
    const file = confinedPath(workspace, pick(args, 'file_path', 'path', 'file'))
    const content = readFileSync(file, 'utf8')
    return `[read ${file}]\n${clip(content)}`
  }
  if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'create') {
    const file = confinedPath(workspace, pick(args, 'file_path', 'path', 'file'))
    const content = pick(args, 'content', 'text', 'contents')
    if (typeof content !== 'string') throw new Error('write: missing string content')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
    return `[write ${file}] ${content.length} bytes written`
  }
  if (name === 'bash' || name === 'exec' || name === 'run' || name === 'shell' || name === 'command') {
    const command = pick(args, 'command', 'cmd', 'script')
    if (typeof command !== 'string' || command.length === 0) throw new Error('bash: missing command')
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspace,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })
    return `[bash ${command}]\n${clip(`${stdout}${stderr}`.trim())}`
  }
  if (name === 'ls' || name === 'list') {
    const dir = confinedPath(workspace, pick(args, 'path', 'dir') ?? '.')
    // Read the directory in-process. The previous `node -e "... " + JSON.stringify(dir)`
    // went through a shell, so a directory name containing `$(...)` or a
    // backtick ran as a command (command injection through a model-written
    // path). No shell is involved here at all.
    const entries = readdirSync(dir, { withFileTypes: true })
      .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort()
    return `[ls ${dir}]\n${clip(entries.join('\n'))}`
  }
  throw new Error(`unsupported tool in fenced fallback: ${name}`)
}

/**
 * Execute extracted fenced tool calls inside the workspace (path-confined).
 * Returns a transcript the host appends to the model's answer so the next
 * turn (and the operator) sees what actually ran.
 *
 * `onCall` reports each call as it runs, so the operator sees the command
 * execute rather than a transcript that appears at the end.
 */
export async function runFencedToolCalls(
  workspace: string,
  calls: FencedToolCall[],
  onCall?: (call: FencedToolCall, status: 'completed' | 'failed') => void,
): Promise<string> {
  const parts: string[] = []
  for (const call of calls) {
    try {
      parts.push(await runOne(workspace, call))
      onCall?.(call, 'completed')
    } catch (error) {
      parts.push(`[${call.name} failed] ${error instanceof Error ? error.message : String(error)}`)
      onCall?.(call, 'failed')
    }
  }
  return parts.join('\n\n')
}

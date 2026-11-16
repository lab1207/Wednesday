import { exec } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface TextToolCall {
  name: string
  args: Record<string, unknown>
}

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/g

/**
 * The string delimiter a model puts around a value when it writes its tool
 * call as TEXT: `write{file_path:<|"|>index.html<|"|>}`.
 *
 * Three encodings reach this module, and all of them have to work. The
 * fenced form is JSON in a ```json block. The delimited form is pseudo-JSON
 * with no fences. The parenthesised form is a call with quoted arguments:
 * `write(file_path='index.html', content="...")`. A tool call the model
 * cannot express is a turn that SUCCEEDS while the workspace stays
 * untouched, so an encoding this module does not recognise is a silent no-op
 * on the work — and the encoding a model picks varies from run to run.
 */
const DELIMITED_HEAD_RE = /([A-Za-z_][A-Za-z0-9_]*)\{/g
const DELIMITED_FIELD_RE = /^\s*,?\s*([A-Za-z_][A-Za-z0-9_]*)\s*:<\|"\|>([\s\S]*?)<\|"\|>/
const PARENTHESIZED_HEAD_RE = /([A-Za-z_][A-Za-z0-9_]*)\(/g

/**
 * The tools a text call may name.
 *
 * The fenced form is JSON, so its name can be anything — an unknown name is
 * reported as an unsupported tool. The heuristic forms (delimited,
 * parenthesised) are only recognised for these names: they are found by
 * their shape, and a file's own source can have the shape of a call.
 */
const TEXT_TOOL_NAMES = new Set([
  'read', 'read_file', 'cat',
  'write', 'write_file', 'create',
  'edit', 'str_replace', 'replace',
  'bash', 'exec', 'run', 'shell', 'command',
  'ls', 'list',
])

/**
 * Small models (e.g. a 3B coder on a remote GPU) sometimes answer with the
 * tool call written as TEXT — a fenced JSON block like
 *   ```json {"name":"write","file_path":"index.html","content":"..."} ```
 * or the delimited pseudo-JSON form
 *   write{file_path:<|"|>index.html<|"|>,content:<|"|>...<|"|>}
 * or the parenthesised form
 *   write(file_path='index.html', content="...")
 * instead of a native tool-call block. A text tool call never executes, so
 * the turn "succeeds" while the workspace stays untouched. This extracts
 * those calls so the host can run them as a fallback.
 *
 * Accepted shapes: {"name": "...", "arguments": {...}, ...}, the flat
 * {"name": "...", "file_path": "...", ...} form, the delimited
 * `name{key:<|"|>value<|"|>}` form, and the parenthesised
 * `name(key='value')` form.
 */
export function extractTextToolCalls(text: string): TextToolCall[] {
  const calls = extractFencedCalls(text)
  const seen = new Set(calls.map(call => signature(call)))

  for (const match of text.matchAll(DELIMITED_HEAD_RE)) {
    const name = match[1]
    const headEnd = match.index + match[0].length
    if (name === undefined) continue
    const call = delimitedCall(text, headEnd, name)
    if (!call) continue
    const key = signature(call)
    if (seen.has(key)) continue
    seen.add(key)
    calls.push(call)
  }

  for (const match of text.matchAll(PARENTHESIZED_HEAD_RE)) {
    const name = match[1]
    const open = match.index + match[0].length - 1
    if (name === undefined) continue
    if (!atLineStart(text, match.index)) continue
    const call = parenthesizedCall(text, open, name)
    if (!call) continue
    const key = signature(call)
    if (seen.has(key)) continue
    seen.add(key)
    calls.push(call)
  }

  return calls
}

/** Whether the head of a call starts its line (or the whole text). */
function atLineStart(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor]
    if (char === '\n') return true
    if (char !== ' ' && char !== '\t' && char !== '\r') return false
  }
  return true
}

/** A stable identity for a call, so one call written twice runs once. */
function signature(call: TextToolCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`
}

/** The fenced JSON form. */
function extractFencedCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
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

/**
 * The delimited pseudo-JSON form: `name{key:<|"|>value<|"|>,key2:<|"|>…<|"|>}`.
 *
 * The closing brace is NOT the end of a field: a written file is full of
 * braces, so the fields are read by their delimiter and the call ends where
 * the delimiter run ends.
 * @param text - the whole answer text.
 * @param headEnd - the index just after the opening brace of the call head.
 * @param name - the tool name the head announced.
 * @returns the call, or undefined when the head is not a call at all.
 */
function delimitedCall(text: string, headEnd: number, name: string): TextToolCall | undefined {
  if (!TEXT_TOOL_NAMES.has(name.toLowerCase())) return undefined
  const args: Record<string, unknown> = {}
  let pos = headEnd
  for (;;) {
    const match = DELIMITED_FIELD_RE.exec(text.slice(pos))
    if (!match) break
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined) break
    args[key] = value
    pos += match[0].length
  }
  if (Object.keys(args).length === 0) return undefined
  if (!/^\s*\}/.test(text.slice(pos))) return undefined
  return { name: name.toLowerCase(), args }
}

/**
 * The parenthesised form: `name(key='value', key2="value2")`.
 *
 * A quoted value may contain the OTHER quote character unescaped, and may
 * contain its own quote character unescaped too (the model does not escape
 * what it writes). So a value ends at the quote where the CALL's own syntax
 * continues — the end of the argument list, or the next argument.
 * @param text - the whole answer text.
 * @param open - the index of the opening parenthesis.
 * @param name - the tool name the head announced.
 * @returns the call, or undefined when the head is not a call at all.
 */
function parenthesizedCall(text: string, open: number, name: string): TextToolCall | undefined {
  if (!TEXT_TOOL_NAMES.has(name.toLowerCase())) return undefined
  const args: Record<string, unknown> = {}
  let pos = open + 1
  for (;;) {
    while (pos < text.length && (/\s/.test(text[pos] as string) || text[pos] === ',')) pos += 1
    if (pos >= text.length) return undefined
    if (text[pos] === ')') break
    const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos))
    if (!key) return undefined
    pos += key[0].length
    while (pos < text.length && /\s/.test(text[pos] as string)) pos += 1
    if (text[pos] !== '=') return undefined
    pos += 1
    while (pos < text.length && /\s/.test(text[pos] as string)) pos += 1
    const quote = text[pos]
    if (quote !== "'" && quote !== '"') return undefined
    const value = quotedValue(text, pos)
    if (!value) return undefined
    args[key[0]] = value.text
    pos = value.end
  }
  if (Object.keys(args).length === 0) return undefined
  return { name: name.toLowerCase(), args }
}

/**
 * One quoted value and the index just past its closing quote.
 *
 * The closing quote is the one where the CALL's own syntax continues: the
 * end of the argument list (`)`), or the next argument (`", name=`). The
 * model writes its content with unescaped quotes, so the first quote inside
 * the value is not the end of it — but a quote inside the value is never
 * followed by the call's punctuation.
 */
function quotedValue(text: string, start: number): { text: string; end: number } | undefined {
  const quote = text[start]
  if (quote === undefined) return undefined
  for (let index = text.indexOf(quote, start + 1); index >= 0; index = text.indexOf(quote, index + 1)) {
    const after = text.slice(index + 1)
    if (/^\s*\)/.test(after) || /^\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(after)) {
      return { text: text.slice(start + 1, index), end: index + 1 }
    }
  }
  return undefined
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

async function runOne(workspace: string, call: TextToolCall): Promise<string> {
  const { name, args } = call
  if (name === 'read' || name === 'read_file' || name === 'cat') {
    const file = confinedPath(workspace, pick(args, 'file_path', 'path', 'file'))
    const content = readFileSync(file, 'utf8')
    return `[read ${file}]\n${clip(content)}`
  }
  if (name === 'edit' || name === 'str_replace' || name === 'replace') {
    // An EDIT is a replacement, not a whole-file write. The old code routed
    // 'edit' to the write branch, so a text-emitted edit either failed with
    // "missing string content" or, worse, wrote the replacement over the
    // whole file.
    const file = confinedPath(workspace, pick(args, 'file_path', 'path', 'file'))
    const oldString = pick(args, 'old_string', 'old')
    const newString = pick(args, 'new_string', 'new')
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new Error('edit: missing old_string or new_string')
    }
    const current = readFileSync(file, 'utf8')
    if (!current.includes(oldString)) {
      throw new Error(`edit: old_string not found in ${file}`)
    }
    // The replacement is a FUNCTION: a `$&` or `$1` inside the new text is
    // literal text the model wrote, not a substitution pattern.
    const next = current.replace(oldString, () => newString)
    writeFileSync(file, next, 'utf8')
    return `[edit ${file}] ${String(oldString.length)} chars replaced with ${String(newString.length)} chars`
  }
  if (name === 'write' || name === 'write_file' || name === 'create') {
    const file = confinedPath(workspace, pick(args, 'file_path', 'path', 'file'))
    const content = pick(args, 'content', 'text', 'contents')
    if (typeof content !== 'string') throw new Error('write: missing string content')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
    return `[write ${file}] ${content.length} bytes written`
  }
  if (name === 'bash' || name === 'exec' || name === 'run' || name === 'shell' || name === 'command') {
    const command = pick(args, 'command', 'cmd', 'script')
    if (typeof command !== 'string' || command.length === 0) throw new Error('bash: missing string command')
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
  throw new Error(`unsupported tool in text fallback: ${name}`)
}

/**
 * Execute extracted tool calls inside the workspace (path-confined).
 * Returns a transcript the host appends to the model's answer so the next
 * turn (and the operator) sees what actually ran.
 *
 * `onCall` reports each call as it runs, so the operator sees the command
 * execute rather than a transcript that appears at the end.
 */
export async function runTextToolCalls(
  workspace: string,
  calls: TextToolCall[],
  onCall?: (call: TextToolCall, status: 'completed' | 'failed') => void,
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

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `wednesday setup` — register the MCP server with the clients the operator
 * already uses (2026-11-15).
 *
 * WHY THIS EXISTS: on 2026-11-14 the product became an MCP server, and the
 * only way to connect it was to hand-edit a config file in every client. That
 * is not a product, it is a scavenger hunt. REA proves the shape: a server
 * plus one command that makes it installable.
 *
 * RULES THIS FILE KEEPS:
 *
 *  1. **Never destroy a config.** Every file is backed up before it is
 *     touched, parsed as JSON before it is written, and abandoned (with the
 *     reason) if it is not what we think it is. A comment in a `.jsonc` file
 *     is the operator's property; we skip instead of stripping it.
 *  2. **Prefer the client's own CLI.** `claude mcp add` and `opencode mcp add`
 *     know their own schema and their own locks; a direct write is the
 *     fallback, not the first move.
 *  3. **Deterministic and testable.** No network, no prompts, no clock:
 *     paths, PATH, timestamps and the executor are injectable, so the test
 *     proves the real writer against a temp home.
 *  4. **The command is absolute.** `[node, <this checkout>/bin/wednesday-mcp.js]`
 *     works without PATH, without a global link, and without the Windows
 *     `.cmd` shim problem (B241). `--command` exists for people who linked
 *     the bin globally and prefer `wednesday-mcp`.
 */

export const SERVER_NAME = 'wednesday'

export type ClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'opencode'

export interface ExecResult {
  status: number | null
  stdout?: string
  stderr?: string
}

export type Exec = (command: string, args: string[], env: NodeJS.ProcessEnv) => ExecResult

export interface SetupOptions {
  /** Exact command line the client launches. Default: node + this bin. */
  command?: string[]
  /** Home directory; tests inject a temp dir. */
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Limit to these clients. Undetected ones are still configured when named. */
  clients?: ClientId[]
  /** Also configure clients that were not detected. */
  all?: boolean
  /** Plan only: print what would change, touch nothing. */
  dryRun?: boolean
  /** Fixed backup stamp (`YYYYMMDD-HHMMSS`); tests pin it. */
  stamp?: string
  /** Injected fs probe (tests). */
  exists?: (path: string) => boolean
  /** Injected PATH probe (tests). */
  which?: (binary: string) => string | undefined
  /** Injected process runner for the client's own CLI (tests). */
  exec?: Exec
}

export type SetupAction = 'created' | 'updated' | 'unchanged' | 'skipped' | 'would-create' | 'would-update'

export interface SetupResult {
  client: ClientId
  label: string
  path: string
  action: SetupAction
  /** Registered through the client's own CLI instead of a file write. */
  via?: string
  backup?: string
  /** Why nothing was written. Always a sentence, never a code. */
  detail?: string
}

export interface SetupOutcome {
  command: string[]
  results: SetupResult[]
  counts: Record<SetupAction, number>
}

const LABELS: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  opencode: 'OpenCode',
}

const ORDER: ClientId[] = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'opencode']

/** The registration command for this checkout. */
export function defaultCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL('../bin/wednesday-mcp.js', import.meta.url))]
}

/** Split a shell-ish command line, honoring double quotes. */
export function parseCommandLine(line: string): string[] {
  const matches = line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return matches.map(token => token.replace(/"/g, ''))
}

/**
 * Where each client keeps its config, and where its own directory lives. The
 * directory is the detection signal: a config file may not exist yet in a
 * client that is installed, and `~` is not evidence of anything.
 */
interface Resolved {
  path: string
  directory: string
}

function resolveClients(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<ClientId, Resolved> {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config')

  const desktopDirectory = platform === 'win32'
    ? join(appData, 'Claude')
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude')
      : join(xdg, 'Claude')

  return {
    'claude-code': { path: join(home, '.claude.json'), directory: join(home, '.claude') },
    'claude-desktop': { path: join(desktopDirectory, 'claude_desktop_config.json'), directory: desktopDirectory },
    codex: { path: join(home, '.codex', 'config.toml'), directory: join(home, '.codex') },
    cursor: { path: join(home, '.cursor', 'mcp.json'), directory: join(home, '.cursor') },
    opencode: { path: join(xdg, 'opencode', 'opencode.json'), directory: join(xdg, 'opencode') },
  }
}

export interface Target {
  id: ClientId
  label: string
  path: string
  detected: boolean
}

export function listTargets(options: SetupOptions = {}): Target[] {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const which = options.which ?? (binary => whichOnPath(binary, platform, env, exists))
  const resolved = resolveClients(home, platform, env)

  const clients: Record<ClientId, string | undefined> = {
    'claude-code': 'claude',
    'claude-desktop': undefined,
    codex: 'codex',
    cursor: 'cursor',
    opencode: 'opencode',
  }

  return ORDER.map(id => {
    const { path, directory } = resolved[id]
    const cli = clients[id]
    const detected = exists(path) || exists(directory) || (cli ? Boolean(which(cli)) : false)

    return { id, label: LABELS[id], path, detected }
  })
}

/** PATH lookup that does not depend on a shell. */
export function whichOnPath(
  binary: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '']
    : ['']

  for (const directory of pathValue.split(separator)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, binary + extension)
      if (exists(candidate)) return candidate
    }
  }

  return undefined
}

export function runSetup(options: SetupOptions = {}): SetupOutcome {
  const command = options.command ?? defaultCommand()
  if (command.length === 0) throw new Error('The server command is empty.')

  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const which = options.which ?? (binary => whichOnPath(binary, platform, env, exists))
  const exec = options.exec ?? runProcess
  const stamp = options.stamp ?? timestamp(new Date())
  const resolved = resolveClients(home, platform, env)
  const targets = listTargets({ ...options, home, platform, env, exists, which })

  const wanted = targets.filter(target =>
    options.clients?.length ? options.clients.includes(target.id) : options.all || target.detected,
  )

  const results: SetupResult[] = []

  for (const target of wanted) {
    results.push(applyTarget(target, {
      command,
      path: resolved[target.id].path,
      platform,
      env,
      exists,
      which,
      exec,
      stamp,
      dryRun: Boolean(options.dryRun),
    }))
  }

  const counts: Record<SetupAction, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    'would-create': 0,
    'would-update': 0,
  }

  for (const result of results) counts[result.action] += 1

  return { command, results, counts }
}

interface ApplyContext {
  command: string[]
  path: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  which: (binary: string) => string | undefined
  exec: Exec
  stamp: string
  dryRun: boolean
}

function applyTarget(target: Target, context: ApplyContext): SetupResult {
  const base = { client: target.id, label: target.label, path: context.path }
  const exists = context.exists(context.path)
  const plan = planTarget(target, context)

  // Registered already: say so instead of running the client's CLI again.
  if (!('error' in plan) && !plan.changed) {
    return { ...base, action: 'unchanged' }
  }

  // The clients that ship a registration command own their own schema. Use
  // it before touching their file: a running client can rewrite its config
  // from memory and undo a direct edit.
  const cli = target.id === 'claude-code' ? 'claude' : target.id === 'opencode' ? 'opencode' : undefined
  const binary = cli ? context.which(cli) : undefined

  if (cli && binary) {
    const args = target.id === 'claude-code'
      ? ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ...context.command]
      : ['mcp', 'add', SERVER_NAME, '--global', '--', ...context.command]
    const via = `${cli} ${args.join(' ')}`

    if (context.dryRun) {
      return {
        ...base,
        action: exists ? 'would-update' : 'would-create',
        via,
        detail: 'dry run: the client CLI was not invoked',
      }
    }

    const result = runCli(context.exec, binary, args, context.platform, context.env)

    if (result.status === 0) {
      return { ...base, action: exists ? 'updated' : 'created', via }
    }

    // A failed CLI is not the end: fall through to the file writer, and
    // name the reason so the operator can see both attempts.
    const detail = (result.stderr || result.stdout || '').trim().split('\n')[0]

    return writeTarget(target, context, plan, exists, detail ? `${cli} mcp add failed: ${detail}` : `${cli} mcp add failed`)
  }

  if ('error' in plan) {
    return { ...base, action: 'skipped', detail: plan.error }
  }

  return writeTarget(target, context, plan, exists)
}

/** The exact bytes a file should hold, computed without writing anything. */
type Plan = { text: string; changed: boolean } | { error: string }

function planTarget(target: Target, context: ApplyContext): Plan {
  const original = context.exists(context.path) ? readFileSync(context.path, 'utf8') : undefined

  if (target.id === 'codex') return upsertCodex(original ?? '', context.command)

  if (target.id === 'opencode') return upsertOpenCode(original, context.command)

  const server = target.id === 'claude-code'
    ? { type: 'stdio', command: context.command[0], args: context.command.slice(1) }
    : { command: context.command[0], args: context.command.slice(1) }

  return upsertMcpServers(original, server)
}

function runCli(
  exec: Exec,
  binary: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ExecResult {
  // Windows ships npm-installed CLIs as `.cmd` batch shims, which a shell-free
  // spawn cannot execute (B241). `cmd /c` runs them with the arguments intact.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    const shell = env.ComSpec ?? 'cmd.exe'
    return exec(shell, ['/d', '/s', '/c', binary, ...args], env)
  }

  return exec(binary, args, env)
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): ExecResult {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env,
  })

  return {
    status: child.status,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? child.error?.message ?? '',
  }
}

function writeTarget(
  target: Target,
  context: ApplyContext,
  plan: Plan,
  exists: boolean,
  prefix?: string,
): SetupResult {
  const base = { client: target.id, label: target.label, path: context.path }

  if ('error' in plan) {
    return { ...base, action: 'skipped', detail: joinDetail(prefix, plan.error) }
  }

  if (context.dryRun) {
    return { ...base, action: exists ? 'would-update' : 'would-create', detail: prefix }
  }

  mkdirSync(dirname(context.path), { recursive: true })

  let backup: string | undefined

  if (exists) {
    backup = nextBackupPath(context.path, context.stamp, context.exists)
    copyFileSync(context.path, backup)
  }

  writeAtomic(context.path, plan.text)

  return {
    ...base,
    action: exists ? 'updated' : 'created',
    backup,
    detail: prefix,
  }
}

function joinDetail(prefix: string | undefined, detail: string): string {
  return prefix ? `${prefix}; ${detail}` : detail
}

/**
 * `~/.claude.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`:
 * a root `mcpServers` map, extra keys preserved verbatim.
 */
function upsertMcpServers(
  original: string | undefined,
  server: Record<string, unknown>,
): { text: string; changed: boolean } | { error: string } {
  const parsed = parseJsonObject(original)

  if ('error' in parsed) return parsed

  const { data, bom, indent } = parsed
  const servers = data.mcpServers

  if (servers !== undefined && !isObject(servers)) {
    return { error: '"mcpServers" is not an object, so this file was left untouched' }
  }

  const current = isObject(servers) ? servers[SERVER_NAME] : undefined

  if (isObject(current) && sameServer(current, server)) {
    return { text: original ?? '', changed: false }
  }

  data.mcpServers = { ...(isObject(servers) ? servers : {}), [SERVER_NAME]: server }

  return { text: serialize(data, bom, indent), changed: true }
}

/**
 * OpenCode V2: `mcp.servers.<name>` with `{ type: "local", command: [...] }`.
 * V2 does not place server names directly under `mcp` (docs, 2026-11-15), so
 * this writer never produces the V1 shape.
 */
function upsertOpenCode(
  original: string | undefined,
  command: string[],
): { text: string; changed: boolean } | { error: string } {
  const source = original ?? '{"$schema":"https://opencode.ai/config.json"}'
  const parsed = parseJsonObject(source)

  if ('error' in parsed) return parsed

  const { data, bom, indent } = parsed
  const mcp = data.mcp

  if (mcp !== undefined && !isObject(mcp)) {
    return { error: '"mcp" is not an object, so this file was left untouched' }
  }

  const servers = isObject(mcp) ? mcp.servers : undefined

  if (servers !== undefined && !isObject(servers)) {
    return { error: '"mcp.servers" is not an object, so this file was left untouched' }
  }

  const wanted = { type: 'local', command }

  if (isObject(servers) && sameServer(servers[SERVER_NAME], wanted)) {
    return { text: source, changed: false }
  }

  data.mcp = {
    ...(isObject(mcp) ? mcp : {}),
    servers: { ...(isObject(servers) ? servers : {}), [SERVER_NAME]: wanted },
  }

  return { text: serialize(data, bom, indent), changed: true }
}

/**
 * Codex CLI: a TOML table. The mechanical part is deliberate — this is not a
 * TOML parser, it only edits the table it owns and leaves every other line,
 * comment and table exactly where it was.
 */
function upsertCodex(
  original: string,
  command: string[],
): { text: string; changed: boolean } | { error: string } {
  const header = `[mcp_servers.${SERVER_NAME}]`
  const body = [`command = ${tomlString(command[0])}`]

  if (command.length > 1) {
    body.push(`args = [${command.slice(1).map(tomlString).join(', ')}]`)
  }

  const lines = original.split('\n')
  const start = lines.findIndex(line => line.trim() === header)

  if (start === -1) {
    const block = [header, ...body].join('\n')
    const text = original === ''
      ? `${block}\n`
      : original.endsWith('\n')
        ? `${original}\n${block}\n`
        : `${original}\n\n${block}\n`

    return { text, changed: true }
  }

  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1

  // Keep any key the operator added to this table; replace only ours.
  const kept = lines.slice(start + 1, end).filter(line => !/^\s*(command|args)\s*=/.test(line))
  const rebuilt = [header, ...body, ...kept]

  // Drop trailing blank lines inside the table so the blank line before the
  // next table survives in one place.
  while (rebuilt.length > body.length + 1 && rebuilt.at(-1)?.trim() === '') rebuilt.pop()

  const existing = lines.slice(start, end).join('\n').replace(/\s+$/, '')
  const wanted = rebuilt.join('\n').replace(/\s+$/, '')

  if (existing === wanted) return { text: original, changed: false }

  const next = [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)].join('\n')

  return { text: next, changed: true }
}

function tomlString(value: string): string {
  // TOML basic strings accept the same escapes as JSON for quotes,
  // backslashes and control characters, which is what a Windows path needs.
  return JSON.stringify(value)
}

interface ParsedJson {
  data: Record<string, unknown>
  bom: boolean
  indent: string
}

function parseJsonObject(original: string | undefined): ParsedJson | { error: string } {
  if (original === undefined || original.trim() === '') {
    return { data: {}, bom: false, indent: '  ' }
  }

  const bom = original.charCodeAt(0) === 0xfeff
  const source = bom ? original.slice(1) : original

  let data: unknown

  try {
    data = JSON.parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      error: `not strict JSON (${message}), so this file was left untouched — run the client's own "mcp add" command`,
    }
  }

  if (!isObject(data)) return { error: 'the file is not a JSON object, so this file was left untouched' }

  return { data, bom, indent: detectIndent(source) }
}

function detectIndent(source: string): string {
  const match = source.match(/\n([ \t]+)"/)

  return match ? match[1] : '  '
}

function serialize(data: Record<string, unknown>, bom: boolean, indent: string): string {
  return `${bom ? '\ufeff' : ''}${JSON.stringify(data, null, indent)}\n`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameServer(current: unknown, wanted: Record<string, unknown>): boolean {
  if (!isObject(current)) return false

  const keys = new Set([...Object.keys(current), ...Object.keys(wanted)])

  for (const key of keys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(wanted[key])) return false
  }

  return true
}

function nextBackupPath(path: string, stamp: string, exists: (path: string) => boolean): string {
  const base = `${path}.wednesday-backup-${stamp}`
  let candidate = base
  let index = 1

  while (exists(candidate)) candidate = `${base}-${index++}`

  return candidate
}

function writeAtomic(path: string, text: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.wednesday-tmp-${process.pid}`)
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
}

export function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('')
}

/** Human receipt. One line per client, the backup on its own indented line. */
export function formatOutcome(outcome: SetupOutcome, stream: 'dry' | 'live'): string {
  const lines: string[] = []
  const headline = stream === 'dry' ? 'wednesday setup — dry run, nothing written' : 'wednesday setup'

  lines.push(headline)
  lines.push('')
  lines.push(`  command   ${outcome.command.join(' ')}`)

  const width = Math.max(...outcome.results.map(result => result.label.length), 12)

  for (const result of outcome.results) {
    const label = result.label.padEnd(width)
    lines.push('')
    lines.push(`  ${label}  ${result.action.padEnd(11)} ${result.path}`)

    if (result.via) lines.push(`  ${' '.repeat(width)}  ${'via'.padEnd(11)} ${result.via}`)
    if (result.backup) lines.push(`  ${' '.repeat(width)}  ${'backup'.padEnd(11)} ${result.backup}`)
    if (result.detail) lines.push(`  ${' '.repeat(width)}  ${'note'.padEnd(11)} ${result.detail}`)
  }

  const { counts } = outcome

  if (outcome.results.length === 0) {
    lines.push('')
    lines.push('  No MCP client found on this machine. Configure one anyway:')
    lines.push('    wednesday setup --all          every known client')
    lines.push('    wednesday setup --client cursor   only Cursor')
  }

  lines.push('')
  lines.push(
    `  ${counts.created + counts['would-create']} new, ` +
    `${counts.updated + counts['would-update']} updated, ` +
    `${counts.unchanged} unchanged, ${counts.skipped} skipped`,
  )
  lines.push('')
  lines.push('  Next: restart the client (or reload its MCP servers), then ask it to run a task.')
  lines.push('  The server is `wednesday-mcp`; seats are never callable from the client.')

  return lines.join('\n')
}

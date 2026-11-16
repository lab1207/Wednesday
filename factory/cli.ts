import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { redactSensitiveText } from './security/redaction'
import type { ClientId } from './setup'

/**
 * Operator CLI — Layer 1 control surface (roadmap 11A + 2026-09-17 addendum).
 *
 * Thin pass-through over the Hermes supervision CLI and FactoryService
 * contracts. No business logic, no second orchestrator: every verb except
 * `watch` forwards to factory/hermes/hermes.ts as a separate process, so the
 * Hermes task store stays the operational source of truth.
 *
 * Human-readable output by default; --json prints Hermes' raw JSON verbatim.
 */

const HERMES = fileURLToPath(new URL('./hermes/hermes.ts', import.meta.url))

const VERBS = new Set([
  'create',
  'status',
  'run',
  'watch',
  'events',
  'result',
  'retry',
  'cancel',
  'list',
  'scan',
  'team',
  'setup',
])

/**
 * `wednesday scan` — the commit-time security gate (2026-11-08, B231).
 *
 * A LOCAL verb, NOT forwarded to Hermes: it reads a git index and prints a
 * report, and the Hermes task store has nothing to do with it. Forwarding
 * would put repository hygiene behind the task queue, which is the wrong
 * dependency for a thing that must run before a commit exists.
 *
 * The parsing and the report live in `factory/scan/scan-command.ts`, so
 * this verb and the operator-facing `wednesday scan` (the bin `npm i -g`
 * actually installs) are the same code.
 *
 *   wednesday scan                  scan the repo you are standing in
 *   wednesday scan --repo DIR       scan another repository
 *   wednesday scan --allow-findings report, then allow
 *   wednesday scan --install-hook   install the gate into the target repo
 */
async function scan(args: string[]): Promise<void> {
  const { runScanCommand } = await import('./scan/scan-command')
  process.exit(runScanCommand(args))
}

/**
 * `wednesday team` — the operator's staffed team, without a terminal app.
 *
 * Choosing which model sits in which seat is the OPERATOR's decision, so it
 * lives here and in the shared state home. The MCP server reads the same
 * store and adopts the active crew at startup; nothing about the team is
 * ever chosen by the calling agent.
 *
 *   wednesday team                       list the crews, active marked
 *   wednesday team use <id|name>         make a crew active
 *   wednesday team add <name> coder=model reviewer=model --shape solo
 *   wednesday team seat <role> <model>   put a different model in one seat
 *   wednesday team set <setting> <value> shape | repairs | tokens | usd | test | files
 *   wednesday team delete <id|name>      remove a crew
 *   wednesday team show                  the active crew in detail
 */
async function team(args: string[]): Promise<void> {
  const store = await import('./teams/crew-store')

  const [verb = 'list', ...rest] = args

  if (verb === 'list') {
    const crews = store.loadCrews()

    if (crews.crews.length === 0) {
      console.log('No crews yet. Add one: wednesday team add <name> coder=<model>')
      return
    }

    for (const crew of crews.crews) {
      const mark = crew.id === crews.active ? '*' : ' '
      const seats = crew.seats.map(seat => `${seat.role}=${seat.model}`).join(' ')
      const shape = crew.policy?.shape ?? 'auto'
      console.log(`${mark} ${crew.id}  ${crew.name}  [${shape}]  ${seats}`)
    }

    return
  }

  if (verb === 'use') {
    const wanted = rest[0]

    if (!wanted) throw new Error('Missing crew id or name: wednesday team use <id|name>')

    const crews = store.loadCrews()
    const crew = crews.crews.find(item => item.id === wanted || item.name === wanted)

    if (!crew) throw new Error(`No such crew: ${wanted}`)

    store.setActiveCrew(crew.id)
    console.log(`active crew: ${crew.name} (${crew.id})`)

    return
  }

  if (verb === 'add') {
    const name = rest[0]

    const shapeAt = rest.indexOf('--shape')
    const shape = shapeAt >= 0 ? rest[shapeAt + 1] : undefined

    // The VALUE after --shape is not a seat. Before this, `--shape solo`
    // reached the parser as a seat named "solo" and the add failed with
    // "A seat must be role=model, got: solo".
    const seats = rest
      .slice(1)
      .map((item, index) => ({ item, index: index + 1 }))
      .filter(({ item, index }) => !item.startsWith('--') && index !== shapeAt + 1)
      .map(({ item }) => item)

    if (!name || seats.length === 0) {
      throw new Error('Usage: wednesday team add <name> role=model [role=model...] [--shape solo|auto|duel|vote|relay]')
    }

    const parsed = seats.map(seat => {
      const at = seat.indexOf('=')

      if (at <= 0) throw new Error(`A seat must be role=model, got: ${seat}`)

      return { role: seat.slice(0, at), model: seat.slice(at + 1) }
    })

    if (shape && !['solo', 'auto', 'duel', 'vote', 'relay'].includes(shape)) {
      throw new Error(`Unknown shape: ${shape}. Use solo, auto, duel, vote or relay.`)
    }

    const crew = store.addCrew(
      name,
      parsed,
      shape ? { shape } : undefined,
    )

    store.setActiveCrew(crew.id)
    console.log(`added and activated: ${crew.name} (${crew.id})`)

    return
  }

  if (verb === 'seat') {
    const [role, model] = rest

    if (!role || !model) {
      throw new Error('Usage: wednesday team seat <role> <model>')
    }

    const crew = store.activeCrew()

    if (!crew) {
      throw new Error('No active crew. Add one: wednesday team add <name> coder=<model>')
    }

    const seats = crew.seats.some(seat => seat.role === role)
      ? crew.seats.map(seat => (seat.role === role ? { ...seat, model } : seat))
      : [...crew.seats, { role, model }]

    store.updateCrew(crew.id, { seats })
    console.log(`${crew.name}: ${role} -> ${model}`)
    console.log('Restart the MCP server (or reconnect your client) to adopt it.')

    return
  }

  if (verb === 'set') {
    const [setting, ...valueParts] = rest
    const value = valueParts.join(' ').trim()

    if (!setting) {
      throw new Error('Usage: wednesday team set <shape|repairs|tokens|usd|test|files> <value>')
    }

    const crew = store.activeCrew()

    if (!crew) {
      throw new Error('No active crew. Add one: wednesday team add <name> coder=<model>')
    }

    const parsed = store.parseTeamSetting(setting, value)

    if (!parsed.ok) throw new Error(parsed.error)

    const policy = { ...(crew.policy ?? {}), ...parsed.patch }
    store.updateCrew(crew.id, { policy })
    console.log(`${crew.name}: ${setting} -> ${value}`)
    console.log('Restart the MCP server (or reconnect your client) to adopt it.')

    return
  }

  if (verb === 'delete' || verb === 'rm') {
    const wanted = rest[0]

    if (!wanted) throw new Error('Missing crew id or name: wednesday team delete <id|name>')

    const crews = store.loadCrews()
    const crew = crews.crews.find(item => item.id === wanted || item.name === wanted)

    if (!crew) throw new Error(`No such crew: ${wanted}`)

    store.deleteCrew(crew.id)
    console.log(`deleted: ${crew.name} (${crew.id})`)

    return
  }

  if (verb === 'show') {
    const crew = store.activeCrew()

    if (!crew) {
      console.log('No active crew. Every seat runs on the route default.')
      return
    }

    console.log(`${crew.name} (${crew.id})`)

    for (const seat of crew.seats) console.log(`  ${seat.role.padEnd(10)} ${seat.model}`)

    for (const line of store.crewPolicyLines(crew.policy)) console.log(`  ${line}`)

    return
  }

  throw new Error(`Unknown team command: ${verb}`)
}

/**
 * `wednesday setup` — register the MCP server with the operator's clients.
 *
 * WHY A LOCAL VERB: registration writes a file on this machine. The Hermes
 * task store has nothing to do with it, and making it a task would put
 * onboarding behind the queue.
 *
 *   wednesday setup                     every detected client
 *   wednesday setup --client cursor     one of them
 *   wednesday setup --all               also create configs for absent clients
 *   wednesday setup --dry-run           print the plan, write nothing
 *   wednesday setup --command "wednesday-mcp"   register a linked bin instead
 */
async function setup(args: string[]): Promise<void> {
  const setupModule = await import('./setup')

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
wednesday setup — connect the MCP server to your client

  wednesday setup                        every client found on this machine
  wednesday setup --client <id>          one client (repeatable or comma-separated)
  wednesday setup --all                  every known client, detected or not
  wednesday setup --dry-run              print the plan, write nothing
  wednesday setup --command "<line>"     the command the client should launch
                                         (default: node <this checkout>/bin/wednesday-mcp.js)

  clients: claude-code | claude-desktop | codex | cursor | opencode

  Every file is backed up before it is touched, and a file that is not
  strict JSON is reported and left alone rather than rewritten.
`)
    return
  }

  const dryRun = args.includes('--dry-run')
  const all = args.includes('--all')
  const clients: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--client') continue

    const value = args[index + 1]

    if (!value) throw new Error('Missing a client after --client')

    clients.push(...value.split(',').map(item => item.trim()).filter(Boolean))
    index += 1
  }

  const known = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'opencode']
  const unknown = clients.filter(client => !known.includes(client))

  if (unknown.length > 0) {
    throw new Error(`Unknown client: ${unknown.join(', ')}. Known: ${known.join(', ')}`)
  }

  const commandAt = args.indexOf('--command')
  const command = commandAt >= 0 ? setupModule.parseCommandLine(args[commandAt + 1] ?? '') : undefined

  if (commandAt >= 0 && (!command || command.length === 0)) {
    throw new Error('Missing a command after --command')
  }

  const outcome = setupModule.runSetup({
    command: command ?? setupModule.defaultCommand(),
    clients: clients.length > 0 ? clients as ClientId[] : undefined,
    all,
    dryRun,
  })

  const json = process.argv.includes('--json')

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      command: outcome.command,
      counts: outcome.counts,
      results: outcome.results,
    }, null, 2))
    return
  }

  console.log(setupModule.formatOutcome(outcome, dryRun ? 'dry' : 'live'))
}

/**
 * The tsx ESM loader as an absolute file URL (2026-11-15).
 *
 * WHY: `bin/wednesday.js` is plain JavaScript and loads this file through
 * `tsImport`, but every Hermes verb runs in a CHILD process. In a normal
 * `wednesday create` `process.execArgv` is empty, so the child was a bare
 * `node hermes.ts` and died on its first extensionless import
 * (`ERR_MODULE_NOT_FOUND: .../factory/security/redaction`). The tests never
 * saw it because they run under `node --import tsx`, which the child then
 * inherited. `--import tsx` also only resolves when the cwd is the checkout,
 * and a client spawns the server from anywhere, so the child gets the loader
 * by absolute URL.
 */
const TSX_LOADER = (() => {
  try {
    return import.meta.resolve('tsx')
  } catch {
    return undefined
  }
})()

function spawnHermes(verb: string, args: string[], timeoutMs: number) {
  const execArgv = [...process.execArgv]
  const hasTsxLoader = execArgv.some((arg, index) =>
    ((arg === '--import' || arg === '--loader') && /tsx/.test(execArgv[index + 1] ?? '')) ||
    /^--(import|loader)=.*tsx/.test(arg),
  )

  if (!hasTsxLoader && TSX_LOADER) execArgv.push('--import', TSX_LOADER)

  return spawnSync(process.execPath, [...execArgv, HERMES, verb, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
  })
}

function hermesJson(verb: string, args: string[], timeoutMs = 30000): Record<string, unknown> {
  const child = spawnHermes(verb, args, timeoutMs)
  if (child.status !== 0) {
    const detail = (child.stderr || child.stdout || '').trim()
    try {
      const parsed = JSON.parse(detail) as { error?: string }
      if (parsed.error) throw new Error(parsed.error)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`hermes ${verb} failed: ${detail}`)
      throw error
    }
  }
  return JSON.parse(child.stdout) as Record<string, unknown>
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(human(value))
}

function human(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  const record = value as Record<string, unknown>
  const body = (record.result && typeof record.result === 'object' ? record.result : record) as Record<string, unknown>
  if (typeof body.summary === 'string' && body.taskId) {
    const lines = [`result: ${body.status} — ${body.summary}`]
    const files = body.filesChanged as string[] | undefined
    if (Array.isArray(files) && files.length > 0) lines.push(`files: ${files.join(', ')}`)
    const tests = body.tests as Array<{ command: string; passed: boolean }> | undefined
    if (Array.isArray(tests)) {
      for (const test of tests) lines.push(`test ${test.passed ? 'PASS' : 'FAIL'}: ${test.command}`)
    }
    return lines.join('\n')
  }
  return JSON.stringify(value, null, 2)
}

async function watch(args: string[], json: boolean): Promise<void> {
  const idIndex = args.indexOf('--id')
  const taskId = idIndex >= 0 ? args[idIndex + 1] : undefined
  if (!taskId) throw new Error('Missing --id')

  const timeoutIndex = args.indexOf('--timeout')
  const timeoutSeconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 900
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('Invalid --timeout')

  const deadline = Date.now() + timeoutSeconds * 1000
  const seen = new Set<string>()
  let last: Record<string, unknown> | undefined
  let previous: string | undefined

  while (true) {
    last = hermesJson('status', ['--id', taskId])
    const status = String(last.status)
    if (!seen.has(status)) {
      seen.add(status)
      if (!json) console.log(`[${new Date().toISOString()}] ${status}`)
    }
    // Terminal status ends the watch; a repeated non-terminal status means
    // the task has settled (e.g. queued with no runner attached) — report it.
    if (['completed', 'failed', 'cancelled'].includes(status) || status === previous) break
    previous = status
    if (Date.now() > deadline) throw new Error(`watch timed out after ${timeoutSeconds}s in status ${status}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  print(hermesJson('status', ['--id', taskId]), json)
}

function usage(): never {
  console.log(`
factory — operator CLI over the Hermes/Factory contracts (roadmap 11A)

  create --objective "..." [--workspace dir] [--id id] [--role role] [--stack stack]
         [--tests "cmd1|cmd2"] [--acceptance "c1|c2"] [--required-files "f1|f2"]

  status --id <taskId>
  run    --id <taskId>
  watch  --id <taskId> [--timeout seconds]
  events --id <taskId>
  result --id <taskId>
  retry  --id <taskId>
  cancel --id <taskId>
  list   [--status queued|running|completed|failed|cancelled]
  scan   [--repo DIR] [--allow-findings] [--install-hook]

  team                       list the crews (active marked)
  team use <id|name>         make a crew active
  team add <name> role=model [role=model...] [--shape solo|auto|duel|vote|relay]
  team seat <role> <model>  put a different model in one seat of the active crew
  team set <setting> <value> shape | repairs | tokens | usd | test | files
  team delete <id|name>     remove a crew
  team show                  the active crew in detail

  setup [--client id] [--all] [--dry-run] [--command "<line>"]
                            register the MCP server with your client

Add --json to any command for machine-readable output (raw Hermes JSON).
Config: HERMES_TASKS_PATH, FACTORY_EVENTS_PATH, FACTORY_EXECUTION_MODE.
The MCP server adopts the active crew at startup: connect any MCP client to it.
`)
  process.exit(0)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const verb = argv[0]
  if (!verb || verb === '--help' || verb === 'help') usage()
  if (!VERBS.has(verb)) throw new Error(`Unknown command: ${verb}`)

  const json = argv.includes('--json')
  const rest = argv.slice(1).filter(name => name !== '--json')

  if (verb === 'watch') {
    await watch(rest, json)
    return
  }

  if (verb === 'scan') {
    await scan(rest)
    return
  }

  if (verb === 'team') {
    await team(rest)
    return
  }

  if (verb === 'setup') {
    await setup(rest)
    return
  }

  const hermesVerb = verb === 'create' ? 'submit' : verb

  // The operator's active crew drives the seats for a CLI run too
  // (2026-11-15). Before this, only the MCP server called `applyCrew`, so
  // `wednesday run` silently used the profile's route default and the team
  // the operator staffed never sat down. `applyCrew` writes the same
  // FACTORY_CREW_<SEAT>_MODEL slots the MCP server writes, and spawnHermes
  // passes this process's env to the child, so both surfaces now route
  // through the same seats.
  if (verb === 'create' || verb === 'run') {
    const { activeCrew, applyCrew } = await import('./teams/crew-store')
    const crew = activeCrew()
    if (crew) applyCrew(crew)
  }

  print(hermesJson(hermesVerb, rest, verb === 'run' ? 30 * 60 * 1000 : 30000), json)
}

main().catch((error: unknown) => {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
  console.error(process.argv.includes('--json') ? JSON.stringify({ ok: false, error: message }, null, 2) : `error: ${message}`)
  process.exitCode = 1
}).finally(() => {
  process.exit(process.exitCode ?? 0)
})

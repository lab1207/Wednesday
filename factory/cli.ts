import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { redactSensitiveText } from './security/redaction'

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
])

/**
 * `wednesday scan` — the commit-time security gate (2026-11-08, B231).
 *
 * A LOCAL verb, NOT forwarded to Hermes: it reads a git index and prints a
 * report, and the Hermes task store has nothing to do with it. Forwarding
 * would put repository hygiene behind the task queue, which is the wrong
 * dependency for a thing that must run before a commit exists.
 *
 * The parsing and the report live in `factory/harness/scan-command.ts`, so
 * this verb and the operator-facing `wednesday scan` (the harness bin, which
 * is what `npm i -g` actually installs) are the same code.
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
 *   wednesday team                     list the crews, active marked
 *   wednesday team use <id|name>       make a crew active
 *   wednesday team add <name> coder=model reviewer=model --shape solo
 *   wednesday team show                the active crew in detail
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
    const seats = rest.slice(1).filter(item => !item.startsWith('--'))

    if (!name || seats.length === 0) {
      throw new Error('Usage: wednesday team add <name> role=model [role=model...] [--shape solo|auto|duel|vote|relay]')
    }

    const parsed = seats.map(seat => {
      const at = seat.indexOf('=')

      if (at <= 0) throw new Error(`A seat must be role=model, got: ${seat}`)

      return { role: seat.slice(0, at), model: seat.slice(at + 1) }
    })

    const shapeAt = rest.indexOf('--shape')
    const shape = shapeAt >= 0 ? rest[shapeAt + 1] : undefined

    const crew = store.addCrew(
      name,
      parsed,
      shape ? { shape } : undefined,
    )

    store.setActiveCrew(crew.id)
    console.log(`added and activated: ${crew.name} (${crew.id})`)

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

function spawnHermes(verb: string, args: string[], timeoutMs: number) {
  return spawnSync(process.execPath, [...process.execArgv, HERMES, verb, ...args], {
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

  team                      list the crews (active marked)
  team use <id|name>        make a crew active
  team add <name> role=model [role=model...] [--shape solo|auto|duel|vote|relay]
  team show                 the active crew in detail

Add --json to any command for machine-readable output (raw Hermes JSON).
Config: HERMES_TASKS_PATH, FACTORY_EVENTS_PATH, FACTORY_EXECUTION_MODE.
The MCP server adopts the active crew at startup: connect any harness to it.
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

  const hermesVerb = verb === 'create' ? 'submit' : verb
  print(hermesJson(hermesVerb, rest, verb === 'run' ? 30 * 60 * 1000 : 30000), json)
}

main().catch((error: unknown) => {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
  console.error(process.argv.includes('--json') ? JSON.stringify({ ok: false, error: message }, null, 2) : `error: ${message}`)
  process.exitCode = 1
}).finally(() => {
  process.exit(process.exitCode ?? 0)
})

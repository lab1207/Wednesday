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

const VERBS = new Set(['create', 'status', 'run', 'watch', 'events', 'result', 'retry', 'cancel', 'list'])

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

Add --json to any command for machine-readable output (raw Hermes JSON).
Config: HERMES_TASKS_PATH, FACTORY_EVENTS_PATH, FACTORY_EXECUTION_MODE.
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

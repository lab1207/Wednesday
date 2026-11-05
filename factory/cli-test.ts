import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Operator CLI test (roadmap 11A + 2026-09-17 addendum).
 *
 * Verbs create | status | run | watch | events | result | retry | cancel | list, exercised
 * through separate CLI processes against a temp Hermes task store and event
 * log, deterministic execution, no model calls. Both --json and human output
 * are covered.
 */

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'factory-cli-'))
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
  const artifact = 'cli-proof.txt'

  /** Tokenize an arg line honoring double quotes, so test commands survive. */
  function tokens(args: string): string[] {
    const matches = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
    return matches.map(token => token.replace(/"/g, ''))
  }

  function command(args: string, timeoutMs = 30000) {
    return spawnSync(process.execPath, [...process.execArgv, cli, ...tokens(args)], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_TASKS_PATH: join(directory, 'tasks.json'),
        FACTORY_EVENTS_PATH: join(directory, 'events.jsonl'),
        FACTORY_EXECUTION_MODE: 'deterministic',
      },
    })
  }

  function json(args: string, timeoutMs?: number): Record<string, unknown> {
    const child = command(`${args} --json`, timeoutMs)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    return JSON.parse(child.stdout)
  }

  function text(args: string, timeoutMs?: number): string {
    const child = command(args, timeoutMs)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    return child.stdout
  }

  try {
    // create → queued (JSON and human forms)
    const created = json(`create --id cli-001 --workspace ${directory} --objective "Create ${artifact} containing exactly FACTORY_CLI_OK." --tests "cmd /c if not exist ${join(directory, artifact)} exit 1" --required-files ${artifact}`)
    assert.equal(created.ok, true)
    assert.equal(created.taskId, 'cli-001')
    assert.equal(created.status, 'queued')
    const createdHuman = text(`create --id cli-002 --workspace ${directory} --objective warmup`)
    assert.match(createdHuman, /"taskId": "cli-002"/)

    // status → queued, both forms
    const status = json('status --id cli-001')
    assert.equal(status.status, 'queued')
    assert.match(text('status --id cli-001'), /queued/)

    // run → completed with real artifact from the deterministic executor
    const run = json('run --id cli-001', 5 * 60 * 1000)
    assert.equal(run.ok, true)
    assert.equal(run.status, 'completed')

    // result → stored result, human form prints the summary line
    const result = json('result --id cli-001')
    assert.equal(result.taskId, 'cli-001')
    assert.equal(result.status, 'completed')
    const resultBody = result.result as Record<string, unknown>
    assert.equal(resultBody.summary, 'Deterministic Factory execution, verification, and acceptance completed.')
    const resultHuman = text('result --id cli-001')
    assert.match(resultHuman, /result: completed — Deterministic Factory execution/)
    assert.match(resultHuman, /test PASS/)

    // events → 14 shared Factory events ending task.completed
    const events = json('events --id cli-001')
    assert.equal(events.eventCount, 14)
    const list = events.events as Array<{ type: string }>
    assert.equal(list[0].type, 'task.created')
    assert.equal(list.at(-1)?.type, 'task.completed')
    assert.ok(list.some(event => event.type === 'tool.called'))

    // watch → returns the terminal status and final status object
    const watchHuman = text('watch --id cli-001 --timeout 30')
    assert.match(watchHuman, /\[.*\] completed/)
    assert.match(watchHuman, /"status": "completed"/)
    const watchJson = json('watch --id cli-001 --timeout 30')
    assert.equal(watchJson.status, 'completed')
    assert.match(text('watch --id cli-002 --timeout 30'), /queued[\s\S]*"status": "queued"/s)

    // list → both tasks visible, --status filter works
    const listed = json('list')
    assert.equal(listed.ok, true)
    assert.equal(listed.count, 2)
    const listedQueued = json('list --status queued')
    assert.equal(listedQueued.count, 1)
    assert.equal((listedQueued.tasks as Array<{ id: string }>)[0].id, 'cli-002')
    const listedDone = json('list --status completed')
    assert.equal(listedDone.count, 1)

    // cancel → queued task flips to cancelled through the CLI
    const cancelled = json('cancel --id cli-002')
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(json('status --id cli-002').status, 'cancelled')
    assert.equal(json('list --status cancelled').count, 1)

    // retry guard → failed-only rule surfaces through the CLI
    const rejected = command('retry --id cli-001 --json')
    assert.equal(rejected.status, 1)
    assert.equal((JSON.parse(rejected.stderr) as { error: string }).error,
      'Only failed tasks can be retried. Current status: completed')

    // unknown verb → usage error, not a crash
    assert.equal(command('frobnicate').status, 1)
    assert.equal(command('--help').status, 0)

    console.log('FACTORY OPERATOR CLI TEST: PASS (create/status/run/watch/events/result/retry/cancel/list, json+human)')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

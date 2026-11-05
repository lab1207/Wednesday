import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-supervision-'))
  const tasksPath = join(directory, 'tasks.json')
  const eventsPath = join(directory, 'events.jsonl')
  const cli = fileURLToPath(new URL('./hermes.ts', import.meta.url))
  const taskId = 'hermes-v13-supervision'
  const artifact = 'hermes-v13-supervision-proof.txt'

  function command(...args: string[]) {
    const child = spawnSync(process.execPath, [...process.execArgv, cli, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_TASKS_PATH: tasksPath,
        FACTORY_EVENTS_PATH: eventsPath,
        FACTORY_EXECUTION_MODE: 'deterministic',
      },
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    return JSON.parse(child.stdout)
  }

  try {
    const submitted = command('submit', '--id', taskId, '--workspace', directory,
      '--objective', `Create ${artifact} containing exactly HERMES_V13_SUPERVISION_OK.`,
      '--tests', `cmd /c if not exist ${artifact} exit 1`,
      '--required-files', artifact)
    assert.equal(submitted.ok, true)
    assert.equal(submitted.status, 'queued')
    assert.equal(submitted.taskId, taskId)

    const run = command('run', '--id', taskId)
    assert.equal(run.ok, true)
    assert.equal(run.status, 'completed')
    assert.equal(run.result.status, 'completed')
    assert.equal(run.result.taskId, taskId)
    assert.equal(await readFile(join(directory, artifact), 'utf8'),
      'HERMES_V13_SUPERVISION_OK\n', 'Factory must create the artifact, not the test')

    const beforeStatus = await readFile(tasksPath, 'utf8')
    const store = JSON.parse(beforeStatus)
    assert.equal(store.tasks.length, 1)
    assert.equal(store.tasks[0].status, 'completed')
    assert.deepEqual(store.tasks[0].result, run.result)

    const status = command('status', '--id', taskId)
    const history = command('events', '--id', taskId)
    const persistedEvents = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(status.status, 'completed')
    assert.equal(status.supervisedBy, 'hermes-cli')
    assert.equal(status.lastEvent.type, 'task.completed')
    assert.equal(history.taskId, taskId)
    assert.equal(history.supervisedBy, 'hermes-cli')
    assert.equal(status.eventCount, 14)
    assert.equal(history.eventCount, 14)
    assert.deepEqual(history.events, persistedEvents, 'CLI must expose the same persisted Factory events')
    assert.ok(history.events.every((event: { taskId: string }) => event.taskId === taskId))
    assert.equal(history.events[0].type, 'task.created')
    assert.equal(history.events.at(-1).type, 'task.completed')
    assert.ok(history.events.some((event: { type: string; payload?: { tool?: string; passed?: boolean } }) =>
      event.type === 'tool.called' && event.payload?.tool === 'verification.test' && event.payload.passed === true))
    assert.equal(await readFile(tasksPath, 'utf8'), beforeStatus, 'Observation must not mutate task state')
    console.log('HERMES V1.3 SUPERVISION TEST: PASS (completed, artifact verified, 14 persisted events)')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-persistence-'))
  const tasksPath = join(directory, 'tasks.json')
  const eventsPath = join(directory, 'events.jsonl')
  const cli = fileURLToPath(new URL('./hermes.ts', import.meta.url))

  function command(...args: string[]) {
    const child = spawnSync(process.execPath, [...process.execArgv, cli, ...args], {
      encoding: 'utf8',
      timeout: 15000,
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
    for (const id of ['persistence-first', 'persistence-second']) {
      const submitted = command('submit', '--id', id, '--objective', `Persist ${id}`,
        '--workspace', directory)
      assert.equal(submitted.ok, true)
      assert.equal(submitted.taskId, id)
      assert.equal(submitted.status, 'queued')
    }

    const beforeStatus = await readFile(tasksPath, 'utf8')
    const store = JSON.parse(beforeStatus)
    assert.equal(store.tasks.length, 2, 'Second submit must preserve the first task')
    for (const record of store.tasks) {
      assert.equal(record.status, 'queued')
      assert.equal(record.engineeringTask.id, record.id)
      assert.equal(record.engineeringTask.objective, `Persist ${record.id}`)
      assert.equal(record.engineeringTask.workspace, directory)
      assert.equal(record.supervisor, 'hermes-cli')
      assert.ok(Number.isFinite(Date.parse(record.createdAt)))
      const status = command('status', '--id', record.id)
      assert.equal(status.taskId, record.id)
      assert.equal(status.status, 'queued')
      assert.equal(status.supervisedBy, 'hermes-cli')
      assert.equal(status.createdAt, record.createdAt)
      assert.equal(status.eventCount, 0)
    }
    assert.equal(await readFile(tasksPath, 'utf8'), beforeStatus,
      'Status must not change the task store')

    // Live-observed 2026-09-21: duplicate ids make find-first lookups
    // execute stale workspaces. Re-submit must refuse loudly instead.
    const dup = spawnSync(process.execPath, [...process.execArgv, cli,
      'submit', '--id', 'persistence-first', '--objective', 'duplicate',
      '--workspace', directory], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_TASKS_PATH: tasksPath,
        FACTORY_EVENTS_PATH: eventsPath,
        FACTORY_EXECUTION_MODE: 'deterministic',
      },
    })
    assert.ifError(dup.error)
    assert.notEqual(dup.status, 0, 'duplicate submit must fail')
    const dupBody = JSON.parse(dup.stderr || dup.stdout)
    assert.equal(dupBody.ok, false)
    assert.ok(String(dupBody.error).includes('already exists'), 'refusal must name the cause')
    const afterDup = JSON.parse(await readFile(tasksPath, 'utf8'))
    assert.equal(afterDup.tasks.length, 2, 'refused submit must not touch the store')

    // Missing workspace refuses loudly instead of running nowhere.
    const badWs = spawnSync(process.execPath, [...process.execArgv, cli,
      'submit', '--id', 'bad-ws', '--objective', 'nowhere',
      '--workspace', join(directory, 'no-such-dir')], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_TASKS_PATH: tasksPath,
        FACTORY_EVENTS_PATH: eventsPath,
        FACTORY_EXECUTION_MODE: 'deterministic',
      },
    })
    assert.ifError(badWs.error)
    assert.notEqual(badWs.status, 0, 'missing-workspace submit must fail')
    assert.ok(
      String(JSON.parse(badWs.stderr || badWs.stdout).error).includes('workspace'),
      'refusal must name the workspace',
    )

    console.log('HERMES PERSISTENCE TEST: PASS')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

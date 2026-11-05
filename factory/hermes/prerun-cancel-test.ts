import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// V1.7 hardening — pre-run cancellation.
// A cancel requested while the task is still queued must take effect WITHOUT
// executing the Factory (previously the flag was reset and the run proceeded).
// Run: npx tsx factory/hermes/prerun-cancel-test.ts

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-prerun-cancel-'))
  const tasksPath = join(directory, 'tasks.json')
  const eventsPath = join(directory, 'events.jsonl')

  process.env.HERMES_TASKS_PATH = tasksPath
  process.env.FACTORY_EVENTS_PATH = eventsPath
  process.env.FACTORY_EXECUTION_MODE = 'deterministic'

  const { submitTask, runHermesTask, loadStore, saveStore } = await import('./store')

  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })

  try {
    // Case 1: cancel arrives between submit and run (flag set, still queued).
    const cancelledId = await submitTask({
      task: {
        id: 'prerun-cancel-001',
        workspace,
        objective: 'This task must never execute.',
        role: 'backend',
        stack: 'node',
        constraints: [],
        acceptanceCriteria: [],
      },
    })

    const store = await loadStore()
    const record = store.tasks.find((item) => item.id === cancelledId)
    assert.ok(record, 'submitted task must be stored')
    assert.equal(record.status, 'queued')
    record.cancelRequested = true
    await saveStore(store)

    const cancelled = await runHermesTask(cancelledId)
    assert.equal(cancelled.status, 'cancelled', 'pre-run cancel must win without executing')
    assert.match(String(cancelled.message ?? ''), /before the run started/)
    console.log('pre-run cancel honored without executing: ok')

    const after = await loadStore()
    const afterRecord = after.tasks.find((item) => item.id === cancelledId)
    assert.equal(afterRecord?.status, 'cancelled')
    assert.equal(afterRecord?.result, undefined, 'Factory must not have executed: no result recorded')

    // Case 2 (control): a normal queued task still runs through the Factory.
    const normalId = await submitTask({
      task: {
        id: 'prerun-cancel-002',
        workspace,
        objective: 'Create control.txt containing exactly PRERUN_CONTROL_OK.',
        role: 'backend',
        stack: 'node',
        constraints: [],
        acceptanceCriteria: ['control.txt exists'],
        acceptance: { requiredFiles: ['control.txt'] },
        verification: { setupCommands: [], testCommands: [] },
      },
    })
    const normal = await runHermesTask(normalId)
    if (normal.status !== 'completed') {
      console.log('control result: ' + JSON.stringify(normal.result, null, 2).slice(0, 3000))
    }
    assert.equal(normal.status, 'completed', 'unflagged task must still execute')
    assert.ok(normal.result !== undefined, 'executed task must record a result')

    console.log('HERMES PRE-RUN CANCEL TEST: PASS')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  // createFactoryService() holds a cordis Context that keeps the event loop
  // alive (same reason run-benchmark.ts exits explicitly at the CLI
  // boundary); exit explicitly so the test terminates.
  process.exit(0)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

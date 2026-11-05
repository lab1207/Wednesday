import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * V1.3 Check 3 — Cancel / Retry coherence.
 *
 * Proves that Hermes `cancel` (queued → cancelled) and `retry`
 * (failed → queued, result cleared) behave as real lifecycle transitions.
 *
 * Pattern: temp HERMES_TASKS_PATH + FACTORY_EVENTS_PATH, separate CLI
 * processes, no model calls — same approach as persistence-test.ts.
 */

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-cancel-retry-'))
  const tasksPath = join(directory, 'tasks.json')
  const eventsPath = join(directory, 'events.jsonl')
  const cli = fileURLToPath(new URL('./hermes.ts', import.meta.url))

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

  /** Run a command that we expect to exit non-zero (retry guards). */
  function commandExpectError(...args: string[]) {
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
    assert.equal(child.status, 1, child.stderr || child.stdout)
    const error = JSON.parse(child.stderr)
    assert.equal(error.ok, false)
    assert.match(error.error, /^Only failed tasks can be retried\. Current status: (queued|cancelled)$/)
    return { stdout: child.stdout, stderr: child.stderr, status: child.status }
  }

  async function readStore() {
    const raw = await readFile(tasksPath, 'utf8')
    return JSON.parse(raw)
  }

  try {
    // ================================================================
    // CANCEL PATH — queued → cancelled
    // ================================================================

    // 1. Submit a task (status = queued)
    const submitted = command('submit', '--id', 'cancel-001', '--objective', 'Cancel coherence', '--workspace', directory)
    assert.equal(submitted.ok, true)
    assert.equal(submitted.taskId, 'cancel-001')
    assert.equal(submitted.status, 'queued')

    // 2. Cancel it → queued → cancelled
    const cancelled = command('cancel', '--id', 'cancel-001')
    assert.equal(cancelled.ok, true, 'Cancel must return ok')
    assert.equal(cancelled.status, 'cancelled', 'Status must be cancelled')
    assert.equal(cancelled.cancelRequested, true, 'cancelRequested must be true')

    // 3. Persist check: read store file directly
    const store1 = await readStore()
    const rec1 = store1.tasks.find((t: any) => t.id === 'cancel-001')
    assert.ok(rec1, 'Cancelled task must exist in store')
    assert.equal(rec1.status, 'cancelled', 'Persisted status must be cancelled')
    assert.equal(rec1.cancelRequested, true, 'Persisted cancelRequested must be true')

    // 4. Status reflects cancelled
    const status1 = command('status', '--id', 'cancel-001')
    assert.equal(status1.status, 'cancelled')

    // 5. Cancel again → terminal guard (still exits 0, no crash)
    const cancelAgain = command('cancel', '--id', 'cancel-001')
    assert.equal(cancelAgain.ok, true)
    assert.equal(cancelAgain.status, 'cancelled')
    assert.equal(cancelAgain.message, 'Task is already terminal.')

    // 6. Run cancelled task → terminal guard
    const runCancelled = command('run', '--id', 'cancel-001')
    assert.equal(runCancelled.ok, true)
    assert.equal(runCancelled.status, 'cancelled')
    assert.equal(runCancelled.message, 'Task is already terminal.')

    // 7. Retry cancelled → must error (only failed tasks can be retried)
    const retryCancelled = commandExpectError('retry', '--id', 'cancel-001')
    assert.notEqual(retryCancelled.status, 0, 'Retry on cancelled must exit non-zero')

    // 8. Submit a second task, cancel it, verify independent of first
    command('submit', '--id', 'cancel-002', '--objective', 'Independent cancel', '--workspace', directory)
    const cancelled2 = command('cancel', '--id', 'cancel-002')
    assert.equal(cancelled2.status, 'cancelled')
    // First task still cancelled
    const status1b = command('status', '--id', 'cancel-001')
    assert.equal(status1b.status, 'cancelled', 'cancel-002 must not affect cancel-001')

    console.log('CANCEL COHERENCE: PASS')

    // ================================================================
    // RETRY PATH — failed → queued (result cleared)
    // ================================================================

    // 9. Submit a task with a failing test command so run ends in failed
    const retrySubmitted = command(
      'submit', '--id', 'retry-001',
      '--objective', 'Retry coherence',
      '--workspace', directory,
      '--tests', 'cmd /c exit 1',
      '--acceptance', 'nonexistent.txt exists.',
      '--required-files', 'nonexistent.txt',
    )
    assert.equal(retrySubmitted.ok, true)
    assert.equal(retrySubmitted.status, 'queued')

    // 10. Retry on queued → must error (only failed can retry)
    const retryQueued = commandExpectError('retry', '--id', 'retry-001')
    assert.notEqual(retryQueued.status, 0, 'Retry on queued must exit non-zero')

    // 11. Run the task — deterministic mode, failing tests → status = failed
    const runResult = command('run', '--id', 'retry-001')
    assert.equal(runResult.ok, true, 'Run must complete')
    // In deterministic mode with a failing test, the orchestrator exhausts
    // its repair loop (max 3) and the task ends failed.
    const retryStatus = command('status', '--id', 'retry-001')
    assert.equal(retryStatus.status, 'failed', 'Task must be failed after exhausting repair loop')

    // 12. Store the pre-retry result to verify it gets cleared
    const store2 = await readStore()
    const rec2 = store2.tasks.find((t: any) => t.id === 'retry-001')
    assert.ok(rec2, 'Failed task must exist in store')
    assert.ok(rec2.result !== undefined, 'Failed task must have a result')

    // 13. Retry → failed → queued, result cleared
    const retried = command('retry', '--id', 'retry-001')
    assert.equal(retried.ok, true, 'Retry must return ok')
    assert.equal(retried.status, 'queued', 'Status must be queued after retry')

    // 14. Persist check: result cleared, cancelRequested cleared
    const store3 = await readStore()
    const rec3 = store3.tasks.find((t: any) => t.id === 'retry-001')
    assert.ok(rec3, 'Retried task must exist in store')
    assert.equal(rec3.status, 'queued', 'Persisted status must be queued')
    assert.equal(rec3.result, undefined, 'Result must be cleared after retry')
    assert.equal(rec3.cancelRequested, false, 'cancelRequested must be cleared after retry')
    assert.ok(Number.isFinite(Date.parse(rec3.updatedAt)), 'updatedAt must be refreshed')

    // 15. Status reflects queued
    const statusAfterRetry = command('status', '--id', 'retry-001')
    assert.equal(statusAfterRetry.status, 'queued')

    // 16. Retry again → must error (status is queued, not failed)
    const retryAgain = commandExpectError('retry', '--id', 'retry-001')
    assert.notEqual(retryAgain.status, 0, 'Retry on queued (after retry) must exit non-zero')

    // 17. Submit another task that fails, retry it, verify independence
    command(
      'submit', '--id', 'retry-002',
      '--objective', 'Independent retry',
      '--workspace', directory,
      '--tests', 'cmd /c exit 1',
      '--acceptance', 'nope.txt exists.',
      '--required-files', 'nope.txt',
    )
    command('run', '--id', 'retry-002')
    const retry2Status = command('status', '--id', 'retry-002')
    assert.equal(retry2Status.status, 'failed', 'retry-002 must be failed')

    const retried2 = command('retry', '--id', 'retry-002')
    assert.equal(retried2.status, 'queued')

    // First retry target still queued (independent)
    const stillQueued = command('status', '--id', 'retry-001')
    assert.equal(stillQueued.status, 'queued', 'retry-001 must still be queued')

    console.log('RETRY COHERENCE: PASS')

    // ================================================================
    // CANCEL BEFORE RUN (terminal guard only; no active-run cancellation proof)
    // ================================================================

    // 18. Cancel before dispatch: run must preserve the terminal state.
    command(
      'submit', '--id', 'cancel-run-001',
      '--objective', 'Cancel-during-run coherence',
      '--workspace', directory,
      '--tests', 'cmd /c exit 0',
      '--acceptance', 'ok.txt exists.',
    )

    // This does not exercise the post-run cancelRequested check or interrupt execution.

    // Verify the flag path exists: submit → cancel → store shows flag
    const store4 = await readStore()
    const rec4 = store4.tasks.find((t: any) => t.id === 'cancel-run-001')
    // cancel-run-001 is still queued at this point (not cancelled yet)
    assert.equal(rec4.status, 'queued')

    // Cancel it
    command('cancel', '--id', 'cancel-run-001')
    const store5 = await readStore()
    const rec5 = store5.tasks.find((t: any) => t.id === 'cancel-run-001')
    assert.equal(rec5.cancelRequested, true, 'cancelRequested must be set after cancel')
    assert.equal(rec5.status, 'cancelled')

    // Run returns early (terminal)
    const runCancelled2 = command('run', '--id', 'cancel-run-001')
    assert.equal(runCancelled2.status, 'cancelled')
    assert.equal(runCancelled2.message, 'Task is already terminal.')

    console.log('CANCEL-BEFORE-RUN GUARD: PASS')

    console.log('\nHERMES CANCEL/RETRY TEST: PASS')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

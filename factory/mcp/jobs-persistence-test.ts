/**
 * Proves MCP job ids survive a server restart (2026-11-17).
 *
 * The job registry used to live only in process memory, so an MCP server
 * restart orphaned every job id a client still held. This test spawns fresh node
 * processes against one state home - each spawn IS a server restart - and
 * checks three things:
 *
 *   1. a run submitted in process A is persisted to jobs.json at its
 *      terminal state;
 *   2. process B (the restart) loads it back verbatim, so
 *      status/wait/result keep answering;
 *   3. a job that was queued/running when the process died comes back as
 *      `failed` with a re-submit pointer - never dropped, never polled
 *      forever - and a corrupt registry file boots empty instead of crashing.
 *
 * Like server-test.ts, every child gets an isolated state home and the
 * deterministic execution mode, so nothing touches the operator's real
 * ~/.wednesday or the network.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const JOBS_MODULE = fileURLToPath(new URL('./jobs.ts', import.meta.url))

const PROBE = `
import { pathToFileURL } from 'node:url'

const jobs = await import(pathToFileURL(process.env.PROBE_JOBS_MODULE).href)
await jobs.initJobs()

const mode = process.argv[2] ?? 'report'

if (mode === 'submit') {
  const job = await jobs.submitRun({
    request: 'deterministic probe run: write probe.txt containing ok',
    workspace: process.env.PROBE_WORKSPACE,
  })
  let outcome = await jobs.waitForJob(job.id, 60_000)
  while (outcome && !outcome.done) {
    outcome = await jobs.waitForJob(job.id, 60_000)
  }
  console.log(JSON.stringify({ submitted: jobs.getJob(job.id) }))
} else if (mode === 'report') {
  console.log(JSON.stringify({ jobs: jobs.listJobs() }))
} else if (mode === 'interrogate') {
  const id = process.env.PROBE_JOB_ID
  const view = await jobs.jobView(id)
  const wait = await jobs.waitForJob(id, 1_000)
  const cancel = jobs.cancelJob(id)
  console.log(JSON.stringify({
    view,
    waitDone: wait ? wait.done : null,
    cancelState: cancel ? cancel.state : null,
    missing: jobs.getJob('run-does-not-exist') ?? null,
  }))
}
`

interface ProbeOutput {
  submitted?: { id: string; state: string; result?: unknown }
  jobs?: Array<{ id: string; state: string; error?: string; result?: unknown }>
  view?: { id: string; state: string; done: boolean; error?: string } | null
  waitDone?: boolean | null
  cancelState?: string | null
  missing?: unknown
}

function runProbe(
  home: string,
  mode: string,
  extra: Record<string, string> = {},
): Promise<ProbeOutput> {
  const env = {
    ...process.env,
    WEDNESDAY_STATE_HOME: join(home, 'state'),
    WEDNESDAY_JOBS_PATH: join(home, 'jobs.json'),
    FACTORY_EVENTS_PATH: join(home, 'events.jsonl'),
    WEDNESDAY_SKILLS_HOME: join(home, 'skills'),
    FACTORY_EXECUTION_MODE: 'deterministic',
    PROBE_JOBS_MODULE: JOBS_MODULE,
    PROBE_WORKSPACE: home,
    ...extra,
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(home, 'probe.ts'), mode],
      { env },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(
        new Error(`probe ${mode} timed out. stderr: ${stderr.slice(-500)}`),
      )
    }, 120_000)

    child.on('close', code => {
      clearTimeout(timer)

      if (code !== 0) {
        rejectPromise(
          new Error(
            `probe ${mode} exited ${code}. stderr: ${stderr.slice(-800)}`,
          ),
        )
        return
      }

      try {
        resolvePromise(JSON.parse(stdout.trim()) as ProbeOutput)
      } catch (error) {
        rejectPromise(
          new Error(
            `probe ${mode} stdout was not JSON (${error}): ${stdout.slice(0, 300)}`,
          ),
        )
      }
    })
  })
}

async function makeHome(root: string, name: string): Promise<string> {
  const home = join(root, name)
  await mkdir(home, { recursive: true })
  // ESM so the probe's top-level await is legal outside this package.
  await writeFile(
    join(home, 'package.json'),
    '{"type":"module"}',
    'utf8',
  )
  await writeFile(join(home, 'probe.ts'), PROBE, 'utf8')
  return home
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wednesday-jobs-persistence-'))

  try {
    // Leg 1: a submitted run lands in jobs.json at its terminal state.
    const leg1 = await makeHome(root, 'leg1')
    const submitted = (await runProbe(leg1, 'submit')).submitted

    assert.ok(submitted, 'submit probe returned no job')
    assert.match(submitted.id, /^run-/)
    assert.ok(
      ['completed', 'failed', 'cancelled'].includes(submitted.state),
      `unexpected state ${submitted.state}`,
    )

    const onDisk = JSON.parse(
      await readFile(join(leg1, 'jobs.json'), 'utf8'),
    ) as { version: number; jobs: Array<{ id: string; state: string }> }

    assert.equal(onDisk.version, 1)
    const persisted = onDisk.jobs.find(job => job.id === submitted.id)
    assert.ok(persisted, 'terminal job missing from jobs.json')
    assert.equal(
      persisted.state,
      submitted.state,
      'persisted state differs from the in-memory state',
    )

    // Leg 2: a fresh process (the restart) restores that job verbatim.
    const reported = (await runProbe(leg1, 'report')).jobs ?? []
    const restored = reported.find(job => job.id === submitted.id)

    assert.ok(restored, 'restarted process lost the job')
    assert.equal(restored.state, submitted.state)

    const interrogated = await runProbe(leg1, 'interrogate', {
      PROBE_JOB_ID: submitted.id,
    })

    assert.equal(interrogated.view?.done, true)
    assert.equal(interrogated.waitDone, true)
    assert.equal(interrogated.missing, null)

    // Leg 3: a job mid-flight at restart comes back failed, not lost.
    const leg3 = await makeHome(root, 'leg3')
    const stamp = new Date().toISOString()

    await writeFile(
      join(leg3, 'jobs.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'run-midflight',
            state: 'running',
            request: 'was running when the server died',
            workspace: leg3,
            createdAt: stamp,
            updatedAt: stamp,
            elapsedMs: 42,
            hermesTaskId: 'wednesday-fixture',
          },
          {
            id: 'run-queued',
            state: 'queued',
            request: 'was queued when the server died',
            workspace: leg3,
            createdAt: stamp,
            updatedAt: stamp,
            elapsedMs: 0,
          },
          {
            id: 'run-finished',
            state: 'completed',
            request: 'finished before the restart',
            workspace: leg3,
            createdAt: stamp,
            updatedAt: stamp,
            elapsedMs: 1000,
          },
        ],
      }),
      'utf8',
    )

    const afterRestart = (await runProbe(leg3, 'report')).jobs ?? []
    const midflight = afterRestart.find(job => job.id === 'run-midflight')
    const queued = afterRestart.find(job => job.id === 'run-queued')
    const finished = afterRestart.find(job => job.id === 'run-finished')

    assert.equal(midflight?.state, 'failed')
    assert.match(midflight?.error ?? '', /server restart/)
    assert.equal(queued?.state, 'failed')
    assert.match(queued?.error ?? '', /server restart/)
    assert.equal(finished?.state, 'completed')

    // waitForJob on a restored mid-flight job returns done immediately, and
    // cancel on it is a harmless no-op instead of a crash.
    const deep = await runProbe(leg3, 'interrogate', {
      PROBE_JOB_ID: 'run-midflight',
    })

    assert.equal(deep.view?.done, true)
    assert.equal(deep.waitDone, true)
    assert.equal(deep.cancelState, 'failed')

    // The restored registry is rewritten in normalized form.
    const rewritten = JSON.parse(
      await readFile(join(leg3, 'jobs.json'), 'utf8'),
    ) as { jobs: Array<{ id: string; state: string }> }
    assert.equal(
      rewritten.jobs.find(job => job.id === 'run-midflight')?.state,
      'failed',
    )

    // Leg 4: a corrupt registry boots empty instead of crashing the server.
    const leg4 = await makeHome(root, 'leg4')
    await writeFile(join(leg4, 'jobs.json'), 'not json{{{', 'utf8')

    const corrupt = await runProbe(leg4, 'report')
    assert.deepEqual(corrupt.jobs, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log('JOBS PERSISTENCE TEST: PASS')
}

void main()

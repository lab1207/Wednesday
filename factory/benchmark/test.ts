import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BenchmarkDefinition, BenchmarkEvidence } from './types'
import { runLiveChecks } from './runner'

/**
 * V1.6 benchmark plumbing test — deterministic, offline.
 *
 * Proves the benchmark harness end to end without a model key: fixture copy,
 * OpenHands repository context, Hermes submit/run through FactoryService,
 * events, acceptance probes, regressions, deployment smoke, usage and the
 * evidence/report artifacts. The deterministic coder cannot implement the
 * fixture, so the run is EXPECTED to fail red — what must pass is the
 * harness plumbing and evidence recording.
 */

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'benchmark-plumbing-'))
  const outRoot = join(temp, 'out')
  const state = join(temp, 'state')
  const tasksPath = join(state, 'tasks.json')
  const eventsPath = join(state, 'events.jsonl')
  const cli = fileURLToPath(new URL('./run-benchmark.ts', import.meta.url))
  const fixture = join(fileURLToPath(new URL('./fixtures', import.meta.url)), 'snippetbox')

  try {
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, cli, '--fixture', 'snippetbox', '--mode', 'deterministic', '--out', outRoot],
      {
        encoding: 'utf8',
        timeout: 300000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: tasksPath,
          FACTORY_EVENTS_PATH: eventsPath,
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: outRoot,
        },
      },
    )

    assert.ifError(child.error)
    assert.equal(child.status, 0, `run-benchmark failed:\n${child.stdout}\n${child.stderr}`)

    const summary = JSON.parse(child.stdout) as {
      ok: boolean
      runId: string
      taskId: string
      runDir: string
      workspace: string
    }
    assert.equal(summary.ok, true)

    const evidence = JSON.parse(
      await readFile(join(summary.runDir, 'evidence.json'), 'utf8'),
    ) as BenchmarkEvidence

    assert.equal(evidence.benchmark.fixture, 'snippetbox')
    assert.equal(evidence.benchmark.variant, 'snippetbox-v1')
    assert.equal(evidence.benchmark.executionMode, 'deterministic')
    assert.equal(evidence.benchmark.taskId, summary.taskId)
    assert.ok(Number.isFinite(evidence.benchmark.durationMs))
    assert.ok(evidence.benchmark.durationMs >= 0)
    assert.notEqual(evidence.benchmark.workspace, fixture, 'workspace must be a fresh copy')

    assert.ok(
      evidence.definition.constraints.some(constraint => constraint.startsWith('Repository context')),
      'OpenHands repository context must be injected into the task constraints',
    )
    assert.ok(evidence.startingRepository.fileCount > 0)
    assert.ok(evidence.startingRepository.openhandsAdded)
    assert.equal(evidence.startingRepository.languages.length > 0, true)

    assert.ok(['completed', 'failed', 'cancelled'].includes(evidence.result.status))
    assert.ok(Object.keys(evidence.events.counts).includes('task.created'))
    assert.equal(evidence.events.counts['task.created'], 1)
    assert.ok(evidence.events.total >= 5)
    // Deterministic coder cannot implement the fixture, so the orchestrator
    // retries the coder through the repair loop (controlled execution,
    // 2026-09-19) and ends failed — repair attempts are real, not zero.
    assert.equal(evidence.events.counts['task.failed'], 1)
    assert.ok(evidence.events.repairAttempts > 0, 'coder failures must drive repairs')
    assert.equal(evidence.events.reviewVerdict, null)

    // Acceptance: 7 probes + 3 required-file checks + 1 verification check.
    assert.equal(evidence.acceptance.checks.length, 7 + 3 + 1)
    assert.equal(evidence.acceptance.passed, false, 'deterministic coder cannot implement the fixture')

    assert.equal(evidence.regressions.passed, false)
    assert.equal(evidence.deployment.booted, false, 'stubbed repo must fail to boot')
    assert.equal(evidence.deployment.attempted, true)

    assert.equal(evidence.usage.calls, 0, 'deterministic mode must not consume model tokens')
    assert.equal(evidence.usage.totalTokens, 0)

    assert.equal(evidence.humanInterventions, 0)

    const report = await readFile(join(summary.runDir, 'report.md'), 'utf8')
    assert.ok(report.includes('# Benchmark evidence'))
    assert.ok(report.includes('## Acceptance'))

    // Hermes store must contain the benchmark task with supervisor 'benchmark'.
    const store = JSON.parse(await readFile(tasksPath, 'utf8')) as {
      tasks: Array<{ id: string; supervisor?: string; engineeringTask: { id: string } }>
    }
    const task = store.tasks.find(item => item.id === summary.taskId)
    assert.ok(task, 'benchmark task must be recorded in the Hermes store')
    assert.equal(task.supervisor, 'benchmark')
    assert.equal(task.engineeringTask.id, summary.taskId)

    // Probe lifecycle: a booted app must stay alive for the probes. A
    // regression here killed the server right after the health check, so every
    // probe failed with `fetch failed` even though the workspace passed its
    // own tests.
    const liveDir = join(temp, 'live-app')
    await mkdir(liveDir, { recursive: true })
    await writeFile(join(liveDir, 'server.js'), `
import { createServer } from 'node:http'
const port = Number(process.env.PORT)
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method === 'POST' && req.url === '/api/echo') {
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404)
  res.end('not found')
}).listen(port, '127.0.0.1')
`)
    const liveDefinition: BenchmarkDefinition = {
      id: 'live-app',
      title: 'Live probe lifecycle fixture',
      variant: 'test',
      fixtureDir: liveDir,
      objective: 'none',
      role: 'backend',
      stack: 'node',
      constraints: [],
      acceptanceCriteria: [],
      requiredFiles: [],
      testCommands: [],
      boot: { argv: ['server.js'], healthPath: '/api/health', maxWaitAttempts: 40 },
      probes: [
        {
          name: 'health endpoint',
          run: async api => {
            const res = await api.request('GET', '/api/health')
            return { passed: res.status === 200, details: `status ${res.status}` }
          },
        },
        {
          name: 'echo endpoint',
          run: async api => {
            const res = await api.request('POST', '/api/echo', { body: { ping: true } })
            return { passed: res.status === 201, details: `status ${res.status}` }
          },
        },
      ],
    }
    const live = await runLiveChecks(liveDefinition, liveDir, temp)
    assert.equal(live.booted, true, 'the fixture server must boot')
    assert.equal(live.healthStatus, 200)
    assert.deepEqual(
      live.checks.map(check => check.passed),
      [true, true],
      'probes must run against the server while it is still alive',
    )

    console.log('BENCHMARK PLUMBING TEST: PASS')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
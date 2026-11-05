import {
  cp,
  mkdir,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

import type {
  AcceptanceCheckResult,
  EngineeringResult,
} from '../contracts'
import type {
  BenchmarkDefinition,
  BenchmarkEvidence,
  ProbeApi,
} from './types'

import { analyzeRepository } from '../openhands/connector'
import { resolveExecutorTimeoutMs } from '../executor'
import { resolveRunBudget } from '../orchestrator/orchestrator'
import {
  submitTask,
  runHermesTask,
  loadStore,
} from '../hermes/store'
import { PersistentFactoryEventBus } from '../events'
import { EVENTS_PATH } from '../paths'
import { VerificationEngine } from '../verification'
import {
  usageSnapshot,
  usageDiff,
  estimateCostUsd,
} from '../model-router/usage'

export const RUNNER_VERSION = 'v1.6.0'

export const DEFAULT_OUT_ROOT = join(
  homedir(),
  '.wednesday',
  'benchmarks',
)

const IGNORED_COPY = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '__pycache__', '.venv', 'venv',
])

export interface BenchmarkRunOptions {
  definition: BenchmarkDefinition
  outRoot: string
  executionMode: 'deterministic' | 'live'
  useOpenhands: boolean
  taskId?: string
}

export interface BenchmarkRun {
  evidence: BenchmarkEvidence
  runDir: string
  workspace: string
  hermesTaskId: string
}

async function countFiles(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_COPY.has(entry.name)) continue
      total += await countFiles(join(directory, entry.name))
    } else {
      total += 1
    }
  }
  return total
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runBenchmark(
  options: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
  const definition = options.definition
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const runDir = join(options.outRoot, definition.id, runId)
  const workspace = join(runDir, 'workspace')

  await mkdir(workspace, { recursive: true })
  await cp(definition.fixtureDir, workspace, {
    recursive: true,
    filter: source => !IGNORED_COPY.has(basename(source)),
  })

  const profile = options.useOpenhands
    ? await analyzeRepository(workspace)
    : undefined

  const openhandsConstraints = profile ? profile.toConstraints() : []
  const constraints = [
    ...definition.constraints,
    ...openhandsConstraints,
  ]

  const taskId = options.taskId ?? `benchmark-${runId}`

  const task = {
    id: taskId,
    workspace,
    objective: definition.objective,
    role: definition.role,
    stack: definition.stack,
    constraints,
    acceptanceCriteria: definition.acceptanceCriteria,
    modelRequirements: { capability: 'coding' },
    acceptance: { requiredFiles: definition.requiredFiles },
    verification: {
      setupCommands: [],
      testCommands: definition.testCommands,
    },
  }

  const usageBefore = usageSnapshot()
  const startedAt = new Date().toISOString()
  const wallStart = Date.now()

  // V1.7 auditability — record the wall-clock caps in force for this run
  // (same resolution as the live path: explicit env or compiled default).
  const executorTimeoutMs = resolveExecutorTimeoutMs()
  const coderTimeoutMs = Number(
    process.env.FACTORY_CODER_TIMEOUT_MS?.trim() || 300000,
  )
  const budget = resolveRunBudget()

  let hermesStatus = 'failed'
  let result: EngineeringResult | undefined
  let runError: string | undefined
  let hermesTaskId = taskId

  try {
    hermesTaskId = await submitTask({ task, supervisor: 'benchmark' })
    const outcome = await runHermesTask(hermesTaskId)
    hermesStatus = outcome.status
    const latest = await loadStore()
    const record = latest.tasks.find(item => item.id === hermesTaskId)
    result = record?.result as EngineeringResult | undefined
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error)
  }

  const wallMs = Date.now() - wallStart
  const endedAt = new Date().toISOString()

  const usageAfter = usageSnapshot()
  const usageDeltas = usageDiff(usageBefore, usageAfter)

  const bus = new PersistentFactoryEventBus({ filePath: EVENTS_PATH })
  const events = await bus.list(hermesTaskId)

  const counts: Record<string, number> = {}
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1
  }

  const repairReasons: string[] = []
  for (const event of events) {
    if (event.type !== 'repair.started') continue
    const reason = event.payload?.reason
    if (Array.isArray(reason)) {
      repairReasons.push(...reason.map(String))
    } else if (reason !== undefined) {
      repairReasons.push(String(reason))
    }
  }

  const reviewCompleted = events.filter(event => event.type === 'review.completed')
  const reviewVerdict = (reviewCompleted.at(-1)?.payload?.status as string | undefined) ?? null

  // Post-run evaluation: regression test suite + live HTTP acceptance probes.
  const verifier = new VerificationEngine()
  const regression = await verifier.verify(
    workspace,
    [],
    definition.testCommands,
  )

  const liveChecks = definition.boot === null
    ? { checks: [], booted: false, healthStatus: null as number | null, detail: 'No boot command defined for this fixture.' }
    : await runLiveChecks(definition, workspace, runDir)

  const acceptanceChecks: AcceptanceCheckResult[] = [
    ...liveChecks.checks,
    ...definition.requiredFiles.map(file => {
      const fullPath = join(workspace, file)
      const exists = existsSync(fullPath)
      return {
        criterion: `${file} exists`,
        passed: exists,
        details: exists ? `Found ${fullPath}` : `Missing ${fullPath}`,
      } satisfies AcceptanceCheckResult
    }),
    {
      criterion: 'verification passes (node --test)',
      passed: regression.passed,
      details: regression.passed
        ? 'All verification commands passed on the final workspace.'
        : 'One or more verification commands failed on the final workspace.',
    } satisfies AcceptanceCheckResult,
  ]

  const usageModels = usageDeltas.map(record => {
    const costUsd = estimateCostUsd(record)
    return { ...record, costUsd }
  })

  const usageCalls = usageModels.reduce((sum, record) => sum + record.calls, 0)
  const promptTokens = usageModels.reduce((sum, record) => sum + record.promptTokens, 0)
  const completionTokens = usageModels.reduce((sum, record) => sum + record.completionTokens, 0)
  const pricedCount = usageModels.filter(record => record.costUsd !== null).length
  const costUsd = pricedCount > 0
    ? usageModels.reduce((sum, record) => sum + (record.costUsd ?? 0), 0)
    : null

  const evidence: BenchmarkEvidence = {
    benchmark: {
      fixture: definition.id,
      variant: definition.variant,
      title: definition.title,
      runId,
      taskId: hermesTaskId,
      executionMode: options.executionMode,
      startedAt,
      endedAt,
      durationMs: wallMs,
      workspace,
      runnerVersion: RUNNER_VERSION,
      limits: {
        executorTimeoutMs,
        coderTimeoutMs,
        budgetTokens: budget.maxTokens,
        budgetUsd: budget.maxCostUsd,
      },
    },
    definition: {
      objective: definition.objective,
      constraints,
      acceptanceCriteria: definition.acceptanceCriteria,
      requiredFiles: definition.requiredFiles,
      testCommands: definition.testCommands,
    },
    startingRepository: {
      fileCount: await countFiles(workspace),
      languages: profile?.languages ?? [],
      keyFiles: profile?.keyFiles ?? [],
      openhandsAdded: profile !== undefined,
    },
    run: {
      hermesStatus,
      ...(runError !== undefined ? { error: runError } : {}),
    },
    result: result === undefined
      ? {
          status: 'failed',
          summary: runError ?? 'No result was produced.',
          output: '',
          filesChanged: [],
          tests: [],
          acceptanceChecks: [],
          diagnostics: runError,
        }
      : {
          status: result.status,
          summary: result.summary,
          output: result.output.slice(0, 20_000),
          filesChanged: result.filesChanged ?? [],
          tests: result.tests ?? [],
          acceptanceChecks: result.acceptanceChecks ?? [],
          provider: result.provider,
          model: result.model,
          diagnostics: result.diagnostics,
        },
    events: {
      total: events.length,
      counts,
      repairAttempts: counts['repair.started'] ?? 0,
      repairReasons,
      reviewVerdict,
    },
    acceptance: {
      checks: acceptanceChecks,
      passed: acceptanceChecks.length > 0 && acceptanceChecks.every(check => check.passed),
    },
    regressions: {
      passed: regression.passed,
      tests: regression.tests,
    },
    deployment: {
      attempted: definition.boot !== null,
      booted: liveChecks.booted,
      healthStatus: liveChecks.healthStatus,
      detail: liveChecks.detail,
    },
    usage: {
      calls: usageCalls,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      models: usageModels,
    },
    humanInterventions: 0,
  }

  await writeFile(
    join(runDir, 'evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8',
  )
  await writeFile(
    join(runDir, 'report.md'),
    renderReport(evidence),
    'utf8',
  )

  return { evidence, runDir, workspace, hermesTaskId }
}

interface LiveChecksResult {
  checks: AcceptanceCheckResult[]
  booted: boolean
  healthStatus: number | null
  detail: string
}

export async function runLiveChecks(
  definition: BenchmarkDefinition,
  workspace: string,
  runDir: string,
): Promise<LiveChecksResult> {
  if (definition.boot === null) {
    return { checks: [], booted: false, healthStatus: null, detail: 'No boot command defined.' }
  }

  const port = 43000 + Math.floor(Math.random() * 1999)
  const probeStore = join(runDir, 'probe-store.json')

  const child = spawn(
    process.execPath,
    definition.boot.argv,
    {
      cwd: workspace,
      env: {
        ...process.env,
        PORT: String(port),
        SNIPPETBOX_STORE: probeStore,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })

  const maxAttempts = definition.boot.maxWaitAttempts ?? 40
  let healthStatus: number | null = null

  // The booted server must stay alive for the probes; kill it only once every
  // probe has run (the outer `finally`).
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (child.exitCode !== null) break
      try {
        const res = await fetch(`http://127.0.0.1:${port}${definition.boot.healthPath}`)
        if (res.ok) {
          healthStatus = res.status
          break
        }
      } catch {
        // Server not up yet; retry.
      }
      await delay(250)
    }

    const booted = healthStatus !== null
    const detail = booted
      ? `App booted, ${definition.boot.healthPath} returned ${healthStatus}.`
      : `App failed to boot: ${stderr.slice(-1000) || 'no output'}`

    if (!booted) {
      return {
        checks: definition.probes.map(probe => ({
          criterion: probe.name,
          passed: false,
          details: detail,
        })),
        booted: false,
        healthStatus: null,
        detail,
      }
    }

    const api: ProbeApi = {
      async request(method, path, options) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (options?.token !== undefined) {
          headers.authorization = `Bearer ${options.token}`
        }
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
          body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        })
        return {
          status: res.status,
          json: () => res.json().catch(() => null),
          text: () => res.text().catch(() => ''),
        }
      },
    }

    const checks: AcceptanceCheckResult[] = []
    for (const probe of definition.probes) {
      try {
        const outcome = await probe.run(api)
        checks.push({
          criterion: probe.name,
          passed: outcome.passed,
          details: outcome.details,
        })
      } catch (error: unknown) {
        checks.push({
          criterion: probe.name,
          passed: false,
          details: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { checks, booted: true, healthStatus, detail }
  } finally {
    child.kill()
    await delay(150)
  }
}

function renderReport(evidence: BenchmarkEvidence): string {
  const lines: string[] = []
  const b = evidence.benchmark
  lines.push(`# Benchmark evidence — ${b.fixture} (${b.variant})`)
  lines.push('')
  lines.push(`- Run: ${b.runId}`)
  lines.push(`- Mode: ${b.executionMode}`)
  lines.push(`- Runner: ${b.runnerVersion}`)
  lines.push(`- Task: ${b.taskId}`)
  lines.push(`- Workspace: ${b.workspace}`)
  lines.push(`- Duration: ${b.durationMs} ms (${(b.durationMs / 1000).toFixed(1)} s)`)
  lines.push(`- Limits: executor ${b.limits.executorTimeoutMs} ms, coder ${b.limits.coderTimeoutMs} ms, budget ${b.limits.budgetTokens} tokens / $${b.limits.budgetUsd}`)
  lines.push(`- Started: ${b.startedAt}`)
  lines.push(`- Ended: ${b.endedAt}`)
  lines.push('')
  lines.push('## Result')
  lines.push('')
  lines.push(`- Hermes status: ${evidence.run.hermesStatus}`)
  if (evidence.run.error !== undefined) lines.push(`- Run error: ${evidence.run.error}`)
  lines.push(`- Status: ${evidence.result.status}`)
  lines.push(`- Summary: ${evidence.result.summary}`)
  if (evidence.result.provider !== undefined) lines.push(`- Provider: ${evidence.result.provider}`)
  if (evidence.result.model !== undefined) lines.push(`- Model: ${evidence.result.model}`)
  if (evidence.result.filesChanged.length > 0) {
    lines.push(`- Files changed: ${evidence.result.filesChanged.join(', ')}`)
  }
  if (evidence.result.diagnostics !== undefined) {
    lines.push('')
    lines.push('Diagnostics:')
    lines.push('```')
    lines.push(evidence.result.diagnostics.slice(0, 4000))
    lines.push('```')
  }
  lines.push('')
  lines.push('## Acceptance (evaluation probes + fixed checks)')
  lines.push('')
  for (const check of evidence.acceptance.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}] ${check.criterion}${check.details ? ` — ${check.details}` : ''}`)
  }
  lines.push('')
  lines.push('## Verification / regressions')
  lines.push('')
  for (const test of evidence.regressions.tests) {
    lines.push(`- [${test.passed ? 'PASS' : 'FAIL'}] ${test.command}${test.output ? ` — ${test.output.slice(0, 400)}` : ''}`)
  }
  lines.push('')
  lines.push('## Deployment')
  lines.push('')
  lines.push(`- Booted: ${evidence.deployment.booted}`)
  lines.push(`- Health status: ${evidence.deployment.healthStatus ?? 'n/a'}`)
  lines.push(`- Detail: ${evidence.deployment.detail}`)
  lines.push('')
  lines.push('## Orchestration events')
  lines.push('')
  lines.push(`- Total events: ${evidence.events.total}`)
  lines.push(`- Repair attempts: ${evidence.events.repairAttempts}`)
  lines.push(`- Review verdict: ${evidence.events.reviewVerdict ?? 'n/a'}`)
  lines.push(`- Human interventions: ${evidence.humanInterventions}`)
  lines.push('- Counts:')
  for (const [type, count] of Object.entries(evidence.events.counts)) {
    lines.push(`  - ${type}: ${count}`)
  }
  if (evidence.events.repairReasons.length > 0) {
    lines.push('- Repair reasons:')
    for (const reason of evidence.events.repairReasons.slice(0, 12)) {
      lines.push(`  - ${reason.slice(0, 300)}`)
    }
  }
  lines.push('')
  lines.push('## Model usage')
  lines.push('')
  lines.push(`- Calls: ${evidence.usage.calls}`)
  lines.push(`- Prompt tokens: ${evidence.usage.promptTokens}`)
  lines.push(`- Completion tokens: ${evidence.usage.completionTokens}`)
  lines.push(`- Total tokens: ${evidence.usage.totalTokens}`)
  lines.push(`- Estimated cost USD: ${evidence.usage.costUsd === null ? 'n/a (no price-table entry)' : evidence.usage.costUsd}`)
  if (evidence.usage.models.length > 0) {
    lines.push('- Per model:')
    for (const model of evidence.usage.models) {
      lines.push(`  - ${model.provider}/${model.model}: ${model.calls} calls, ${model.promptTokens + model.completionTokens} tokens, cost ${model.costUsd ?? 'n/a'}`)
    }
  }
  lines.push('')
  return lines.join('\n') + '\n'
}
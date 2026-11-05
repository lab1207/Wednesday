import type {
  AcceptanceCheckResult,
  EngineeringTestResult,
} from '../contracts'

/** A live HTTP evaluation probe against a booted app workspace. */
export interface BenchmarkProbe {
  name: string
  run(api: ProbeApi): Promise<{ passed: boolean; details: string }>
}

/** Minimal HTTP helper handed to probes (wraps global fetch). */
export interface ProbeApi {
  request(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown },
  ): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>
}

export interface BenchmarkBoot {
  /** argv for the app, run with `node <argv...>` from the workspace */
  argv: string[]
  healthPath: string
  /** Number of attempts (250ms apart) to wait for a successful health probe. */
  maxWaitAttempts?: number
}

export interface BenchmarkDefinition {
  id: string
  title: string
  variant: string
  fixtureDir: string
  objective: string
  role: string
  stack: string
  constraints: string[]
  acceptanceCriteria: string[]
  /** Contribution targets — files the Factory must create or complete. */
  requiredFiles: string[]
  testCommands: string[]
  boot: BenchmarkBoot | null
  probes: BenchmarkProbe[]
}

export interface BenchmarkResultEvidence {
  status: string
  summary: string
  output: string
  filesChanged: string[]
  tests: EngineeringTestResult[]
  acceptanceChecks: AcceptanceCheckResult[]
  provider?: string
  model?: string
  diagnostics?: string
}

export interface BenchmarkUsageRecord {
  provider: string
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  /** USD estimate, null until the model has a price-table entry. */
  costUsd: number | null
}

export interface BenchmarkEvidence {
  benchmark: {
    fixture: string
    variant: string
    title: string
    runId: string
    taskId: string
    executionMode: 'deterministic' | 'live'
    startedAt: string
    endedAt: string
    durationMs: number
    workspace: string
    runnerVersion: string
    /** V1.7 auditability — the wall-clock caps in force for this run. */
    limits: {
      executorTimeoutMs: number
      coderTimeoutMs: number
      /** V1.7 cost controls — Infinity means unenforced. */
      budgetTokens: number
      budgetUsd: number
    }
  }
  definition: {
    objective: string
    constraints: string[]
    acceptanceCriteria: string[]
    requiredFiles: string[]
    testCommands: string[]
  }
  startingRepository: {
    fileCount: number
    languages: string[]
    keyFiles: string[]
    openhandsAdded: boolean
  }
  run: {
    hermesStatus: string
    error?: string
  }
  result: BenchmarkResultEvidence
  events: {
    total: number
    counts: Record<string, number>
    repairAttempts: number
    repairReasons: string[]
    reviewVerdict: string | null
  }
  acceptance: {
    checks: AcceptanceCheckResult[]
    passed: boolean
  }
  regressions: {
    passed: boolean
    tests: EngineeringTestResult[]
  }
  deployment: {
    attempted: boolean
    booted: boolean
    healthStatus: number | null
    detail: string
  }
  usage: {
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number | null
    models: BenchmarkUsageRecord[]
  }
  humanInterventions: number
}
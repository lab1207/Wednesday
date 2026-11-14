/**
 * THE MCP JOB LAYER (2026-11-14).
 *
 * Wednesday's engine is a long-running thing: a sentence goes in, a staffed
 * team works inside a sandbox, and a verdict comes out minutes later. MCP
 * tool calls are short and impatient - most clients cut them off well before
 * a real engineering run finishes. This module is the seam between the two:
 * one "start" call becomes a job id, the job keeps its own state, and the
 * client polls, waits, or cancels without ever touching the Factory.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not plan, route, or execute. Every
 * run goes through `submitTask` and `runHermesTask` - the SAME supervised
 * path the terminal harness uses. The architecture rule says Hermes ->
 * FactoryService is the only execution path, and an MCP client is not an
 * exception to it.
 *
 * WHY THE QUEUE IS SEQUENTIAL: seats share one state home, one event log and
 * (by default) one workspace. Two jobs at once would interleave their events
 * into a single undifferentiated stream - the exact ambiguity the lane
 * events were invented to fix inside one run. One job at a time is the
 * honest default. Parallelism is a Factory concern (`runMany`), not an MCP
 * one, so it is not invented here.
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  runHermesTask,
  submitTask,
} from '../hermes/store'

import {
  PersistentFactoryEventBus,
} from '../events'

import { EVENTS_PATH } from '../paths'

import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts'

import type { FactoryEvent } from '../events'

export type JobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** What a client asks for. One sentence and, at most, the bounds of it. */
export interface RunRequest {
  /** The operator's request, in their own words. */
  request: string
  /** Where the work happens. Defaults to the server's own directory. */
  workspace?: string
  role?: string
  stack?: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  tests?: string[]
  requiredFiles?: string[]
}

export interface Job {
  id: string
  state: JobState
  request: string
  workspace: string
  role?: string
  createdAt: string
  updatedAt: string
  elapsedMs: number
  hermesTaskId?: string
  result?: EngineeringResult
  error?: string
}

/** A job plus what the team is doing right now. */
export interface JobView extends Job {
  progress: string[]
  done: boolean
}

interface JobRecord {
  job: Job
  spec: Omit<EngineeringTask, 'id'>
  controller: AbortController
  /** Cancelled while queued: the run is skipped, never submitted. */
  cancelled: boolean
}

const jobs = new Map<string, JobRecord>()
const order: string[] = []

/**
 * The tail of the run chain. Every job appends to it, so jobs execute one
 * after another and a failing job can never break the queue behind it.
 */
let tail: Promise<void> = Promise.resolve()

const bus = new PersistentFactoryEventBus({
  filePath: EVENTS_PATH,
})

function nowIso(): string {
  return new Date().toISOString()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms)
  })
}

/**
 * Validate and register a run. Rejects immediately on a bad request or a
 * missing workspace, because an agent caller deserves the error in the same
 * tool call that asked for the work - not two seconds later in a poll.
 */
export async function submitRun(
  input: RunRequest,
): Promise<Job> {
  const request =
    (input.request ?? '').trim()

  if (!request) {
    throw new Error('request is required: say what the team should build.')
  }

  const workspace =
    resolve(
      input.workspace ?? process.cwd(),
    )

  let directory: Awaited<ReturnType<typeof stat>>

  try {
    directory = await stat(workspace)
  } catch {
    throw new Error(`Workspace does not exist: ${workspace}`)
  }

  if (!directory.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`)
  }

  const timestamp = nowIso()

  const job: Job = {
    id: `run-${randomUUID()}`,
    state: 'queued',
    request,
    workspace,
    role: input.role,
    createdAt: timestamp,
    updatedAt: timestamp,
    elapsedMs: 0,
  }

  const record: JobRecord = {
    job,
    spec: {
      workspace,
      objective: request,
      role: input.role ?? 'backend',
      stack: input.stack,
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      modelRequirements: {
        capability: 'coding',
      },
      acceptance:
        input.requiredFiles && input.requiredFiles.length > 0
          ? { requiredFiles: input.requiredFiles }
          : undefined,
      verification:
        input.tests && input.tests.length > 0
          ? { setupCommands: [], testCommands: input.tests }
          : undefined,
    },
    controller: new AbortController(),
    cancelled: false,
  }

  jobs.set(job.id, record)
  order.push(job.id)

  const run = tail.then(
    () => execute(record),
  )

  // Keep the chain alive whatever happens inside one job.
  tail = run.catch(() => undefined)

  return job
}

async function execute(
  record: JobRecord,
): Promise<void> {
  const { job } = record

  if (record.cancelled) {
    job.state = 'cancelled'
    job.updatedAt = nowIso()

    return
  }

  job.state = 'running'
  job.updatedAt = nowIso()

  const startedAt = Date.now()

  try {
    const task: EngineeringTask = {
      id: `wednesday-${randomUUID()}`,
      ...record.spec,
    }

    const hermesTaskId =
      await submitTask({
        task,
        supervisor: 'wednesday-mcp',
      })

    job.hermesTaskId = hermesTaskId
    job.updatedAt = nowIso()

    const outcome =
      await runHermesTask(
        hermesTaskId,
        { signal: record.controller.signal },
      )

    job.result =
      asResult(outcome.result)

    switch (outcome.status) {
      case 'completed':
        job.state = 'completed'
        break

      case 'cancelled':
        job.state = 'cancelled'
        break

      case 'failed':
        job.state = 'failed'
        job.error =
          job.result?.summary ??
          outcome.message ??
          'the run failed'
        break

      default:
        job.state = 'failed'
        job.error = `unexpected Hermes status: ${outcome.status}`
        break
    }
  } catch (error) {
    job.state =
      record.controller.signal.aborted
        ? 'cancelled'
        : 'failed'

    job.error = messageOf(error)
  } finally {
    job.elapsedMs = Date.now() - startedAt
    job.updatedAt = nowIso()
  }
}

function asResult(
  value: unknown,
): EngineeringResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate =
    value as Partial<EngineeringResult>

  if (
    typeof candidate.taskId !== 'string' ||
    typeof candidate.status !== 'string'
  ) {
    return undefined
  }

  return candidate as EngineeringResult
}

export function getJob(
  id: string,
): Job | undefined {
  return jobs.get(id)?.job
}

export function listJobs(): Job[] {
  return order
    .map(id => jobs.get(id)?.job)
    .filter((job): job is Job => job !== undefined)
    .reverse()
}

/** Cancel a running job, or stop a queued one before it ever starts. */
export function cancelJob(
  id: string,
): Job | undefined {
  const record = jobs.get(id)

  if (!record) {
    return undefined
  }

  if (isTerminal(record.job.state)) {
    return record.job
  }

  if (record.job.state === 'queued') {
    record.cancelled = true
  }

  record.controller.abort()

  return record.job
}

/**
 * The team's last few steps, read from the same event log the terminal
 * harness draws its dock from. Absent or unreadable log = no progress lines;
 * a poll must never fail because history is missing.
 */
export async function progressFor(
  hermesTaskId: string | undefined,
): Promise<string[]> {
  if (!hermesTaskId) {
    return []
  }

  let events: FactoryEvent[]

  try {
    events = await bus.list()
  } catch {
    return []
  }

  return events
    .filter(event => event.taskId === hermesTaskId)
    .map(describeEvent)
    .filter(line => line.length > 0)
    .slice(-12)
}

function describeEvent(
  event: FactoryEvent,
): string {
  const role =
    event.role ? `${event.role}: ` : ''

  const payload =
    event.payload ?? {}

  switch (event.type) {
    case 'task.started':
      return 'team started'

    case 'agent.started':
      return `${role}started`

    case 'agent.completed':
      return `${role}finished`

    case 'agent.activity': {
      if (payload.kind === 'tool') {
        const tool = String(
          payload.tool ??
          payload.detail ??
          '',
        ).trim()

        return tool ? `${role}tool ${tool}` : ''
      }

      if (payload.kind === 'file') {
        const file = String(
          payload.detail ?? '',
        ).trim()

        return file ? `${role}wrote ${file}` : ''
      }

      // Reasoning and chat text belong on a screen, not in a poll reply.
      return ''
    }

    case 'verification.started':
      return 'verification started'

    case 'verification.completed':
      return payload.ok === false
        ? 'verification FAILED'
        : 'verification passed'

    case 'review.started':
      return 'review started'

    case 'review.completed':
      return 'review finished'

    case 'repair.started':
      return 'repair started'

    case 'task.completed':
      return 'done'

    case 'task.failed':
      return 'run failed'

    case 'task.blocked':
      return 'run blocked'

    default:
      return ''
  }
}

export async function jobView(
  id: string,
): Promise<JobView | undefined> {
  const record = jobs.get(id)

  if (!record) {
    return undefined
  }

  const { job } = record

  return {
    ...job,
    progress:
      await progressFor(job.hermesTaskId),
    done: isTerminal(job.state),
  }
}

/**
 * Block until the job finishes or the window closes.
 *
 * Clients kill a tool call that runs too long, so this deliberately returns
 * `done: false` instead of hanging: the caller asks again. `onTick` fires
 * every few seconds so a client that supports progress notifications can
 * show the team moving rather than a frozen spinner.
 */
export async function waitForJob(
  id: string,
  timeoutMs: number,
  onTick?: (job: Job) => void,
): Promise<{ job: Job; done: boolean } | undefined> {
  const record = jobs.get(id)

  if (!record) {
    return undefined
  }

  const deadline = Date.now() + timeoutMs
  let lastTick = 0

  for (;;) {
    const done =
      isTerminal(record.job.state)

    if (done || Date.now() >= deadline) {
      return {
        job: record.job,
        done,
      }
    }

    const now = Date.now()

    if (onTick && now - lastTick >= 4000) {
      lastTick = now
      onTick(record.job)
    }

    await delay(250)
  }
}

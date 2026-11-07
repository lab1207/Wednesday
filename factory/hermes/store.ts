import { randomUUID } from 'node:crypto'
import {
  readFile,
  writeFile,
  mkdir,
  stat,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  EngineeringTask,
} from '../contracts'

/**
 * V1.5 — shared Hermes task store.
 *
 * Shared by the Hermes CLI and Factory terminal harness for persisted
 * task submission and supervised execution.
 */

import { TASKS_PATH } from '../paths'
import { migrateLegacyState } from '../state-migration'
export const TASKS_FILE = TASKS_PATH

/**
 * V1.7 hardening — preemptive cancellation. runHermesTask registers its
 * run-scoped AbortController here; the `cancel` verb aborts it so an
 * in-flight Factory run stops (host child killed) instead of running to
 * completion and only flipping status afterwards. Preemption is cooperative
 * between stages — an in-flight model call finishes, then the run stops
 * before further work starts.
 */
const runningControllers = new Map<string, AbortController>()

export function abortRunningTask(hermesTaskId: string): boolean {
  const controller = runningControllers.get(hermesTaskId)
  if (!controller) return false
  controller.abort()
  return true
}

export type HermesTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface HermesTask {
  id: string
  status: HermesTaskStatus

  createdAt: string
  updatedAt: string

  engineeringTask:
    EngineeringTask

  result?: unknown

  cancelRequested?: boolean

  supervisor?: string
  supervisedAt?: string
}

export interface HermesStore {
  tasks: HermesTask[]
  updatedAt: string
}

export async function loadStore(): Promise<HermesStore> {
  await migrateLegacyState()

  try {
    const raw =
      await readFile(
        TASKS_FILE,
        'utf8',
      )

    const store = JSON.parse(
      raw.replace(/^\uFEFF/, ''),
    ) as HermesStore
    if (!store || !Array.isArray(store.tasks)) {
      throw new Error('Task store has no tasks array.')
    }
    return store
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {
      tasks: [],
      updatedAt: new Date().toISOString(),
    }
  }
}

export async function saveStore(
  store: HermesStore,
): Promise<void> {
  store.updatedAt =
    new Date().toISOString()

  await migrateLegacyState()
  await mkdir(dirname(TASKS_FILE), { recursive: true, mode: 0o700 })
  await writeFile(
    TASKS_FILE,
    JSON.stringify(
      store,
      null,
      2,
    ) + '\n',
    'utf8',
  )
}

export interface HermesSubmitInput {
  task: EngineeringTask
  supervisor?: string
}

/** Persist a queued, supervised task. Returns the task id. */
export async function submitTask(
  input: HermesSubmitInput,
): Promise<string> {
  const now =
    new Date().toISOString()

  const id =
    input.task.id ||
    `hermes-${randomUUID()}`

  const store =
    await loadStore()

  // Live-observed 2026-09-21: duplicate ids silently re-run the FIRST
  // matching workspace (find-first lookup), misattributing whole batches.
  // Re-submit is never valid — retry flips the existing record instead.
  if (
    store.tasks.some(
      item =>
        item.id === id,
    )
  ) {
    throw new Error(
      `Task already exists: ${id}. Use retry to re-run it, or submit with a unique id.`,
    )
  }

  // Fail fast on missing workspaces: the executor would otherwise fall
  // back to the install root and run the task in the wrong place silently.
  try {
    const workspaceStat = await stat(input.task.workspace)
    if (!workspaceStat.isDirectory()) {
      throw new Error(`Task workspace is not a directory: ${input.task.workspace}`)
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Task workspace')) throw error
    throw new Error(`Task workspace does not exist: ${input.task.workspace}`)
  }

  store.tasks.push({
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    engineeringTask: {
      ...input.task,
      id,
    },
    supervisor:
      input.supervisor ??
      'hermes-api',
    supervisedAt: now,
  })

  await saveStore(store)

  return id
}

/**
 * Run a queued Hermes task through the Factory and persist the outcome.
 * Shared by the Hermes CLI (`run` verb) and the terminal harness.
 */
export async function runHermesTask(
  hermesTaskId: string,
  options: {
    signal?: AbortSignal
  } = {},
): Promise<{
  status: HermesTaskStatus
  result?: unknown
  supervisedAt?: string
  completionAt?: string
  message?: string
}> {
  const store =
    await loadStore()

  const record =
    store.tasks.find(
      item =>
        item.id === hermesTaskId,
    )

  if (!record) {
    throw new Error(
      `Task not found: ${hermesTaskId}`,
    )
  }

  if (
    record.status ===
      'completed' ||
    record.status ===
      'cancelled'
  ) {
    return {
      status: record.status,
      result: record.result,
      message: 'Task is already terminal.',
    }
  }

  const runStart =
    new Date().toISOString()

  // V1.7 hardening — cancellation: a cancel requested while the task was
  // queued must take effect WITHOUT running the Factory. (Previously the
  // flag was silently reset below and the run proceeded anyway; the request
  // only surfaced as a post-run status flip.)
  if (record.cancelRequested) {
    record.status = 'cancelled'
    record.updatedAt = new Date().toISOString()

    await saveStore(store)

    return {
      status: 'cancelled',
      message: 'Cancel was requested before the run started; the task was not executed.',
    }
  }

  record.status = 'running'
  record.cancelRequested = false
  record.supervisedAt = runStart
  record.updatedAt = runStart

  await saveStore(store)

  // Run-scoped controller: the cancel verb aborts this to preempt the run,
  // and an external caller signal (if any) forwards into it.
  const controller = new AbortController()
  const forwardAbort = (): void => {
    controller.abort()
  }
  const externalSignal = options.signal
  if (externalSignal?.aborted === true) {
    controller.abort()
  } else {
    externalSignal?.addEventListener('abort', forwardAbort, { once: true })
  }
  runningControllers.set(hermesTaskId, controller)

  // THE SERVICE MUST BE DISPOSED (2026-11-07).
  //
  // The service boots the DSH skill filesystem, and that filesystem watches
  // every skill root it discovers — about twenty-three open handles per
  // run. A one-shot process could not exit at all, and the long-running
  // harness leaked a fresh set of watchers on EVERY run. Disposing the
  // service closes them.
  let disposable: { dispose(): Promise<void> } | undefined

  try {
    const { createFactoryService } = await import('../service')
    const service = await createFactoryService()
    disposable = service
    const result =
      await service.run(
        record.engineeringTask,
        {
          signal:
            controller.signal,
        },
      )

    const latest =
      await loadStore()

    const latestRecord =
      latest.tasks.find(
        item =>
          item.id === hermesTaskId,
      )

    if (!latestRecord) {
      throw new Error(
        `Task disappeared: ${hermesTaskId}`,
      )
    }

    latestRecord.status = latestRecord.cancelRequested
      ? 'cancelled'
      : result.status === 'completed'
        ? 'completed'
        : 'failed'

    latestRecord.result = result
    latestRecord.supervisedAt = runStart
    latestRecord.updatedAt =
      new Date().toISOString()

    await saveStore(latest)

    return {
      status: latestRecord.status,
      result,
      supervisedAt: runStart,
      completionAt: latestRecord.updatedAt,
    }
  } catch (error: unknown) {
    const latest =
      await loadStore()

    const latestRecord =
      latest.tasks.find(
        item =>
          item.id === hermesTaskId,
      )

    if (latestRecord) {
      latestRecord.status =
        latestRecord.cancelRequested
          ? 'cancelled'
          : 'failed'

      latestRecord.result = {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }

      latestRecord.updatedAt =
        new Date().toISOString()

      await saveStore(latest)
    }

    throw error
  } finally {
    runningControllers.delete(hermesTaskId)
    externalSignal?.removeEventListener('abort', forwardAbort)
    try {
      await disposable?.dispose()
    } catch {
      // A leaked handle is better than a failed run.
    }
  }
}

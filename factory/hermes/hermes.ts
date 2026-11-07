import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { redactSensitiveText } from '../security/redaction'

import type {
  EngineeringTask,
} from '../contracts'

import {
  abortRunningTask,
  loadStore,
  saveStore,
  runHermesTask,
} from './store'

import {
  createFactoryService,
} from '../service'

function arg(
  name: string,
): string | undefined {
  const index =
    process.argv.indexOf(name)

  if (index < 0) {
    return undefined
  }

  return process.argv[
    index + 1
  ]
}

function listArg(
  name: string,
): string[] {
  const value =
    arg(name)

  if (!value) {
    return []
  }

  return value
    .split('|')
    .map(
      item => item.trim(),
    )
    .filter(Boolean)
}

async function submit(): Promise<void> {
  const objective =
    arg('--objective')

  if (!objective) {
    throw new Error(
      'Missing --objective',
    )
  }

  const requiredFiles =
    listArg(
      '--required-files',
    )

  const testCommands =
    listArg(
      '--tests',
    )

  const acceptanceCriteria =
    listArg(
      '--acceptance',
    )

  const task: EngineeringTask = {
    id:
      arg('--id') ??
      `hermes-${randomUUID()}`,

    workspace:
      arg('--workspace') ??
      process.cwd(),

    objective,

    role:
      arg('--role') ??
      'backend',

    stack:
      arg('--stack') ??
      'test workspace',

    constraints:
      listArg(
        '--constraints',
      ),

    acceptanceCriteria,

    modelRequirements: {
      capability:
        'coding',
    },

    acceptance:
      requiredFiles.length > 0
        ? {
            requiredFiles,
          }
        : undefined,

    verification:
      testCommands.length > 0
        ? {
            setupCommands: [],
            testCommands,
          }
        : undefined,
  }

  const now =
    new Date().toISOString()

  const store =
    await loadStore()

  const taskId =
    task.id

  // Same duplicate-id guard as store.submitTask (this CLI path inlines
  // submission): find-first lookups would otherwise execute stale records.
  if (
    store.tasks.some(
      item =>
        item.id ===
        taskId,
    )
  ) {
    throw new Error(
      `Task already exists: ${taskId}. Use retry to re-run it, or submit with a unique id.`,
    )
  }

  // Same workspace fail-fast as store.submitTask: never queue work with
  // nowhere to run (the executor would silently fall back to install root).
  try {
    const workspaceStat = await stat(task.workspace)
    if (!workspaceStat.isDirectory()) {
      throw new Error(`Task workspace is not a directory: ${task.workspace}`)
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Task workspace')) throw error
    throw new Error(`Task workspace does not exist: ${task.workspace}`)
  }

  const supervisor =
    arg('--supervised-by') ??
    'hermes-cli'

  store.tasks.push({
    id: taskId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    engineeringTask:
      task,
    supervisor,
    supervisedAt: now,
  })

  await saveStore(
    store,
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId: task.id,
        status: 'queued',
        supervisedBy: supervisor,
      },
      null,
      2,
    ),
  )
}

async function status(): Promise<void> {
  const taskId =
    arg('--id')

  if (!taskId) {
    throw new Error(
      'Missing --id',
    )
  }

  const store =
    await loadStore()

  const task =
    store.tasks.find(
      item =>
        item.id ===
        taskId,
    )

  if (!task) {
    throw new Error(
      `Task not found: ${taskId}`,
    )
  }

  const service =
    await createFactoryService()

  // The service is disposed as soon as it has answered (2026-11-07): its
  // skill filesystem watches every skill root it discovers, and those
  // watchers keep the event loop alive. A CLI that cannot exit is a CLI
  // nobody can use in a pipeline.
  try {
    const events =
      await service.events(
        task.engineeringTask.id,
      )

    const lastEvent =
      events.length > 0
        ? events[events.length - 1]
        : undefined

    console.log(
      JSON.stringify(
        {
          taskId: task.id,
          status: task.status,
          supervisedBy: task.supervisor ?? 'unknown',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          lastEvent: lastEvent
            ? {
                type: lastEvent.type,
                role: lastEvent.role,
                payload: lastEvent.payload,
                timestamp: lastEvent.timestamp,
              }
            : undefined,
          eventCount: events.length,
        },
        null,
        2,
      ),
    )
  } finally {
    await service.dispose()
  }
}

async function cancel(): Promise<void> {
  const taskId =
    arg('--id')

  if (!taskId) {
    throw new Error(
      'Missing --id',
    )
  }

  const store =
    await loadStore()

  const task =
    store.tasks.find(
      item =>
        item.id ===
        taskId,
    )

  if (!task) {
    throw new Error(
      `Task not found: ${taskId}`,
    )
  }

  if (
    task.status ===
      'completed' ||
    task.status ===
      'failed' ||
    task.status ===
      'cancelled'
  ) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          taskId,
          status:
            task.status,
          message:
            'Task is already terminal.',
        },
        null,
        2,
      ),
    )

    return
  }

  task.cancelRequested =
    true

  task.status =
    'cancelled'

  task.updatedAt =
    new Date().toISOString()

  await saveStore(
    store,
  )

  // V1.7: preempt an in-flight run in this process, if any. Cross-process
  // runs still stop at the next stage/repair boundary via the persisted
  // cancelRequested flag (post-run status mapping).
  const aborted =
    abortRunningTask(
      taskId,
    )

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        status: 'cancelled',
        cancelRequested: true,
        aborted,
      },
      null,
      2,
    ),
  )
}

async function run(): Promise<void> {
  const taskId = arg('--id')
  if (!taskId) throw new Error('Missing --id')

  const outcome = await runHermesTask(taskId)
  console.log(JSON.stringify({ ok: true, taskId, ...outcome }, null, 2))
}

async function events(): Promise<void> {
  const taskId =
    arg('--id')

  if (!taskId) {
    throw new Error(
      'Missing --id',
    )
  }

  const store =
    await loadStore()

  const task =
    store.tasks.find(
      item =>
        item.id ===
        taskId,
    )

  if (!task) {
    throw new Error(
      `Task not found: ${taskId}`,
    )
  }

  const service =
    await createFactoryService()

  // Disposed as soon as it has answered (2026-11-07) - see the status
  // command above.
  try {
    const events =
      await service.events(
        task.engineeringTask.id,
      )

    console.log(
      JSON.stringify(
        {
          taskId,
          supervisedBy: task.supervisor ?? 'unknown',
          eventCount: events.length,
          events,
        },
        null,
        2,
      ),
    )
  } finally {
    await service.dispose()
  }
}

async function result(): Promise<void> {
  const taskId = arg('--id')
  if (!taskId) throw new Error('Missing --id')
  const store = await loadStore()
  const task = store.tasks.find(item => item.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  console.log(JSON.stringify({
    taskId: task.id,
    status: task.status,
    result: task.result ?? null,
  }, null, 2))
}

async function list(): Promise<void> {
  const onlyStatus = arg('--status')
  const store = await loadStore()
  const tasks = store.tasks
    .filter(task => !onlyStatus || task.status === onlyStatus)
    .map(task => ({
      id: task.id,
      status: task.status,
      supervisor: task.supervisor ?? 'unknown',
      objective: task.engineeringTask.objective.slice(0, 120),
      updatedAt: task.updatedAt,
    }))
  console.log(JSON.stringify({ ok: true, count: tasks.length, tasks }, null, 2))
}

async function retry(): Promise<void> {
  const taskId =
    arg('--id')

  if (!taskId) {
    throw new Error(
      'Missing --id',
    )
  }

  const store =
    await loadStore()

  const task =
    store.tasks.find(
      item =>
        item.id ===
        taskId,
    )

  if (!task) {
    throw new Error(
      `Task not found: ${taskId}`,
    )
  }

  if (
    task.status !==
    'failed'
  ) {
    throw new Error(
      `Only failed tasks can be retried. Current status: ${task.status}`,
    )
  }

  task.status =
    'queued'

  task.cancelRequested =
    false

  task.result =
    undefined

  task.updatedAt =
    new Date().toISOString()

  await saveStore(
    store,
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        status: 'queued',
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const command =
    process.argv[2]

  switch (command) {
    case 'submit':
      await submit()
      break

    case 'status':
      await status()
      break

    case 'run':
      await run()
      break

    case 'cancel':
      await cancel()
      break

    case 'retry':
      await retry()
      break

    case 'events':
      await events()
      break

    case 'result':
      await result()
      break

    case 'list':
      await list()
      break

    default:
      console.log(`
Hermes

Commands:

  submit --objective "..."
         [--required-files "file1|file2"]
         [--tests "command1|command2"]
         [--acceptance "criterion1|criterion2"]
         [--constraints "constraint1|constraint2"]

  status --id <taskId>

  run --id <taskId>

  cancel --id <taskId>

  retry --id <taskId>

  events --id <taskId>

  result --id <taskId>

  list [--status queued|running|completed|failed|cancelled]
`)
  }
}

void main().catch(
  (
    error: unknown,
  ) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: redactSensitiveText(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        },
        null,
        2,
      ),
    )

    process.exitCode =
      1
  },
).finally(() => {
  // The undisposed cordis Context inside createFactoryService()
  // keeps the event loop alive; exit explicitly at the CLI boundary.
  process.exit(process.exitCode ?? 0)
})
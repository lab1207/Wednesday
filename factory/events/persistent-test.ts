import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PersistentFactoryEventBus,
} from './persistent'

const directory = mkdtempSync(join(tmpdir(), 'factory-events-test-'))
const FILE = join(directory, 'test-events.jsonl')

async function main(): Promise<void> {

  const writer =
    new PersistentFactoryEventBus({
      filePath: FILE,
    })

  await writer.emit(
    'task.started',
    'persistent-test-001',
    {
      source: 'test',
    },
  )

  await writer.emit(
    'agent.started',
    'persistent-test-001',
    {
      role: 'coder',
    },
    'coder',
  )

  await writer.emit(
    'task.completed',
    'persistent-test-001',
    {
      status: 'completed',
    },
  )

  const reader =
    new PersistentFactoryEventBus({
      filePath: FILE,
    })

  const events =
    await reader.list(
      'persistent-test-001',
    )

  if (events.length !== 3) {
    throw new Error(
      `Expected 3 events, got ${events.length}`,
    )
  }

  if (
    events[0].type !==
    'task.started'
  ) {
    throw new Error(
      'First event is not task.started',
    )
  }

  if (
    events[2].type !==
    'task.completed'
  ) {
    throw new Error(
      'Last event is not task.completed',
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        file: FILE,
        eventCount:
          events.length,
        events,
      },
      null,
      2,
    ),
  )
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
).finally(() => {
  rmSync(directory, { recursive: true, force: true })
})
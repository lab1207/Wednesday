import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

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

  // ------------------------------------------------------------------
  // A TORN LINE MUST NOT TAKE THE HISTORY WITH IT (2026-11-07).
  //
  // The log is append-only, so the only way to lose a line is a writer
  // that died mid-write. The first full sweep of this session killed a
  // hung test with SIGKILL while it was appending, and the operator's
  // own log grew a 2,566-byte run of NUL bytes. The old reader THREW on
  // that line, so one torn line made all 8,292 good lines unreadable
  // and `/events` crashed.
  //
  // The reader now skips what it cannot read and COUNTS it: the good
  // events survive, and the loss is visible instead of fatal.
  // ------------------------------------------------------------------
  {
    const tornFile =
      join(directory, 'torn-events.jsonl')

    const good =
      JSON.stringify({
        id: 'good-1',
        type: 'task.started',
        taskId: 'torn-test-001',
        timestamp:
          '2026-11-07T00:00:00.000Z',
        payload: {
          source: 'test',
        },
      })

    const goodAfter =
      JSON.stringify({
        id: 'good-2',
        type: 'task.completed',
        taskId: 'torn-test-001',
        timestamp:
          '2026-11-07T00:00:01.000Z',
        payload: {
          status: 'completed',
        },
      })

    // A killed writer: the file was extended, the bytes never landed.
    const torn =
      '\u0000'.repeat(64)

    // A line that parses but is not an event.
    const notAnEvent =
      '{"hello":"world"}'

    writeFileSync(
      tornFile,
      [
        good,
        torn,
        notAnEvent,
        goodAfter,
        '',
      ].join('\n'),
      'utf8',
    )

    const reader =
      new PersistentFactoryEventBus({
        filePath: tornFile,
      })

    const report =
      await reader.read()

    assert.equal(
      report.events.length,
      2,
      'the two good events must survive the torn line',
    )
    assert.equal(
      report.damaged,
      2,
      'the torn line and the non-event line must be counted, not hidden',
    )
    assert.equal(
      report.events[0].id,
      'good-1',
    )
    assert.equal(
      report.events[1].id,
      'good-2',
    )

    // The plain list is the same events - and it must NOT throw.
    const listed =
      await reader.list()

    assert.equal(
      listed.length,
      2,
      'list() must survive a torn line',
    )

    // The task filter still works on a damaged log.
    const filtered =
      await reader.list(
        'torn-test-001',
      )

    assert.equal(
      filtered.length,
      2,
    )

    console.log(
      'PERSISTENT EVENT BUS TEST: PASS (append, read, and a torn line does not take the history with it)',
    )
  }
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
).finally(() => {
  rmSync(directory, { recursive: true, force: true })
})
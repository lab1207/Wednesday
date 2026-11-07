import {
  appendFile,
  mkdir,
  readFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  randomUUID,
} from 'node:crypto'

import type {
  FactoryEvent,
  FactoryEventReader,
  FactoryEventSink,
  FactoryEventType,
} from './types'

export interface PersistentFactoryEventBusOptions {
  filePath: string
}

/**
 * What the log actually holds, including what it could NOT hold.
 *
 * `damaged` counts the lines that could not be read. That number is the
 * honest answer to "is the history complete?" — a torn line is data the
 * factory lost, and hiding it behind a silently shorter list would make
 * the loss invisible.
 */
export interface EventLogReport {
  events: FactoryEvent[]
  damaged: number
}

/**
 * Read one line as an event, or say it cannot be read.
 *
 * A line is damaged when it does not parse as JSON, or when it parses into
 * something that is not an event (no id, no type, no taskId, no
 * timestamp). Both shapes happen in the wild: a killed writer leaves a
 * half-written line, and an old log can hold a line from a version that
 * wrote something else.
 */
function parseEventLine(
  line: string,
): FactoryEvent | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }

  if (
    parsed === null ||
    typeof parsed !== 'object'
  ) {
    return undefined
  }

  const candidate =
    parsed as Partial<FactoryEvent>

  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.taskId !== 'string' ||
    typeof candidate.timestamp !== 'string'
  ) {
    return undefined
  }

  return candidate as FactoryEvent
}

export class PersistentFactoryEventBus
  implements
    FactoryEventSink,
    FactoryEventReader {
  private readonly filePath: string

  // D1 scale: parallel lanes share one bus. Appends are chained so
  // concurrent lanes can never interleave bytes inside one JSON line.
  // The chain links never reject (released in `finally`), so one
  // failed write cannot stall later lanes.
  private writeChain: Promise<void> =
    Promise.resolve()

  constructor(
    options: PersistentFactoryEventBusOptions,
  ) {
    this.filePath =
      options.filePath
  }

  async publish(
    event: FactoryEvent,
  ): Promise<void> {
    const line =
      JSON.stringify(event) + '\n'

    const previous =
      this.writeChain

    let release!: () => void

    this.writeChain =
      new Promise<void>(
        resolve => {
          release = resolve
        },
      )

    await previous

    try {
      await mkdir(
        dirname(this.filePath),
        {
          recursive: true,
        },
      )

      await appendFile(
        this.filePath,
        line,
        'utf8',
      )
    } finally {
      release()
    }
  }

  async emit(
    type: FactoryEventType,
    taskId: string,
    payload: Record<string, unknown> = {},
    role?: string,
  ): Promise<FactoryEvent> {
    const event: FactoryEvent = {
      id: randomUUID(),
      type,
      taskId,
      timestamp:
        new Date().toISOString(),
      role,
      payload,
    }

    await this.publish(event)

    return event
  }

  /**
   * Read the log, and say how much of it is unreadable.
   *
   * WHY THIS IS TOLERANT (2026-11-07, operator report).
   *
   * The log is append-only, so the only way to lose a line is a writer
   * that died mid-write. That happens for real: the first full test
   * sweep of this session killed a hung test with SIGKILL while it was
   * appending, and the operator's own event log grew a 2,566-byte run of
   * NUL bytes - the file was extended, the bytes were never written.
   *
   * The old reader THREW on that line. One torn line made the ENTIRE
   * history unreadable: `/events` crashed, every consumer of the log
   * failed, and the factory looked broken even though 8,292 good lines
   * were sitting right there. A crash must not cost the operator the
   * history that survived it.
   *
   * So the reader skips what it cannot read, COUNTS it, and hands both
   * back. The good events are still good events; the loss is visible
   * instead of fatal.
   */
  async read(
    taskId?: string,
  ): Promise<EventLogReport> {
    let raw = ''

    try {
      raw =
        await readFile(
          this.filePath,
          'utf8',
        )
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error
          ? String(
              (
                error as {
                  code?: unknown
                }
              ).code,
            )
          : ''

      if (code === 'ENOENT') {
        return {
          events: [],
          damaged: 0,
        }
      }

      throw error
    }

    const events: FactoryEvent[] = []
    let damaged = 0

    for (
      const line of
        raw.split(/\r?\n/)
    ) {
      const trimmed =
        line.trim()

      if (!trimmed) {
        continue
      }

      const event =
        parseEventLine(trimmed)

      if (event === undefined) {
        damaged += 1
        continue
      }

      if (
        taskId === undefined ||
        event.taskId === taskId
      ) {
        events.push(event)
      }
    }

    return {
      events,
      damaged,
    }
  }

  async list(
    taskId?: string,
  ): Promise<FactoryEvent[]> {
    const report =
      await this.read(taskId)

    return report.events
  }
}
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

  async list(
    taskId?: string,
  ): Promise<FactoryEvent[]> {
    try {
      const raw =
        await readFile(
          this.filePath,
          'utf8',
        )

      return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line =>
          JSON.parse(
            line,
          ) as FactoryEvent,
        )
        .filter(
          event =>
            taskId === undefined ||
            event.taskId === taskId,
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
        return []
      }

      throw error
    }
  }
}
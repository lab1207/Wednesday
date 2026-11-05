import { randomUUID } from 'node:crypto'
import type {
  FactoryEvent,
  FactoryEventReader,
  FactoryEventSink,
  FactoryEventType,
} from './types'

export class InMemoryFactoryEventBus
  implements
    FactoryEventSink,
    FactoryEventReader {
  private readonly events: FactoryEvent[] = []

  async publish(
    event: FactoryEvent,
  ): Promise<void> {
    this.events.push(event)
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
      timestamp: new Date().toISOString(),
      role,
      payload,
    }

    await this.publish(event)

    return event
  }

  async list(
    taskId?: string,
  ): Promise<FactoryEvent[]> {
    const result =
      taskId === undefined
        ? this.events
        : this.events.filter(
            event =>
              event.taskId === taskId,
          )

    return result.map(
      event => ({
        ...event,
        payload: event.payload
          ? { ...event.payload }
          : undefined,
      }),
    )
  }

  clear(): void {
    this.events.length = 0
  }
}
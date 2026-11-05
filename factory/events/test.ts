import {
  InMemoryFactoryEventBus,
} from './bus'

async function main(): Promise<void> {
  const bus =
    new InMemoryFactoryEventBus()

  await bus.emit(
    'task.created',
    'event-test-001',
    {
      title:
        'Event bus smoke test',
    },
  )

  await bus.emit(
    'task.started',
    'event-test-001',
  )

  await bus.emit(
    'agent.started',
    'event-test-001',
    {
      role: 'coder',
    },
    'coder',
  )

  await bus.emit(
    'agent.completed',
    'event-test-001',
    {
      role: 'coder',
      status: 'completed',
    },
    'coder',
  )

  await bus.emit(
    'task.completed',
    'event-test-001',
    {
      status: 'completed',
    },
  )

  const events =
    await bus.list(
      'event-test-001',
    )

  if (events.length !== 5) {
    throw new Error(
      `Expected 5 events, got ${events.length}`,
    )
  }

  const types =
    events.map(
      event => event.type,
    )

  const expected = [
    'task.created',
    'task.started',
    'agent.started',
    'agent.completed',
    'task.completed',
  ]

  if (
    JSON.stringify(types) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      `Unexpected event sequence: ${types.join(', ')}`,
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId:
          'event-test-001',
        count:
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
)
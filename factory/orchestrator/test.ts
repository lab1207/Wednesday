import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
} from './index'

import type {
  AgentRunner,
} from './types'

import type {
  AgentContext,
  AgentOutput,
  AgentRole,
} from '../agents/types'

import type {
  EngineeringTask,
} from '../contracts'

import {
  InMemoryFactoryEventBus,
} from '../events'

class RecordingRunner
  implements AgentRunner {
  constructor(
    private readonly label:
      string,

    private readonly calls:
      string[],
  ) {}

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    this.calls.push(
      `${this.label}:${role.id}`,
    )

    // Live activity: a seat reports what it is doing while it does it. The
    // orchestrator turns this into an `agent.activity` event, so the operator
    // sees the seat work instead of a spinner (operator, 2026-11-04).
    context.reportActivity?.({
      kind: 'reasoning',
      text: `${role.id} is thinking about the task`,
    })
    context.reportActivity?.({
      kind: 'tool',
      tool: 'read_file',
      detail: 'src/index.ts',
      status: 'completed',
    })

    const output: AgentOutput = {
      role:
        role.id,

      summary:
        `${this.label} handled ${role.id}`,

      findings: [
        `Runner selected: ${this.label}`,
      ],

      recommendations: [],

      blockingIssues: [],
    }

    if (
      role.id ===
      'reviewer'
    ) {
      output.review = {
        verdict:
          'pass',

        summary:
          'Recording reviewer accepted the test task.',

        findings: [
          'Dispatcher routing verified.',
        ],

        requiredChanges: [],

        evidence: [
          'Recording reviewer returned structured pass output.',
        ],
      }
    }

    return output
  }
}

async function main(): Promise<void> {
  const calls:
    string[] =
    []

  const analysisRunner =
    new RecordingRunner(
      'analysis',
      calls,
    )

  const codingRunner =
    new RecordingRunner(
      'coding',
      calls,
    )

  const testingRunner =
    new RecordingRunner(
      'testing',
      calls,
    )

  const reviewRunner =
    new RecordingRunner(
      'review',
      calls,
    )

  const dispatcher =
    new DefaultRoleRunnerDispatcher(
      new Map([
        [
          'architect',
          analysisRunner,
        ],
        [
          'planner',
          analysisRunner,
        ],
        [
          'coder',
          codingRunner,
        ],
        [
          'tester',
          testingRunner,
        ],
        [
          'reviewer',
          reviewRunner,
        ],
      ]),
    )

  const task:
    EngineeringTask = {
    id:
      'dispatcher-test-001',

    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),

    objective:
      'Test role-aware dispatch.',

    role:
      'backend',

    stack:
      'python',

    constraints: [],

    acceptanceCriteria: [
      'Each role is sent to its correct runner.',
    ],
  }

  const eventBus =
    new InMemoryFactoryEventBus()

  const orchestrator =
    new FactoryOrchestrator(
      undefined,
      dispatcher,
      {
        eventSink:
          eventBus,
      },
    )

  const result =
    await orchestrator.run(
      task,
    )

  console.log(
    JSON.stringify(
      {
        calls,
        result,
      },
      null,
      2,
    ),
  )

  const expectedCalls = [
    'analysis:architect',
    'analysis:planner',
    'coding:coder',
    'testing:tester',
    'review:reviewer',
  ]

  if (
    JSON.stringify(
      calls,
    ) !==
    JSON.stringify(
      expectedCalls,
    )
  ) {
    throw new Error(
      `Unexpected dispatch calls.\nExpected: ${JSON.stringify(
        expectedCalls,
      )}\nActual: ${JSON.stringify(
        calls,
      )}`,
    )
  }

  if (
    result.status !==
    'completed'
  ) {
    throw new Error(
      `Dispatcher test failed with status: ${result.status}`,
    )
  }

  const eventTypes =
    (
      await eventBus.list(
        task.id,
      )
    ).map(
      event =>
        event.type,
    )

  const expectedEventTypes = [
    'task.created',
    'task.started',
    'agent.started',
    'agent.activity',
    'agent.activity',
    'agent.completed',
    'agent.started',
    'agent.activity',
    'agent.activity',
    'agent.completed',
    'agent.started',
    'agent.activity',
    'agent.activity',
    'agent.completed',
    'verification.started',
    'agent.activity',
    'agent.activity',
    'verification.completed',
    'review.started',
    'agent.activity',
    'agent.activity',
    'review.completed',
    'task.completed',
  ]

  if (
    JSON.stringify(
      eventTypes,
    ) !==
    JSON.stringify(
      expectedEventTypes,
    )
  ) {
    throw new Error(
      `Unexpected event sequence.\nExpected: ${JSON.stringify(
        expectedEventTypes,
      )}\nActual: ${JSON.stringify(
        eventTypes,
      )}`,
    )
  }

  // The activity events carry the seat and the piece: the bus is the only
  // channel between a working seat and the operator's screen.
  const activityEvents = (
    await eventBus.list(
      task.id,
    )
  ).filter(
    event =>
      event.type ===
      'agent.activity',
  )

  if (
    activityEvents.length !==
      expectedEventTypes.filter(
        type =>
          type ===
          'agent.activity',
      ).length
  ) {
    throw new Error(
      `Expected one activity event per seat, got ${activityEvents.length}.`,
    )
  }

  const reasoning =
    activityEvents.find(
      event =>
        event.payload?.kind ===
        'reasoning',
    )

  if (
    reasoning === undefined ||
    reasoning.role ===
      undefined ||
    typeof reasoning.payload?.text !==
      'string'
  ) {
    throw new Error(
      'An activity event must name the seat and carry the piece.',
    )
  }

  const tool =
    activityEvents.find(
      event =>
        event.payload?.kind ===
        'tool',
    )

  if (
    tool === undefined ||
    tool.payload?.tool !==
      'read_file' ||
    tool.payload?.detail !==
      'src/index.ts'
  ) {
    throw new Error(
      'A tool activity must name the tool and what it touched.',
    )
  }

  console.log(
    'ORCHESTRATOR DISPATCH TEST: PASS',
  )
}

void main().catch(
  (
    error: unknown,
  ) => {
    console.error(
      error,
    )

    process.exitCode =
      1
  },
)
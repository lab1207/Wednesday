/**
 * Offline test for the reviewer's JSON salvage, the recorded parse failure
 * and the crew seat pins.
 *
 * The reviewer used to drop a verdict on the floor when a small model
 * answered with a markdown fence, with single quotes, or with prose around
 * the payload: the seat went mute and nobody could say why. These
 * assertions cover the salvage path, the recorded reason, the seat
 * attribution and the per-seat model pins.
 *
 * Offline by construction: no network, no model, no clock, no files.
 */
import assert from 'node:assert/strict'

import {
  describeJsonFailure,
  parseJsonLoose,
} from '../model-router/json-repair'

import {
  seatModelPin,
} from '../model-router/crew-routing'

import {
  RegistryModelRouter,
} from '../model-router'

import type {
  CompletionHooks,
  CompletionOptions,
  ModelProvider,
  ModelRequirements,
} from '../model-router/types'

import {
  parseReviewerOutcome,
  ReviewRunner,
} from './role-runners'

import {
  AgentRegistry,
} from './registry'

import type {
  AgentContext,
} from './types'

/**
 * A provider that answers with a fixed string and remembers the seat the
 * router attributed the call to.
 */
class CapturingProvider
  implements ModelProvider {
  readonly name = 'capturing'

  seat: string | undefined

  constructor(
    private readonly answer: string,
  ) {}

  supports(
    _requirements: ModelRequirements,
  ): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    return ['capturing-v1']
  }

  async complete(
    _model: string,
    _prompt: string,
    _images?: string[],
    _hooks?: CompletionHooks,
    options?: CompletionOptions,
  ): Promise<string> {
    this.seat = options?.seat
    return this.answer
  }
}

function reviewerContext(): AgentContext {
  return {
    task: {
      id: 'role-runners-json-test-001',
      workspace: '.',
      objective: 'Prove the reviewer seat is heard.',
      role: 'backend',
      stack: 'typescript',
      constraints: [],
      acceptanceCriteria: [
        'The reviewer verdict survives the parse.',
      ],
    },
    workspace: '.',
    previousOutputs: [],
  }
}

async function main(): Promise<void> {
  // The module imports cleanly (a broken import throws before main runs).
  assert.equal(
    typeof parseReviewerOutcome,
    'function',
  )

  // The shared salvage helper recovers the shapes a small model emits.
  const fenced =
    parseJsonLoose<{ verdict: string }>(
      '```json\n{"verdict":"pass","summary":"fenced"}\n```',
    )
  assert.equal(fenced?.verdict, 'pass')

  const single =
    parseJsonLoose<{ verdict: string }>(
      "{'verdict':'fail','summary':'single quoted'}",
    )
  assert.equal(single?.verdict, 'fail')

  const prose =
    parseJsonLoose<{ verdict: string }>(
      'Here is my verdict: {"verdict":"pass","summary":"wrapped"} - hope that helps.',
    )
  assert.equal(prose?.verdict, 'pass')

  // Garbage still gets a reason, never a shrug.
  const garbageReason =
    describeJsonFailure(
      'I refuse to answer.',
    )
  assert.ok(garbageReason.length > 0)
  assert.match(
    garbageReason,
    /no JSON object found/,
  )

  // The strict path is unchanged for a well-formed answer.
  const strict =
    parseReviewerOutcome(
      '{"verdict":"pass","summary":"ok","findings":["a"],"requiredChanges":[],"evidence":["e"]}',
    )
  assert.deepEqual(
    strict.review,
    {
      verdict: 'pass',
      summary: 'ok',
      findings: ['a'],
      requiredChanges: [],
      evidence: ['e'],
    },
  )
  assert.equal(strict.failure, undefined)

  // The reviewer parser salvages what the strict path drops.
  const salvaged =
    parseReviewerOutcome(
      "My verdict:\n{'verdict': 'fail', 'summary': 'broken', 'requiredChanges': ['fix the parser']}",
    )
  assert.equal(salvaged.review?.verdict, 'fail')
  assert.deepEqual(
    salvaged.review?.requiredChanges,
    ['fix the parser'],
  )
  assert.equal(salvaged.failure, undefined)

  // A total failure keeps the null-ish verdict AND records the reason.
  const garbage =
    parseReviewerOutcome(
      'I cannot decide.',
    )
  assert.equal(garbage.review, undefined)
  assert.ok((garbage.failure ?? '').length > 0)
  assert.match(
    garbage.failure ?? '',
    /no JSON object found/,
  )

  const empty =
    parseReviewerOutcome('')
  assert.equal(empty.review, undefined)
  assert.match(
    empty.failure ?? '',
    /empty model response/,
  )

  // The seat pins: the reviewer's own model wins, the coder slot is the
  // legacy fallback, and the tester seat behaves the same way.
  assert.equal(
    seatModelPin(
      'reviewer',
      {
        FACTORY_CREW_REVIEWER_MODEL: 'reviewer-model',
        FACTORY_CREW_CODER_MODEL: 'coder-model',
      } as NodeJS.ProcessEnv,
    ),
    'reviewer-model',
  )

  assert.equal(
    seatModelPin(
      'reviewer',
      {
        FACTORY_CREW_CODER_MODEL: 'coder-model',
      } as NodeJS.ProcessEnv,
    ),
    'coder-model',
  )

  assert.equal(
    seatModelPin(
      'tester',
      {
        FACTORY_CREW_TESTER_MODEL: 'tester-model',
        FACTORY_CREW_CODER_MODEL: 'coder-model',
      } as NodeJS.ProcessEnv,
    ),
    'tester-model',
  )

  assert.equal(
    seatModelPin(
      'tester',
      {
        FACTORY_CREW_CODER_MODEL: 'coder-model',
      } as NodeJS.ProcessEnv,
    ),
    'coder-model',
  )

  // End to end: the reviewer seat is HEARD (salvaged verdict) and the
  // tokens are attributed to the reviewer seat.
  const registry = new AgentRegistry()
  const reviewer = registry.get('reviewer')

  const salvageProvider =
    new CapturingProvider(
      "Here is my verdict:\n{'verdict': 'pass', 'summary': 'salvaged', 'findings': [], 'requiredChanges': [], 'evidence': []}",
    )
  const salvageRouter = new RegistryModelRouter()
  salvageRouter.register(salvageProvider)

  const salvageResult =
    await new ReviewRunner(salvageRouter).run(
      reviewer,
      reviewerContext(),
    )
  assert.equal(salvageResult.review?.verdict, 'pass')
  assert.equal(salvageProvider.seat, 'reviewer')

  // End to end: a mute reviewer says WHY it was mute.
  const muteProvider =
    new CapturingProvider(
      'I am not answering today.',
    )
  const muteRouter = new RegistryModelRouter()
  muteRouter.register(muteProvider)

  const muteResult =
    await new ReviewRunner(muteRouter).run(
      reviewer,
      reviewerContext(),
    )
  assert.equal(muteResult.review, undefined)
  assert.equal(muteProvider.seat, 'reviewer')
  assert.ok((muteResult.blockingIssues ?? []).length > 0)
  assert.match(
    muteResult.blockingIssues?.[0] ?? '',
    /no JSON object found/,
  )

  console.log('role-runners-json: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

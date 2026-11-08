/**
 * The chat MoA runner, with the network mocked out.
 *
 * Two claims, and the second is the one that separates this from the pasted
 * reference implementation:
 *
 *   1. Every teammate is asked on its OWN route, and the aggregator sees each
 *      answer attributed by seat and model.
 *   2. A dead teammate does NOT kill the run. The pasted code's
 *      `asyncio.gather` would reject on the first failure and discard every
 *      answer the others produced.
 */
import assert from 'node:assert/strict'

import { describeChatMoa, runChatMoa } from './chat-moa'

type Complete = NonNullable<Parameters<typeof runChatMoa>[0]['complete']>

const answers: Record<string, string> = {
  'coder-model': 'here is the code',
  'reviewer-model': 'here is the review',
}
const failing = new Set(['dead-model', 'dead-agg'])

/** A completer that answers per model, and can fail on demand. */
const fake: Complete = (async (
  route: { name: string; model: string },
  messages: Array<{ role: string; content: string }>,
) => {
  // The failure check comes FIRST: a dead model fails whatever it was asked,
  // including as the aggregator.
  if (failing.has(route.model)) {
    throw new Error(`${route.model} is on a dead box`)
  }
  const last = messages[messages.length - 1]?.content ?? ''
  if (last.includes('Teammate Responses:')) {
    const live = [...last.matchAll(/--- ([^(]+) \(([^)]+)\) ---\n(?!FAILED)/g)]
      .map(m => m[1].trim())
    return {
      text: `AGGREGATE of ${live.join(' + ')}`,
      usage: undefined,
    } as never
  }
  return {
    text: answers[route.model] ?? `answer from ${route.model}`,
    usage: undefined,
  } as never
}) as Complete

const routeFor = (name: string, model: string) =>
  ({ name, baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model }) as never

async function main(): Promise<void> {
  // 1. Every teammate asked on its own route; the aggregate names them.
  {
    const seen: string[] = []
    const complete: Complete = (async (route, messages) => {
      seen.push(`${route.name}/${route.model}`)
      return fake(route, messages)
    }) as Complete

    const result = await runChatMoa({
      question: 'build me website',
      team: [
        { seat: 'coder', route: routeFor('local', 'coder-model') },
        { seat: 'reviewer', route: routeFor('local', 'reviewer-model') },
      ],
      aggregator: routeFor('local', 'aggregator-model'),
      complete,
    })

    assert.equal(result.failure, undefined, 'a full team is not a failure')
    assert.equal(result.proposers.length, 2, 'both teammates were asked')
    assert.ok(
      result.proposers.every(p => p.ok),
      'and both answered',
    )
    assert.ok(
      result.answer.includes('coder') && result.answer.includes('reviewer'),
      'the aggregate names the teammates that answered',
    )
    assert.deepEqual(
      seen,
      ['local/coder-model', 'local/reviewer-model', 'local/aggregator-model'],
      'each teammate speaks on its own route, then the aggregator once: ' +
        seen.join(', '),
    )
    assert.equal(
      describeChatMoa(result),
      'team coder + reviewer (2/2 answered) -> local/aggregator-model',
      'the receipt names the team and the aggregator',
    )
  }

  // 2. THE ONE THAT MATTERS: a dead teammate does not kill the run.
  {
    const result = await runChatMoa({
      question: 'fix the login leak',
      team: [
        { seat: 'coder', route: routeFor('local', 'coder-model') },
        { seat: 'reviewer', route: routeFor('local', 'dead-model') },
      ],
      aggregator: routeFor('local', 'aggregator-model'),
      complete: fake,
    })

    assert.equal(
      result.proposers.filter(p => p.ok).length,
      1,
      'the live teammate still answered',
    )
    const dead = result.proposers.find(p => p.model === 'dead-model')
    assert.ok(dead && !dead.ok, 'the dead one is recorded, not hidden')
    assert.ok(
      dead.reason && dead.reason.includes('dead box'),
      'with the reason: ' + String(dead.reason),
    )
    assert.ok(
      result.answer.includes('coder'),
      'the aggregate of what worked still ships',
    )
    assert.equal(result.failure, undefined, 'a partial team is not a failure')
    assert.ok(
      describeChatMoa(result).includes('(1/2 answered)'),
      'the receipt says what it cost: ' + describeChatMoa(result),
    )
  }

  // 2b. A dead aggregator is a reason, not a crash.
  {
    const result = await runChatMoa({
      question: 'q',
      team: [{ seat: 'coder', route: routeFor('local', 'coder-model') }],
      aggregator: routeFor('local', 'dead-agg'),
      complete: fake,
    })
    assert.equal(result.answer, '')
    assert.ok(
      result.failure && result.failure.includes('aggregator failed'),
      'the aggregator failure is named: ' + String(result.failure),
    )
    assert.equal(result.proposers[0].ok, true, 'the teammate still ran')
  }

  // 2c. Every teammate dead: nothing to aggregate, and the reasons are named.
  {
    const result = await runChatMoa({
      question: 'q',
      team: [
        { seat: 'coder', route: routeFor('local', 'dead-model') },
        { seat: 'reviewer', route: routeFor('local', 'dead-model') },
      ],
      aggregator: routeFor('local', 'aggregator-model'),
      complete: fake,
    })
    assert.equal(result.answer, '')
    assert.ok(
      result.failure && result.failure.includes('nothing to aggregate'),
      String(result.failure),
    )
    assert.ok(
      result.failure && result.failure.includes('dead box'),
      'and it names the reason, not just that: ' + String(result.failure),
    )
  }

  console.log('chat-moa: PASS')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

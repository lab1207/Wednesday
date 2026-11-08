/**
 * The MoA runner, tested without a network.
 *
 * Four claims, and the third is the one the pasted reference implementation
 * does not survive:
 *
 *   1. Every proposer is asked, and the aggregator's prompt names each one by
 *      seat and model — so it can disagree with a specific teammate.
 *   2. A failed proposer does NOT kill the run: the rest are still
 *      aggregated. (The pasted code's `asyncio.gather` would reject on the
 *      first failure and discard every answer the others produced.)
 *   3. A FAILED proposer is named as failed in the aggregator's prompt,
 *      never silently omitted — an aggregator that sees fewer answers than
 *      were asked for would synthesise confidence nobody earned.
 *   4. An empty or failing aggregator is a result with a reason, never a
 *      crash and never a blank answer that looks like a real one.
 */
import assert from 'node:assert/strict'

import {
  MOA_AGGREGATOR_SYSTEM,
  buildAggregatorPrompt,
  describeMoa,
  runMoa,
} from './moa'

import type { ModelProvider } from '../model-router/types'

type Complete = ModelProvider['complete']

/** A provider that answers per-model, and can fail on demand. */
function fakeProvider(answers: Record<string, string>, failing: string[] = []): Complete {
  const seen: string[] = []
  const complete: Complete = (async (model: string, prompt: string) => {
    seen.push(model)
    if (failing.includes(model)) {
      throw new Error(`${model} is on a dead box`)
    }
    // The aggregator is recognisable by its prompt carrying the teammates.
    if (prompt.includes('Teammate Responses:')) {
      // A real aggregator reads the whole block, so it can tell a live
      // teammate from a FAILED one. This fake only lists the live ones, so
      // the test can prove the prompt supplies that signal.
      const live = [...prompt.matchAll(/--- ([^(]+) \(([^)]+)\) ---\n(?!FAILED)/g)]
        .map(m => m[1].trim())
      const failed = [...prompt.matchAll(/--- ([^(]+) \([^)]+\) --- FAILED/g)]
        .map(m => m[1].trim())
      return `AGGREGATE of ${live.join(' + ')}${failed.length > 0 ? `; omitted ${failed.join(', ')}` : ''}`
    }
    return answers[model] ?? `answer from ${model}`
  }) as Complete
  return complete
}

async function main(): Promise<void> {
  // 1. The aggregator's prompt names each teammate by seat and model.
  {
    const results = [
      { model: 'proposer-a', seat: 'architect', ok: true, text: 'plan A' },
      { model: 'proposer-b', seat: 'coder', ok: true, text: 'code B' },
    ]
    const prompt = buildAggregatorPrompt('build me website', results)
    assert.ok(
      prompt.startsWith('Original Question: build me website'),
      'the question leads: ' + prompt.slice(0, 60),
    )
    assert.ok(
      prompt.includes('--- architect (proposer-a) ---') &&
        prompt.includes('--- coder (proposer-b) ---'),
      'each teammate is attributed by seat AND model',
    )
    assert.ok(prompt.includes('Teammate Responses:'), 'the operator\'s shape')
    // The operator's instruction is exported verbatim for the caller to use.
    assert.ok(
      MOA_AGGREGATOR_SYSTEM.startsWith('You are the master aggregator.'),
      'the aggregator instruction is the operator\'s',
    )
  }

  // 2. THE ONE THAT MATTERS: a dead proposer does not kill the run.
  {
    const result = await runMoa({
      question: 'fix the login leak',
      proposers: [
        { model: 'alive-1', seat: 'coder' },
        { model: 'dead-1', seat: 'reviewer' },
        { model: 'alive-2', seat: 'tester' },
      ],
      aggregator: 'aggregator-1',
      complete: fakeProvider({}, ['dead-1']),
    })

    assert.equal(
      result.proposers.filter(p => p.ok).length,
      2,
      'the two live proposers still answered',
    )
    const dead = result.proposers.find(p => p.model === 'dead-1')
    assert.ok(dead && !dead.ok, 'the dead one is recorded as failed')
    assert.ok(
      dead.reason && dead.reason.includes('dead box'),
      'and it says why: ' + String(dead.reason),
    )
    assert.ok(
      result.answer.includes('coder') && result.answer.includes('tester'),
      'the aggregate names the teammates that actually answered',
    )
    assert.ok(
      result.answer.includes('omitted reviewer'),
      'and it can tell the failed one apart — the prompt labelled it FAILED',
    )
    assert.equal(result.failure, undefined, 'a partial team is not a failure')
    assert.equal(
      describeMoa(result),
      'aggregated 2/3 proposers by aggregator-1 · 1 FAILED',
      'the receipt says what it cost',
    )
  }

  // 3. A failed proposer is NAMED in the aggregator's prompt.
  {
    const prompt = buildAggregatorPrompt('q', [
      { model: 'a', seat: 'coder', ok: true, text: 'yes' },
      { model: 'b', seat: 'reviewer', ok: false, text: '', reason: 'timeout' },
    ])
    assert.ok(
      prompt.includes('--- reviewer (b) --- FAILED: timeout'),
      'a failed teammate is named as failed, never omitted: ' + prompt,
    )
  }

  // 4. A dead aggregator is a reason, not a crash or a blank answer.
  {
    const deadAgg = await runMoa({
      question: 'q',
      proposers: [{ model: 'a', seat: 'coder' }],
      aggregator: 'dead-aggregator',
      complete: fakeProvider({}, ['dead-aggregator']),
    })
    assert.equal(deadAgg.answer, '', 'no answer when the aggregator is dead')
    assert.ok(
      deadAgg.failure && deadAgg.failure.includes('aggregator failed'),
      'and the reason is named: ' + String(deadAgg.failure),
    )
    assert.equal(deadAgg.proposers[0].ok, true, 'the proposer still ran')
  }

  // 4b. Every proposer dead: nothing to aggregate, and that is said — with
  //     the reasons, so an empty answer is not mistaken for a routing bug.
  {
    const allDead = await runMoa({
      question: 'q',
      proposers: [{ model: 'a', seat: 'coder' }],
      aggregator: 'agg',
      complete: fakeProvider({}, ['a']),
    })
    assert.equal(allDead.answer, '')
    assert.ok(
      allDead.failure && allDead.failure.includes('nothing to aggregate'),
      'the honest failure: ' + String(allDead.failure),
    )
    assert.ok(
      allDead.failure && allDead.failure.includes('dead box'),
      'and it names the reason: ' + String(allDead.failure),
    )
  }

  // 4c. An empty proposer answer is a failure, and the reason says so.
  {
    const empty: Complete = (async () => '   ') as Complete
    const blank = await runMoa({
      question: 'q',
      proposers: [{ model: 'a', seat: 'coder' }],
      aggregator: 'agg',
      complete: empty,
    })
    assert.equal(blank.answer, '')
    assert.ok(
      blank.failure && blank.failure.includes('empty answer'),
      'a blank proposer answer is reported as blank: ' + String(blank.failure),
    )
  }

  console.log('moa: PASS')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

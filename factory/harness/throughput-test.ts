/**
 * Live throughput (2026-11-07).
 *
 * WHY THIS TEST EXISTS: OpenCode's footer carries a tokens/sec readout, and
 * for a product built on SMALL open models it is the most honest engagement
 * signal there is -- a spinner says "something is happening", a rate says
 * "the model is producing 34 tokens a second".
 *
 * The number is an ESTIMATE (the factory has no tokenizer for the served
 * model), and the whole point of these assertions is that it is labelled as
 * one. A number that looks measured and is not is the same class of lie the
 * operator reported elsewhere.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point state home at a temp dir before importing the module.
const stateHome = mkdtempSync(join(tmpdir(), 'wed-throughput-state-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const { formatThroughput, formatThroughputNote, throughput } = await import('./throughput')

async function main(): Promise<void> {
  // 1. The rate is the produced text over the elapsed time.
  const text = 'x'.repeat(400)
  const rate = throughput(text, 2000, 'qwen2.5-coder-3b-instruct')
  assert.ok(rate.tokens > 0, 'the text produced tokens')
  assert.equal(rate.seconds, 2)
  assert.equal(rate.tokensPerSecond, Math.round(rate.tokens / 2))

  // 2. Twice the time is half the rate -- the arithmetic is honest.
  const slower = throughput(text, 4000, 'qwen2.5-coder-3b-instruct')
  assert.equal(slower.tokensPerSecond, Math.round(rate.tokensPerSecond / 2))

  // 3. No time has passed: there is no rate to report.
  const instant = throughput(text, 0, 'qwen2.5-coder-3b-instruct')
  assert.equal(instant.tokensPerSecond, 0)
  assert.equal(formatThroughput(instant), '', 'no rate is better than a fake one')

  // 4. Nothing produced: nothing to report.
  assert.equal(formatThroughput(throughput('', 5000, 'qwen2.5-coder-3b-instruct')), '')

  // 5. A rate under one token per second is the "started but has not really
  //    produced yet" state, and "0 tok/s" reads as a stall.
  const barely = throughput('a', 100_000, 'qwen2.5-coder-3b-instruct')
  assert.equal(formatThroughput(barely), '', 'a stalled turn does not print a rate')

  // 6. A real rate prints, and it says it is an ESTIMATE.
  const note = formatThroughputNote(rate)
  assert.match(note, /tok\/s/, 'the rate is named')
  assert.match(note, /est/, 'and it is marked as an estimate')
  assert.ok(!formatThroughputNote(instant).includes('est'), 'an empty rate has no note')

  // 7. The estimate is code-density aware, so it is not just chars/4: the
  //    same length of code costs more tokens than the same length of prose.
  const prose = 'the quick brown fox jumps over the lazy dog '.repeat(20)
  const code = 'function f(){return {a:1,b:[2,3]}}\n'.repeat(20)
  assert.ok(
    throughput(code, 1000, 'qwen2.5-coder-3b-instruct').tokens >
      throughput(prose, 1000, 'qwen2.5-coder-3b-instruct').tokens,
    'code is charged more honestly than prose',
  )

  rmSync(stateHome, { recursive: true, force: true })
  console.log('THROUGHPUT TEST: PASS (rate arithmetic, no rate without time, the estimate is labelled)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

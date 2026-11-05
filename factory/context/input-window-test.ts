/**
 * Offline test for oversized-input handling. No network, no model:
 * token estimate, budget resolvers, distill gate, boundary-aware split
 * (overlap + caps), map-reduce distill with a fake responder, service
 * pre-pass (passthrough / distill-to-brief + INPUT_FULL.md / fallback
 * on model failure — never throws).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  distillInput,
  estimateInputTokens,
  INPUT_FULL_FILENAME,
  needsDistill,
  prepareTaskInput,
  resolveInputBudget,
  splitIntoChunks,
  taskInputText,
} from './input-window'

async function main(): Promise<void> {
  // 1. Estimate + budget resolvers.
  assert.equal(estimateInputTokens('abcd'), 1)
  assert.equal(estimateInputTokens('x'.repeat(400)), 100)
  assert.deepEqual(resolveInputBudget({}), {
    maxInputTokens: 10000,
    maxChunks: 32,
  })
  assert.deepEqual(
    resolveInputBudget({
      FACTORY_MAX_INPUT_TOKENS: '5000',
      FACTORY_MAX_INPUT_CHUNKS: '8',
    }),
    { maxInputTokens: 5000, maxChunks: 8 },
  )
  assert.equal(
    resolveInputBudget({ FACTORY_MAX_INPUT_TOKENS: '0' }).maxInputTokens,
    0,
    'zero is a valid cap',
  )
  assert.deepEqual(
    resolveInputBudget({
      FACTORY_MAX_INPUT_TOKENS: 'junk',
      FACTORY_MAX_INPUT_CHUNKS: '-2',
    }),
    { maxInputTokens: 10000, maxChunks: 32 },
    'junk/negative fall back to guarded defaults',
  )

  // 2. Gate: small fits, 70K-style input trips it.
  assert.equal(needsDistill('small task'), false)
  assert.equal(
    needsDistill('x'.repeat(70000 * 4)),
    true,
    '70K-token input must trip the gate',
  )
  assert.equal(
    needsDistill('x'.repeat(70000 * 4), { maxInputTokens: 99999999, maxChunks: 32 }),
    false,
    'raised budget fits more',
  )

  // 3. Splitter: fits → one chunk; big → bounded chunks with overlap.
  assert.deepEqual(splitIntoChunks('abc', 100), ['abc'])
  const paras = Array.from(
    { length: 20 },
    (_, i) => `Paragraph ${i} requirement text here.\nSecond line ${i}.`,
  ).join('\n\n')
  const chunks = splitIntoChunks(paras, 200, 20, 32)
  assert.ok(chunks.length > 1, 'long input must split')
  assert.ok(
    chunks.every(chunk => chunk.length <= 200),
    'chunks respect maxChars',
  )
  assert.ok(
    chunks.slice(1).every(chunk => chunk.length > 0),
    'no empty chunks',
  )
  const capped = splitIntoChunks('z'.repeat(100000), 1000, 0, 5)
  assert.equal(capped.length, 5, 'chunk cap bounds fan-out')

  // 4. taskInputText joins the budgeted surface.
  assert.ok(
    taskInputText({ objective: 'obj', constraints: ['c1'], acceptanceCriteria: ['a1'] }).includes('obj'),
  )

  // 5. Map-reduce distill with a fake responder (model reasons, plugin splits).
  {
    const seen: string[] = []
    const brief = await distillInput(
      'Build X. Must do A.\n\nBuild Y. Must do B.',
      async prompt => {
        seen.push(prompt)
        if (prompt.startsWith('Extract')) return '- requirement found'
        return 'WORKING BRIEF: A and B.'
      },
      { maxInputTokens: 10, maxChunks: 8 },
    )
    assert.ok(brief.brief.includes('WORKING BRIEF'), 'reduce output becomes the brief')
    assert.ok(brief.chunks >= 1 && brief.mapCalls === brief.chunks)
    assert.ok(seen.some(p => p.startsWith('Extract')), 'map pass ran')
    assert.ok(seen.some(p => p.startsWith('Merge')), 'reduce pass ran')
  }

  // 6. Pre-pass passthrough for fitting input (untouched, no dirs made).
  {
    const task = {
      objective: 'small',
      constraints: [] as string[],
      acceptanceCriteria: [] as string[],
      workspace: join(tmpdir(), 'wed-input-never-created-xyz'),
    }
    const result = await prepareTaskInput(task, async () => {
      throw new Error('must not call the model for fitting input')
    })
    assert.equal(result.distilled, false)
    assert.equal(result.task.objective, 'small')
  }

  // 7. Pre-pass distills oversized input: brief + pointer + full file.
  {
    const dir = mkdtempSync(join(tmpdir(), 'wed-input-'))
    try {
      const big = 'Requirement block. '.repeat(20000)
      const result = await prepareTaskInput(
        { objective: big, workspace: dir },
        async prompt =>
          prompt.startsWith('Extract') ? '- req' : 'BRIEF.',
        { maxInputTokens: 1000, maxChunks: 8 },
      )
      assert.equal(result.distilled, true)
      assert.ok(result.task.objective.includes('BRIEF.'))
      assert.ok(result.task.objective.includes(INPUT_FULL_FILENAME))
      const saved = readFileSync(join(dir, INPUT_FULL_FILENAME), 'utf8')
      assert.ok(saved.includes(big.slice(0, 100)), 'full input preserved verbatim')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 8. Model failure → truncation fallback, never throws.
  {
    const dir = mkdtempSync(join(tmpdir(), 'wed-input-fb-'))
    try {
      const big = 'w'.repeat(50000)
      const result = await prepareTaskInput(
        { objective: big, workspace: dir },
        async () => {
          throw new Error('model down')
        },
        { maxInputTokens: 1000, maxChunks: 8 },
      )
      assert.equal(result.distilled, false)
      assert.equal(result.fallback, true)
      assert.ok(result.task.objective.includes('[truncated'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('INPUT WINDOW TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

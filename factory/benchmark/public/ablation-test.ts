/**
 * Offline test for the board runner's honesty helpers (2026-11-06).
 *
 * Three pure proofs, no network and no model:
 *
 *  1. MODEL NAME — the recorded model must be the model that ACTUALLY ran.
 *     The old code recorded `LOCAL_LLM_MODEL` (or the local default) on
 *     every route, so a hosted run published under the wrong model's name.
 *  2. CONTEXT WINDOW — the registry's window for the model that ran; an
 *     UNKNOWN model is `null` ("unknown"), never the old hardcoded 13312.
 *  3. ABLATION ARITHMETIC — the SOLO-vs-FACTORY summary: both arms'
 *     pass rates over the same problems, and `null` when the solo arm did
 *     not run (never a fabricated zero).
 *
 * Plus the two pieces the solo arm is built from: which boards can carry
 * it, and how a model's answer is parsed back into solution files.
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_LOCAL_BATCH_MODEL,
  parseSoloFileBlocks,
  resolveBatchContextWindow,
  resolveBatchModel,
  resolveBatchProvider,
  soloSupportFor,
  summarizeAblation,
  type BoardProblemRecord,
} from './board-runner'

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

function record(overrides: Partial<BoardProblemRecord> = {}): BoardProblemRecord {
  return {
    board: 'humaneval',
    problemId: 'p/1',
    runId: 'p0-p-1',
    mode: 'live',
    startedAt: '2026-11-06T00:00:00.000Z',
    endedAt: '2026-11-06T00:01:00.000Z',
    durationMs: 1000,
    hermesStatus: 'completed',
    factoryStatus: 'completed',
    boardGrade: { passed: false, detail: 'red' },
    verificationPassed: false,
    repairAttempts: 0,
    reviewVerdict: null,
    usage: { calls: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: null },
    samplesUsed: 1,
    runDir: 'run',
    workspace: 'workspace',
    ...overrides,
  }
}

async function main(): Promise<void> {
  // --- 1. The model that actually ran. ---
  assert.equal(resolveBatchProvider(env({})), 'openrouter', 'openrouter is the default route')
  assert.equal(resolveBatchProvider(env({ FACTORY_LLM_PROVIDER: '  NVIDIA ' })), 'nvidia')

  assert.equal(
    resolveBatchModel(env({ LOCAL_LLM_MODEL: 'local-model' }), 'deterministic'),
    'deterministic',
    'the deterministic mode keeps its own label',
  )

  // local: LOCAL_LLM_MODEL -> DSH_LLM_MODEL -> the existing default.
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_MODEL: '  local-model  ' }), 'live'),
    'local-model',
    'the local route records the local model',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'dsh-local' }), 'live'),
    'dsh-local',
    'the local route falls back to DSH_LLM_MODEL',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'local' }), 'live'),
    DEFAULT_LOCAL_BATCH_MODEL,
    'the local route falls back to the historical default',
  )

  // hosted: DSH_LLM_MODEL -> the provider's own var -> '' (never a guess).
  assert.equal(
    resolveBatchModel(
      env({
        FACTORY_LLM_PROVIDER: 'openrouter',
        DSH_LLM_MODEL: 'deepseek/deepseek-chat',
        LOCAL_LLM_MODEL: 'qwen2.5-coder-3b-instruct',
      }),
      'live',
    ),
    'deepseek/deepseek-chat',
    'a hosted route must NOT record the local model',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'openrouter', LOCAL_LLM_MODEL: 'qwen2.5-coder-3b-instruct' }), 'live'),
    '',
    'a hosted route with no pinned model records no model (honest, not a guess)',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'nvidia', DSH_LLM_MODEL: 'nvidia/pinned' }), 'live'),
    'nvidia/pinned',
    'the nvidia route records DSH_LLM_MODEL',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'nvidia', NVIDIA_LLM_MODEL: 'nvidia/own' }), 'live'),
    'nvidia/own',
    'the nvidia route falls back to its own model var',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'zen', DSH_LLM_MODEL: 'zen/pinned' }), 'live'),
    'zen/pinned',
    'the zen route records DSH_LLM_MODEL',
  )
  assert.equal(
    resolveBatchModel(env({ FACTORY_LLM_PROVIDER: 'zen' }), 'live'),
    '',
    'the zen route with no pinned model records no model',
  )

  // --- 2. The context window (registry, never a guess). ---
  assert.equal(
    resolveBatchContextWindow(env({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_MODEL: 'qwen2.5-coder-3b-instruct' }), 'live'),
    32768,
    'a known model reports the registry window',
  )
  assert.equal(
    resolveBatchContextWindow(env({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_MODEL: 'totally-unknown-model' }), 'live'),
    null,
    'an UNKNOWN model reports null — never the old hardcoded 13312',
  )
  assert.equal(
    resolveBatchContextWindow(env({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_MODEL: 'qwen2.5-coder-3b-instruct' }), 'deterministic'),
    null,
    'the deterministic mode carries no window',
  )
  assert.equal(
    resolveBatchContextWindow(env({ FACTORY_LLM_PROVIDER: 'openrouter', DSH_LLM_MODEL: 'deepseek/deepseek-chat' }), 'live'),
    null,
    'hosted routes carry no factory-side window',
  )

  // --- 3. The ablation arithmetic. ---
  assert.equal(
    summarizeAblation([record(), record()]),
    null,
    'no solo arm -> the ablation is null (never a fabricated zero)',
  )

  const soloRun = summarizeAblation([
    record({
      boardGrade: { passed: true, detail: 'green' },
      soloSupported: true,
      soloPassed: true,
      soloDetail: 'board asserts passed',
      soloUsage: { calls: 1, promptTokens: 80, completionTokens: 20, totalTokens: 100, costUsd: null },
      usage: { calls: 2, promptTokens: 200, completionTokens: 100, totalTokens: 300, costUsd: null },
    }),
    record({
      boardGrade: { passed: true, detail: 'green' },
      soloSupported: true,
      soloPassed: false,
      soloDetail: 'assert failed',
      soloUsage: { calls: 1, promptTokens: 90, completionTokens: 30, totalTokens: 120, costUsd: null },
      usage: { calls: 3, promptTokens: 300, completionTokens: 200, totalTokens: 500, costUsd: null },
    }),
    record({
      boardGrade: { passed: false, detail: 'red' },
      soloSupported: true,
      soloPassed: false,
      soloDetail: 'assert failed',
      soloUsage: { calls: 1, promptTokens: 70, completionTokens: 10, totalTokens: 80, costUsd: null },
      usage: { calls: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: null },
    }),
  ])
  assert.ok(soloRun, 'the ablation summary exists when the solo arm ran')
  assert.equal(soloRun.soloPassed, 1)
  assert.equal(soloRun.soloTotal, 3)
  assert.equal(soloRun.soloPassRate, 1 / 3)
  assert.equal(soloRun.factoryPassed, 2)
  assert.equal(soloRun.factoryTotal, 3, 'the Factory numbers cover the same problems')
  assert.equal(soloRun.factoryPassRate, 2 / 3)
  assert.equal(soloRun.soloTokens, 300)
  assert.equal(soloRun.factoryTokens, 950)

  // A board that cannot support the solo arm contributes NOTHING: it is
  // not a failure of the bare model.
  const unsupported = summarizeAblation([
    record({ soloSupported: false, soloDetail: 'solo arm not supported for this board: ...' }),
  ])
  assert.equal(unsupported, null, 'an unsupported solo arm is not counted as a failure')

  // --- 4. Which boards can carry the solo arm. ---
  const humaneval = soloSupportFor('humaneval', { id: 'x', objective: 'o', test: 't' })
  assert.equal(humaneval.supported, true)
  assert.deepEqual(humaneval.solutionFiles, ['solution.py'])

  const evalPlus = soloSupportFor('evalplus', { id: 'x', objective: 'o', test: 't' })
  assert.equal(evalPlus.supported, true)
  assert.deepEqual(evalPlus.solutionFiles, ['solution.py'])

  const lcb = soloSupportFor('livecodebench', { id: 'x', objective: 'o', test: '{}' })
  assert.equal(lcb.supported, true)
  assert.deepEqual(lcb.solutionFiles, ['solution.py'])

  const aider = soloSupportFor('aider', {
    id: 'x',
    objective: 'o',
    test: JSON.stringify({
      language: 'python',
      slug: 'demo',
      solutionFiles: ['demo.py'],
      testFiles: [],
      gradeCommand: 'python -m unittest demo_test',
    }),
  })
  assert.equal(aider.supported, true)
  assert.deepEqual(aider.solutionFiles, ['demo.py'])

  for (const board of ['swebench', 'swebench-verified', 'swebench-live', 'multi-swe'] as const) {
    const support = soloSupportFor(board, { id: 'x', objective: 'o', test: '{}' })
    assert.equal(support.supported, false, `${board} cannot carry the solo arm`)
    assert.ok((support.reason ?? '').length > 0, `${board} says why`)
    assert.deepEqual(support.solutionFiles, [])
  }

  // --- 5. Parsing the bare model's answer back into files. ---
  const blocks = parseSoloFileBlocks(
    ['### FILE: solution.py', 'def add(a, b):', '    return a + b', '', '### FILE: extra.txt', 'ignored'].join('\n'),
  )
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].path, 'solution.py')
  assert.ok(blocks[0].content.includes('return a + b'))
  assert.equal(blocks[1].path, 'extra.txt')
  assert.deepEqual(parseSoloFileBlocks('just some prose'), [], 'no file blocks, no files')

  console.log('ABLATION TEST: PASS')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

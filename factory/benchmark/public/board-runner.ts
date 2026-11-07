/**
 * Public-board runner core — turns board problems into EngineeringTasks on
 * the production path (Hermes submit → FactoryService → orchestrator →
 * verification → review), then grades each workspace with the board adapter.
 *
 * Board grading is wired INTO the Factory verification (`testCommands` runs
 * the seeded `grade_solution.py`), so the repair loop sees real board
 * failures — loops-until-done applies to public boards exactly as to our
 * own fixtures.
 *
 * One workspace per problem; no fixture copy (the board problem IS the
 * starting state). Per-problem evidence.json + batch records.jsonl and
 * summary.json under `<outRoot>/<board>/<batchId>/`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { EngineeringResult } from '../../contracts'
import { PersistentFactoryEventBus } from '../../events'
import { EVENTS_PATH } from '../../paths'
import { loadStore, runHermesTask, submitTask } from '../../hermes/store'
import { VerificationEngine } from '../../verification'
import { estimateCostUsd, usageDiff, usageSnapshot } from '../../model-router/usage'
import { createModelRouter } from '../../model-router/create-router'
import { contextWindowFor } from '../../model-router/model-registry'
import { createHumanEvalAdapter, HUMANEVAL_SOLUTION_FILE } from './humaneval'
import { createEvalPlusAdapter } from './evalplus'
import { createSweVerifiedAdapter } from './swebench-verified'
import { createSweLiveAdapter } from './swebench-live'
import { createMultiSweAdapter, MULTISWE_GRADE_FILE, setupMultiSweWorkspace } from './multi-swe'
import {
  AIDER_GRADE_FILE,
  createAiderAdapter,
  decodePayload as decodeAiderPayload,
  setupAiderWorkspace,
} from './aider'
import {
  createLiveCodeBenchAdapter,
  LCB_GRADE_FILE,
  LCB_SOLUTION_FILE,
  lcbGraderSeed,
} from './livecodebench'
import {
  createSweBenchAdapter,
  setupSweWorkspace,
  SWE_GRADE_FILE,
} from './swebench'
import { pythonBin } from './run-python'
import type { PublicBenchAdapter, PublicProblem } from './types'

export const BOARD_RUNNER_VERSION = 'public-v1.1.0'

export type PublicBoardId = 'humaneval' | 'aider' | 'livecodebench' | 'swebench' | 'evalplus' | 'swebench-verified' | 'swebench-live' | 'multi-swe'

export interface BoardRunOptions {
  board: PublicBoardId
  datasetPath: string
  mode: 'deterministic' | 'live'
  outRoot: string
  /** Problems to attempt (default 5). */
  limit?: number
  /** Skip the first N problems of the board. */
  offset?: number
  /**
   * Independent samples per problem (default 1). The problem passes when
   * ANY sample passes (pass@k); runs stop early on the first pass.
   * Each sample gets a fresh workspace — no peeking across samples.
   */
  samples?: number
  /**
   * Also run a SOLO arm per problem (default false — OFF).
   *
   * The SOLO arm is the SAME model on the SAME problem with NO Factory:
   * no verification, no reviewer, no repair loop, no multi-seat team. Its
   * answer is graded by the SAME board grader, so the board can report
   * "the Factory got X where the bare model got Y" — the product's actual
   * claim. The solo arm NEVER contributes to the Factory's score: its
   * outcome lives in separate record fields.
   */
  ablation?: boolean
}

export interface BoardProblemRecord {
  board: string
  problemId: string
  runId: string
  mode: string
  startedAt: string
  endedAt: string
  durationMs: number
  hermesStatus: string
  factoryStatus: string
  runError?: string
  /** Authoritative board score for this attempt. */
  boardGrade: { passed: boolean; detail: string }
  /** Factory verification (the same grader) on the final workspace. */
  verificationPassed: boolean
  repairAttempts: number
  reviewVerdict: string | null
  usage: {
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number | null
  }
  /** Independent samples run for this problem (1 = classic pass@1). */
  samplesUsed: number
  runDir: string
  workspace: string
  /**
   * SOLO arm (ablation only): did the BARE model — same model, same
   * problem, no Factory — pass the same board grader?
   *
   * Present only when the solo arm actually produced a graded result.
   * A board that cannot support the arm records `soloSupported: false`
   * and a `soloDetail` saying so; it is NEVER counted as a failure.
   */
  soloPassed?: boolean
  /** SOLO arm (ablation only): what happened, verbatim. */
  soloDetail?: string
  /** SOLO arm (ablation only): false when this board has no solo arm. */
  soloSupported?: boolean
  /** SOLO arm (ablation only): the bare model's own token usage. */
  soloUsage?: {
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number | null
  }
  /** SOLO arm (ablation only): the route that actually answered. */
  soloProvider?: string
  /** SOLO arm (ablation only): the model that actually answered. */
  soloModel?: string
  /**
   * The route the FACTORY arm actually ran on, read from its own usage
   * records (the model that spent the most tokens wrote the solution).
   *
   * The SOLO arm is pinned to this model, so the two arms really are the
   * same model on the same problems — the only difference is the Factory.
   */
  factoryRoute?: { provider: string; model: string }
}

/**
 * The SOLO-vs-FACTORY comparison of one batch (the ablation).
 *
 * The Factory numbers are computed over the SAME problem set the solo arm
 * ran on, so the delta is apples-to-apples. `null` on the summary means
 * the ablation did not run (or could not run on that board) — never a
 * fabricated zero.
 */
export interface BoardAblation {
  /** Problems the bare model solved. */
  soloPassed: number
  /** Problems the bare model was graded on. */
  soloTotal: number
  /** Bare-model pass rate (0..1). */
  soloPassRate: number
  /** The same problems solved by the Factory. */
  factoryPassed: number
  /** The same problems attempted by the Factory. */
  factoryTotal: number
  /** Factory pass rate over those problems (0..1). */
  factoryPassRate: number
  /** Tokens the bare model spent. */
  soloTokens: number
  /** Tokens the Factory spent on the same problems. */
  factoryTokens: number
}

export interface BoardSummary {
  board: string
  mode: string
  runnerVersion: string
  total: number
  passed: number
  passRate: number
  /** Total independent sample runs across all problems (≥ total). */
  samplesUsed: number
  totalTokens: number
  durationMs: number
  datasetPath: string
  batchDir: string
  /** Model that ran this batch (env at run time; 'deterministic' offline). */
  model: string
  /**
   * Serving config (chat-10 run-settings honesty: temperature, route,
   * context ceiling recorded per batch so scores stay comparable).
   * The factory never sets temperature anywhere — upstream default rules.
   */
  serving: {
    provider: string
    temperature: string
    contextWindow: number | null
  }
  /**
   * SOLO-vs-FACTORY ablation for this batch.
   *
   * `null` when the ablation did not run (it is opt-in) or when the board
   * could not support it. Never a fabricated zero.
   */
  ablation?: BoardAblation | null
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-')
}

/* ------------------------------------------------------------------ */
/* What actually ran (model + context window).                         */
/* ------------------------------------------------------------------ */

/**
 * The local route's default model label, kept for the case where the
 * operator pinned nothing at all (the historical board-runner default).
 */
export const DEFAULT_LOCAL_BATCH_MODEL = 'qwen2.5-coder-3b-instruct'

/**
 * The env var that pins a HOSTED route's model, per provider.
 *
 * The hosted routes answer to `DSH_LLM_MODEL` first (that is the profile's
 * single model pin). A provider with its own var (`nvidia`, `zen`) is the
 * fallback. `openrouter` has none: its pin IS `DSH_LLM_MODEL`.
 */
const HOSTED_MODEL_ENV: Record<string, string> = {
  nvidia: 'NVIDIA_LLM_MODEL',
  zen: 'ZEN_MODEL',
}

/** The route the live batch runs on (pure). */
export function resolveBatchProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FACTORY_LLM_PROVIDER ?? 'openrouter').trim().toLowerCase() || 'openrouter'
}

/**
 * The model that ACTUALLY ran the batch (pure).
 *
 * The old code always recorded `LOCAL_LLM_MODEL` (or the local default) —
 * which names the wrong model on every HOSTED route: the batch ran on the
 * hosted route's model, but the board said "qwen2.5-coder-3b". A published
 * scoreboard that names the wrong model is worse than one that names none.
 *
 *  - deterministic -> 'deterministic'
 *  - local         -> LOCAL_LLM_MODEL -> DSH_LLM_MODEL -> the local default
 *  - hosted        -> DSH_LLM_MODEL -> the provider's own model var -> ''
 *
 * The empty string is the HONEST answer for a hosted route with no pinned
 * model: nothing is guessed.
 */
export function resolveBatchModel(
  env: NodeJS.ProcessEnv = process.env,
  mode: 'deterministic' | 'live' = 'live',
): string {
  if (mode === 'deterministic') return 'deterministic'
  const provider = resolveBatchProvider(env)
  if (provider === 'local') {
    return (
      (env.LOCAL_LLM_MODEL ?? '').trim() ||
      (env.DSH_LLM_MODEL ?? '').trim() ||
      DEFAULT_LOCAL_BATCH_MODEL
    )
  }
  const hosted = (env.DSH_LLM_MODEL ?? '').trim()
  if (hosted) return hosted
  const ownVar = HOSTED_MODEL_ENV[provider]
  if (ownVar !== undefined) {
    const own = (env[ownVar] ?? '').trim()
    if (own) return own
  }
  return ''
}

/**
 * The batch's context window (pure).
 *
 * The old code hardcoded 13312 for the local route — a number that belongs
 * to ONE Colab deployment, not to the model. The model registry knows each
 * model's real window; an UNKNOWN model returns 0, and 0 becomes `null`
 * ("unknown") rather than a guess.
 *
 * Only the local route reports a window: the hosted routes have no
 * factory-side ceiling (their server owns it).
 */
export function resolveBatchContextWindow(
  env: NodeJS.ProcessEnv = process.env,
  mode: 'deterministic' | 'live' = 'live',
): number | null {
  if (mode !== 'live') return null
  const provider = resolveBatchProvider(env)
  if (provider !== 'local') return null
  const window = contextWindowFor(resolveBatchModel(env, mode), provider)
  return window > 0 ? window : null
}

/**
 * The grader seed written into every workspace. Executes `solution.py` into
 * module scope, then runs the board's own asserts via `check(entry_point)`.
 * Exit 0 = problem solved. (Executes model-written code on the host — same
 * trust model as the upstream HumanEval harness; sandboxing is a known gap.)
 */
export function graderSeed(problem: PublicProblem): string {
  return [
    '"""Official board grader (generated by board-runner). DO NOT MODIFY."""',
    'import pathlib',
    '',
    '_code = pathlib.Path("solution.py").read_text()',
    'exec(compile(_code, "solution.py", "exec"), globals())',
    '',
    problem.test.trimEnd(),
    '',
    `check(${problem.entryPoint})`,
    '',
  ].join('\n')
}

interface RunOneContext {
  adapter: PublicBenchAdapter
  problem: PublicProblem
  index: number
  options: BoardRunOptions
  batchId: string
  batchDir: string
  gradeCommand: string
}

/**
 * Sample-and-select driver (pass@k): run independent attempts until one
 * passes or the budget dies. Early stop on first pass — a pass is a pass.
 * Pure sequencing over an injected attempt fn (unit-tested).
 */
export async function runUntilPass(
  attempt: (sampleIndex: number) => Promise<{ passed: boolean }>,
  maxSamples: number,
): Promise<{ passed: boolean; samplesUsed: number }> {
  const budget = Math.max(1, Math.floor(maxSamples))
  let used = 0
  let passed = false
  while (used < budget && !passed) {
    used += 1
    passed = (await attempt(used)).passed
  }
  return { passed, samplesUsed: used }
}

/* ------------------------------------------------------------------ */
/* The SOLO arm: the bare model, no Factory.                           */
/* ------------------------------------------------------------------ */

/** Can this board be run SOLO (bare model, no Factory)? */
export interface SoloSupport {
  /** True when a bare model can write the board's expected solution file. */
  readonly supported: boolean
  /** The files the bare model must produce (workspace-relative). */
  readonly solutionFiles: string[]
  /** Why the arm cannot run here (present when `supported` is false). */
  readonly reason?: string
}

/**
 * Which boards can carry a SOLO arm.
 *
 * A SOLO arm needs ONE known file the bare model can write, because the
 * arm has no tools: it answers with text and the runner drops that text
 * into the file. The repo-fix boards (SWE-bench family, Multi-SWE) have no
 * such file — the fix location IS the task, and guessing a path would
 * fabricate a result. Those boards say so out loud instead.
 */
export function soloSupportFor(board: PublicBoardId, problem: PublicProblem): SoloSupport {
  if (board === 'humaneval' || board === 'evalplus') {
    return { supported: true, solutionFiles: [HUMANEVAL_SOLUTION_FILE] }
  }
  if (board === 'livecodebench') {
    return { supported: true, solutionFiles: [LCB_SOLUTION_FILE] }
  }
  if (board === 'aider') {
    const payload = decodeAiderPayload(problem.test)
    return { supported: true, solutionFiles: [...payload.solutionFiles] }
  }
  return {
    supported: false,
    solutionFiles: [],
    reason:
      'this board grades a repository fix, not a single solution file — ' +
      'the bare model has no known file to write, so the SOLO arm is not supported here',
  }
}

/**
 * Pull `### FILE: <path>` blocks out of a model's answer (pure).
 *
 * The SOLO arm has no tools, so the model answers with text. We ask for
 * one block per file and parse them back; the same answer is what the
 * Factory's coder would have written into those files.
 */
export function parseSoloFileBlocks(text: string): Array<{ path: string; content: string }> {
  const matches = [...text.matchAll(/^###\s*FILE:\s*(.+?)\s*$/gm)]
  const blocks: Array<{ path: string; content: string }> = []
  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length
    const next = matches[index + 1]
    const end = next?.index ?? text.length
    blocks.push({ path: match[1].trim(), content: text.slice(start, end).replace(/^\r?\n/, '') })
  }
  return blocks
}

/** Strip one markdown code fence around a whole answer. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed)
  return fenced ? fenced[1] : trimmed
}

/** Do two workspace-relative paths name the same file? */
function sameFile(a: string, b: string): boolean {
  const clean = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  const left = clean(a)
  const right = clean(b)
  if (left === right) return true
  const base = (value: string): string => value.slice(value.lastIndexOf('/') + 1)
  return base(left) === base(right)
}

/**
 * The SOLO-vs-FACTORY arithmetic (pure).
 *
 * Only problems the solo arm ACTUALLY graded count — a board that cannot
 * support the arm contributes nothing, so it can never be mistaken for
 * "the bare model solved nothing". The Factory's numbers are taken over
 * the SAME problem set, so the delta is apples-to-apples.
 *
 * `null` when the arm did not run.
 */
export function summarizeAblation(records: BoardProblemRecord[]): BoardAblation | null {
  const graded = records.filter(
    record => record.soloSupported !== false && typeof record.soloPassed === 'boolean',
  )
  if (graded.length === 0) return null
  const soloPassed = graded.filter(record => record.soloPassed === true).length
  const factoryPassed = graded.filter(record => record.boardGrade.passed).length
  const soloTokens = graded.reduce((sum, record) => sum + (record.soloUsage?.totalTokens ?? 0), 0)
  const factoryTokens = graded.reduce((sum, record) => sum + (record.usage?.totalTokens ?? 0), 0)
  return {
    soloPassed,
    soloTotal: graded.length,
    soloPassRate: soloPassed / graded.length,
    factoryPassed,
    factoryTotal: graded.length,
    factoryPassRate: factoryPassed / graded.length,
    soloTokens,
    factoryTokens,
  }
}

async function runOneProblem(ctx: RunOneContext): Promise<BoardProblemRecord> {
  const { adapter, problem, index, options, batchId, batchDir } = ctx
  const baseRunId = `p${index}-${sanitizeId(problem.id)}`
  const runDir = join(batchDir, baseRunId)
  const maxSamples = options.samples ?? 1
  await mkdir(runDir, { recursive: true })

  const samples: BoardProblemRecord[] = []
  const outcome = await runUntilPass(async sampleIndex => {
    const sample = await runSampleProblem({ ...ctx, baseRunId, sampleIndex })
    samples.push(sample)
    return { passed: sample.boardGrade.passed }
  }, maxSamples)

  const best = samples.find(sample => sample.boardGrade.passed) ?? samples[samples.length - 1]
  const sumUsage = {
    calls: samples.reduce((s, r) => s + r.usage.calls, 0),
    promptTokens: samples.reduce((s, r) => s + r.usage.promptTokens, 0),
    completionTokens: samples.reduce((s, r) => s + r.usage.completionTokens, 0),
  }
  const costs = samples.map(r => r.usage.costUsd).filter((c): c is number => c !== null)
  const record: BoardProblemRecord = {
    board: options.board,
    problemId: problem.id,
    runId: baseRunId,
    mode: options.mode,
    startedAt: samples[0].startedAt,
    endedAt: samples[samples.length - 1].endedAt,
    durationMs: samples.reduce((s, r) => s + r.durationMs, 0),
    hermesStatus: best.hermesStatus,
    factoryStatus: best.factoryStatus,
    ...(best.runError !== undefined ? { runError: best.runError } : {}),
    boardGrade: best.boardGrade,
    verificationPassed: best.verificationPassed,
    repairAttempts: samples.reduce((s, r) => s + r.repairAttempts, 0),
    reviewVerdict: best.reviewVerdict,
    usage: { ...sumUsage, totalTokens: sumUsage.promptTokens + sumUsage.completionTokens, costUsd: costs.length > 0 ? costs.reduce((s, c) => s + c, 0) : null },
    samplesUsed: outcome.samplesUsed,
    runDir,
    workspace: best.workspace,
    ...(best.factoryRoute ? { factoryRoute: best.factoryRoute } : {}),
  }

  // The SOLO arm (opt-in): the SAME model, the SAME problem, NO Factory.
  // Its outcome lives in its own fields — it never touches the Factory's
  // score. The deterministic mode has no live model to run SOLO, so the
  // arm stays off there.
  if (options.ablation === true && options.mode === 'live') {
    const solo = await runSoloProblem({
      ...ctx,
      baseRunId,
      // The model the Factory arm ACTUALLY ran on (its own usage
      // records), so the two arms differ only by the Factory itself.
      model: best.factoryRoute?.model ?? resolveBatchModel(process.env, options.mode),
    })
    record.soloSupported = solo.supported
    record.soloDetail = solo.detail
    if (solo.supported) {
      record.soloPassed = solo.passed
      if (solo.usage) record.soloUsage = solo.usage
      if (solo.provider) record.soloProvider = solo.provider
      if (solo.model) record.soloModel = solo.model
    }
  }

  await writeFile(join(runDir, 'evidence.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return record
}

/**
 * The board-specific workspace setup + grader wiring.
 *
 * SHARED by the Factory arm and the SOLO arm: the ablation is only
 * meaningful when both arms see the same starting state and the same
 * grader. The Factory's repair loop must see real board failures, so the
 * board grader IS the Factory verification.
 */
interface WorkspaceSetup {
  gradeCommand: string
  constraints: string[]
  requiredFiles: string[]
  graderNote: string
  /** The files a solution must land in (the SOLO arm writes exactly these). */
  solutionFiles: string[]
  /** False when this board has no single solution file (repo-fix boards). */
  soloSupported: boolean
  /** Why the SOLO arm cannot run here. */
  soloUnsupportedReason?: string
}

async function prepareBoardWorkspace(
  board: PublicBoardId,
  workspace: string,
  problem: PublicProblem,
  datasetPath: string,
  defaultGradeCommand: string,
): Promise<WorkspaceSetup> {
  if (board === 'aider') {
    await setupAiderWorkspace(workspace, problem, datasetPath)
    const payload = decodeAiderPayload(problem.test)
    return {
      gradeCommand: `${pythonBin()} ${AIDER_GRADE_FILE}`,
      constraints: [
        `Write exactly: ${payload.solutionFiles.join(', ')}.`,
        'Use only the language standard library / offline dependencies.',
        `Do not modify ${AIDER_GRADE_FILE}.`,
      ],
      requiredFiles: payload.solutionFiles,
      graderNote: `The file ${AIDER_GRADE_FILE} in the workspace is the official grader — do not modify or delete it.`,
      solutionFiles: [...payload.solutionFiles],
      soloSupported: true,
    }
  }
  if (board === 'swebench' || board === 'swebench-verified' || board === 'swebench-live') {
    await setupSweWorkspace(workspace, problem)
    return {
      gradeCommand: `${pythonBin()} ${SWE_GRADE_FILE}`,
      // Fix location IS the task — the gate stays vacuous, pytest decides.
      constraints: [
        'Edit the repository SOURCE files that cause the bug.',
        'Do not edit test files.',
        `Do not modify ${SWE_GRADE_FILE}.`,
      ],
      requiredFiles: [],
      graderNote:
        `The file ${SWE_GRADE_FILE} in the workspace is the official grader — do not modify or delete it.`,
      solutionFiles: [],
      soloSupported: false,
      soloUnsupportedReason:
        'this board grades a repository fix, not a single solution file — ' +
        'the bare model has no known file to write, so the SOLO arm is not supported here',
    }
  }
  if (board === 'multi-swe') {
    await setupMultiSweWorkspace(workspace, problem)
    return {
      gradeCommand: `${pythonBin()} ${MULTISWE_GRADE_FILE}`,
      // Fix location IS the task — the gate stays vacuous, cargo decides.
      constraints: [
        'Edit the repository SOURCE files that cause the bug.',
        'Do not edit test files.',
        `Do not modify ${MULTISWE_GRADE_FILE}.`,
      ],
      requiredFiles: [],
      graderNote:
        `The file ${MULTISWE_GRADE_FILE} in the workspace is the official grader — do not modify or delete it.`,
      solutionFiles: [],
      soloSupported: false,
      soloUnsupportedReason:
        'this board grades a repository fix, not a single solution file — ' +
        'the bare model has no known file to write, so the SOLO arm is not supported here',
    }
  }
  if (board === 'livecodebench') {
    const row = JSON.parse(problem.test) as { starter?: string }
    await writeFile(
      join(workspace, LCB_SOLUTION_FILE),
      (row.starter ?? '').trimEnd() + '\n',
      'utf8',
    )
    await writeFile(join(workspace, LCB_GRADE_FILE), lcbGraderSeed(problem), 'utf8')
    return {
      gradeCommand: `${pythonBin()} ${LCB_GRADE_FILE}`,
      constraints: [
        'Write exactly one file: solution.py.',
        'Use only the python standard library.',
        `Do not modify ${LCB_GRADE_FILE}.`,
      ],
      requiredFiles: [LCB_SOLUTION_FILE],
      graderNote:
        `The file ${LCB_GRADE_FILE} in the workspace is the official grader — do not modify or delete it.`,
      solutionFiles: [LCB_SOLUTION_FILE],
      soloSupported: true,
    }
  }
  await writeFile(join(workspace, 'grade_solution.py'), graderSeed(problem), 'utf8')
  return {
    gradeCommand: defaultGradeCommand,
    constraints: [
      'Write exactly one file: solution.py.',
      'Use only the python standard library.',
      'Do not modify grade_solution.py.',
    ],
    requiredFiles: [HUMANEVAL_SOLUTION_FILE],
    graderNote:
      'The file grade_solution.py in the workspace is the official grader — do not modify or delete it.',
    solutionFiles: [HUMANEVAL_SOLUTION_FILE],
    soloSupported: true,
  }
}

async function runSampleProblem(ctx: RunOneContext & { baseRunId: string; sampleIndex: number }): Promise<BoardProblemRecord> {
  const { adapter, problem, options, batchId, batchDir } = ctx
  const runId = `${ctx.baseRunId}-s${ctx.sampleIndex}`
  const runDir = join(batchDir, runId)
  const workspace = join(runDir, 'workspace')
  await mkdir(workspace, { recursive: true })

  const setup = await prepareBoardWorkspace(
    options.board,
    workspace,
    problem,
    options.datasetPath,
    ctx.gradeCommand,
  )
  const { gradeCommand, constraints, requiredFiles, graderNote } = setup

  // Hermes task ids must be unique per attempt: runHermesTask executes
  // the FIRST store record with a matching id, so reusing an id across
  // batches silently re-runs a stale workspace (live-observed 2026-09-21:
  // four same-id runs all executed the first batch's workspace).
  const boardTaskId = `board-${options.board}-${batchId}-${runId}`
  const task = {
    id: boardTaskId,
    workspace,
    objective: [
      problem.objective,
      '',
      graderNote,
      'Your solution must be a self-contained file (standard library only).',
    ].join('\n'),
    role: 'backend',
    stack: 'python',
    constraints,
    acceptanceCriteria: ['Board grader exits 0 on the workspace.'],
    modelRequirements: { capability: 'coding' as const },
    acceptance: { requiredFiles },
    verification: { setupCommands: [], testCommands: [gradeCommand] },
  }

  const usageBefore = usageSnapshot()
  const startedAt = new Date().toISOString()
  const wallStart = Date.now()

  let hermesStatus = 'failed'
  let factoryStatus = 'failed'
  let runError: string | undefined
  let taskId = task.id
  try {
    taskId = await submitTask({ task, supervisor: 'board' })
    const outcome = await runHermesTask(taskId)
    hermesStatus = outcome.status
    const store = await loadStore()
    const record = store.tasks.find(item => item.id === taskId)
    factoryStatus = (record?.result as EngineeringResult | undefined)?.status ?? 'failed'
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error)
  }

  const durationMs = Date.now() - wallStart
  const endedAt = new Date().toISOString()
  const usageModels = usageDiff(usageBefore, usageSnapshot())
  const usage = {
    calls: usageModels.reduce((sum, r) => sum + r.calls, 0),
    promptTokens: usageModels.reduce((sum, r) => sum + r.promptTokens, 0),
    completionTokens: usageModels.reduce((sum, r) => sum + r.completionTokens, 0),
  }
  const totalTokens = usage.promptTokens + usage.completionTokens
  const costs = usageModels.map(r => estimateCostUsd(r)).filter(c => c !== null)
  const costUsd = costs.length > 0 ? costs.reduce((s, c) => s + (c ?? 0), 0) : null
  // The route this attempt REALLY ran on, read from its own usage
  // records — the model that spent the most tokens is the one that wrote
  // the solution (the crew's coder seat). The SOLO arm is pinned to it.
  const factoryRoute = usageModels.length === 0
    ? undefined
    : usageModels.reduce((best, row) => {
        const bestTokens = best.promptTokens + best.completionTokens
        const rowTokens = row.promptTokens + row.completionTokens
        return rowTokens > bestTokens ? row : best
      })

  const bus = new PersistentFactoryEventBus({ filePath: EVENTS_PATH })
  const events = await bus.list(taskId)
  const counts: Record<string, number> = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  const reviewVerdict =
    (events.filter(e => e.type === 'review.completed').at(-1)?.payload?.status as string | undefined) ?? null

  // The same grader the Factory verified with, re-run authoritatively.
  const verifier = new VerificationEngine()
  const verification = await verifier.verify(workspace, [], [gradeCommand])
  const boardGrade = await adapter.grade(workspace, problem)

  const record: BoardProblemRecord = {
    board: options.board,
    problemId: problem.id,
    runId,
    mode: options.mode,
    startedAt,
    endedAt,
    durationMs,
    hermesStatus,
    factoryStatus,
    ...(runError !== undefined ? { runError } : {}),
    boardGrade: { passed: boardGrade.passed, detail: boardGrade.detail.slice(0, 500) },
    verificationPassed: verification.passed,
    repairAttempts: counts['repair.started'] ?? 0,
    reviewVerdict,
    usage: { ...usage, totalTokens, costUsd },
    samplesUsed: 1,
    runDir,
    workspace,
    ...(factoryRoute ? { factoryRoute: { provider: factoryRoute.provider, model: factoryRoute.model } } : {}),
  }
  await writeFile(join(runDir, 'evidence.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return record
}

/* ------------------------------------------------------------------ */
/* The SOLO arm runner.                                                */
/* ------------------------------------------------------------------ */

/** The SOLO arm's own token usage (the bare model's cost). */
interface SoloUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number | null
}

/** One SOLO attempt on one problem. */
interface SoloOutcome {
  supported: boolean
  passed: boolean
  detail: string
  usage: SoloUsage | null
  provider?: string
  model?: string
  workspace?: string
}

/** The prompt the bare model sees: the same problem, the same rules. */
function buildSoloPrompt(problem: PublicProblem, setup: WorkspaceSetup): string {
  return [
    problem.objective,
    '',
    setup.graderNote,
    'Your solution must be a self-contained file (standard library only).',
    '',
    setup.constraints.map(rule => `- ${rule}`).join('\n'),
    '',
    'Write the COMPLETE content of every file listed below.',
    'Use this exact format, one block per file:',
    '',
    '### FILE: <path>',
    '<the complete file content>',
    '',
    `Files to write: ${setup.solutionFiles.join(', ')}`,
  ].join('\n')
}

/**
 * Drop the model's answer into the board's expected solution file(s).
 *
 * The SOLO arm has no tools, so the answer arrives as text. We take the
 * `### FILE:` blocks when the model used them, and fall back to the whole
 * answer for a single-file board (a model that just wrote the code).
 */
async function writeSoloFiles(
  workspace: string,
  files: string[],
  text: string,
): Promise<{ ok: boolean; written: string[]; reason?: string }> {
  if (files.length === 0) {
    return { ok: false, written: [], reason: 'no expected solution file for this board' }
  }
  const blocks = parseSoloFileBlocks(text)
  const contents = new Map<string, string>()
  for (const block of blocks) {
    for (const file of files) {
      if (contents.has(file)) continue
      if (sameFile(block.path, file)) {
        contents.set(file, block.content.replace(/\s+$/, '') + '\n')
        break
      }
    }
  }
  if (contents.size === 0 && blocks.length === 0 && files.length === 1) {
    contents.set(files[0], stripCodeFence(text).replace(/\s+$/, '') + '\n')
  }
  if (contents.size === 0) {
    return {
      ok: false,
      written: [],
      reason:
        `the model answered without a parsable file block for ${files.join(', ')}` +
        (blocks.length > 0 ? ` (it named: ${blocks.map(block => block.path).join(', ')})` : ''),
    }
  }
  const written: string[] = []
  for (const file of files) {
    const content = contents.get(file)
    if (content === undefined) continue
    const target = join(workspace, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    written.push(file)
  }
  if (written.length === 0) {
    return { ok: false, written, reason: 'none of the expected solution files could be matched' }
  }
  return { ok: true, written }
}

/**
 * Run ONE solo attempt: the bare model, the same problem, the same
 * workspace setup, the same board grader.
 */
async function runSoloSample(
  ctx: RunOneContext & { baseRunId: string; sampleIndex: number; support: SoloSupport; model: string },
): Promise<SoloOutcome> {
  const { adapter, problem, options, batchId, batchDir, support, model } = ctx
  const runId = `${ctx.baseRunId}-solo-s${ctx.sampleIndex}`
  const runDir = join(batchDir, runId)
  const workspace = join(runDir, 'workspace')
  await mkdir(workspace, { recursive: true })

  const setup = await prepareBoardWorkspace(
    options.board,
    workspace,
    problem,
    options.datasetPath,
    ctx.gradeCommand,
  )

  const usageBefore = usageSnapshot()
  let text = ''
  let provider = ''
  let calledModel = ''
  let failure: string | undefined
  try {
    const router = createModelRouter(process.env)
    const answer = await router.complete(
      {
        capability: 'coding',
        ...(model.length > 0 ? { preferredModel: model } : {}),
        seat: 'solo',
      },
      buildSoloPrompt(problem, setup),
    )
    provider = answer.route.provider
    calledModel = answer.route.model
    text = answer.text
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : String(error)
  }

  const usageModels = usageDiff(usageBefore, usageSnapshot())
  const promptTokens = usageModels.reduce((sum, row) => sum + row.promptTokens, 0)
  const completionTokens = usageModels.reduce((sum, row) => sum + row.completionTokens, 0)
  const costs = usageModels.map(row => estimateCostUsd(row)).filter(cost => cost !== null)
  const usage: SoloUsage = {
    calls: usageModels.reduce((sum, row) => sum + row.calls, 0),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0) : null,
  }

  if (failure !== undefined) {
    return {
      supported: true,
      passed: false,
      detail: `solo model call failed: ${failure}`,
      usage,
      provider,
      model: calledModel,
      workspace,
    }
  }

  const written = await writeSoloFiles(workspace, support.solutionFiles, text)
  if (!written.ok) {
    return {
      supported: true,
      passed: false,
      detail: `solo arm wrote no solution: ${written.reason ?? 'unknown reason'}`,
      usage,
      provider,
      model: calledModel,
      workspace,
    }
  }

  // The SAME board grader the Factory used, on the bare model's answer.
  const boardGrade = await adapter.grade(workspace, problem)
  return {
    supported: true,
    passed: boardGrade.passed,
    detail: boardGrade.detail.slice(0, 500),
    usage,
    provider,
    model: calledModel,
    workspace,
  }
}

/**
 * Run the SOLO arm for one problem (same sample budget, same early stop).
 */
async function runSoloProblem(
  ctx: RunOneContext & { baseRunId: string; model: string },
): Promise<SoloOutcome> {
  const { problem, options } = ctx
  const support = soloSupportFor(options.board, problem)
  if (!support.supported) {
    return {
      supported: false,
      passed: false,
      detail: `solo arm not supported for this board: ${support.reason ?? 'no known solution file'}`,
      usage: null,
    }
  }
  const maxSamples = options.samples ?? 1
  const samples: SoloOutcome[] = []
  await runUntilPass(async sampleIndex => {
    const sample = await runSoloSample({ ...ctx, sampleIndex, support })
    samples.push(sample)
    return { passed: sample.passed }
  }, maxSamples)

  const best = samples.find(sample => sample.passed) ?? samples[samples.length - 1]
  const usage = samples.reduce<SoloUsage | null>((sum, sample) => {
    if (!sample.usage) return sum
    if (!sum) return { ...sample.usage }
    return {
      calls: sum.calls + sample.usage.calls,
      promptTokens: sum.promptTokens + sample.usage.promptTokens,
      completionTokens: sum.completionTokens + sample.usage.completionTokens,
      totalTokens: sum.totalTokens + sample.usage.totalTokens,
      costUsd:
        sum.costUsd === null || sample.usage.costUsd === null
          ? null
          : sum.costUsd + sample.usage.costUsd,
    }
  }, null)
  return {
    supported: true,
    passed: best.passed,
    detail: best.detail,
    usage,
    provider: best.provider,
    model: best.model,
    workspace: best.workspace,
  }
}

export async function runBoard(options: BoardRunOptions): Promise<BoardSummary> {
  let adapter: PublicBenchAdapter
  if (options.board === 'aider') {
    adapter = createAiderAdapter(options.datasetPath)
  } else if (options.board === 'livecodebench') {
    adapter = createLiveCodeBenchAdapter(options.datasetPath)
  } else if (options.board === 'swebench') {
    adapter = createSweBenchAdapter(options.datasetPath)
  } else if (options.board === 'humaneval') {
    adapter = createHumanEvalAdapter(options.datasetPath)
  } else if (options.board === 'evalplus') {
    adapter = createEvalPlusAdapter(options.datasetPath)
  } else if (options.board === 'swebench-verified') {
    adapter = createSweVerifiedAdapter(options.datasetPath)
  } else if (options.board === 'swebench-live') {
    adapter = createSweLiveAdapter(options.datasetPath)
  } else if (options.board === 'multi-swe') {
    adapter = createMultiSweAdapter(options.datasetPath)
  } else {
    throw new Error(`Unknown board: ${options.board} (wired: humaneval, aider, livecodebench, swebench).`)
  }
  const offset = options.offset ?? 0
  const limit = options.limit ?? 5
  // Adapters stream slices where supported (lcb); the in-memory slice below
  // keeps humaneval/aider identical.
  const problems = await adapter.listProblems(limit, offset)
  const selected = problems.slice(0, limit)
  if (selected.length === 0) {
    throw new Error('No problems selected (check --limit/--offset against the dataset size).')
  }

  const batchId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const batchDir = join(options.outRoot, options.board, batchId)
  await mkdir(batchDir, { recursive: true })

  const gradeCommand = `${pythonBin()} grade_solution.py`
  const records: BoardProblemRecord[] = []
  for (const [index, problem] of selected.entries()) {
    records.push(await runOneProblem({ adapter, problem, index, options, batchId, batchDir, gradeCommand }))
  }

  const passed = records.filter(r => r.boardGrade.passed).length
  const liveProvider = resolveBatchProvider(process.env)
  const summary: BoardSummary = {
    board: options.board,
    mode: options.mode,
    runnerVersion: BOARD_RUNNER_VERSION,
    total: records.length,
    passed,
    passRate: records.length > 0 ? passed / records.length : 0,
    samplesUsed: records.reduce((s, r) => s + r.samplesUsed, 0),
    totalTokens: records.reduce((s, r) => s + r.usage.totalTokens, 0),
    durationMs: records.reduce((s, r) => s + r.durationMs, 0),
    datasetPath: options.datasetPath,
    batchDir,
    // The model that ACTUALLY ran this batch (not the local route's model
    // on a hosted route — that named the wrong model on every board run).
    model: resolveBatchModel(process.env, options.mode),
    serving: {
      provider: options.mode === 'live' ? liveProvider : 'deterministic',
      // The factory never sets temperature on any route (verified: no
      // temperature key in factory/ — only an unrelated max_tokens cap in
      // ask-specialist). Upstream default applies; recorded, not assumed.
      temperature: 'upstream-default (not set by factory)',
      // The MODEL's own window, from the model registry. An unknown model
      // reports null ("unknown") — a guessed window is worse than none.
      // Non-local routes report no factory-side ceiling.
      contextWindow: resolveBatchContextWindow(process.env, options.mode),
    },
    // SOLO-vs-FACTORY: null when the ablation did not run.
    ablation: summarizeAblation(records),
  }
  await writeFile(
    join(batchDir, 'records.jsonl'),
    records.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  return summary
}

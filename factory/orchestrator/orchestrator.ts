import type {
  AgentContext,
  AgentOutput,
  AgentRoleId,
} from '../agents/types'

import {
  AgentRegistry,
} from '../agents'

import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts'

import type {
  SpecialistGateFailure,
} from '../agents/role-runners'

import {
  toStringList,
} from '../agents/text-list'

import {
  scoreDifficulty,
} from '../agents/difficulty'

import {
  buildDiagnosisPrompt,
  parseRecoveryPlan,
  resolveRecoveryRounds,
} from './recovery'

import {
  buildCaptainAttemptPrompt,
  buildCaptainGuidance,
  CAPTAIN_LENSES,
  parseCaptainJudgment,
  pickCaptain,
  resolveCaptainEnabled,
  resolveCaptainMinScore,
  scoreAttempt,
  type CaptainCandidate,
  type CaptainLens,
} from './captain'

import {
  resolveExpansion,
  tallyReviewVotes,
} from './expansion'

import {
  KnowledgeBuilder,
} from '../knowledge'

import type {
  KnowledgeContext,
} from '../knowledge'

import type {
  AgentPlan,
  AgentStep,
  OrchestrationResult,
  RepairAttempt,
} from './types'

import type {
  AgentActivity,
  FactoryEventSink,
  FactoryEventType,
} from '../events'

import {
  existsSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'

import {
  join,
  dirname,
} from 'node:path'

export function isInfrastructureFailure(message: string | undefined | null): boolean {
  const text = String(message ?? '')
  return (
    /\b(530|524|502|503|504)\s*status code\b/i.test(text) ||
    /turn failed/i.test(text) ||
    /fetch failed/i.test(text) ||
    /\bUND_ERR\b/i.test(text) ||
    /socket (hang up|closed|reset)/i.test(text) ||
    /ECONN(?:RESET|REFUSED|CLOSED)/i.test(text) ||
    /timed? ?out/i.test(text) ||
    /connection (reset|refused)/i.test(text) ||
    /network error/i.test(text)
  )
}

export function isToolExecutionError(message: string | undefined | null): boolean {
  const text = String(message ?? '')
  return (
    /\bEISDIR\b/i.test(text) ||
    /\bENOENT\b/i.test(text) ||
    /\bENOTDIR\b/i.test(text) ||
    /\bEPERM\b/i.test(text) ||
    /illegal operation on a directory/i.test(text)
  )
}

export interface RoleRunnerDispatcher {
  get(
    role: AgentRoleId,
  ): {
    run(
      role: {
        id: AgentRoleId
        purpose: string
        buildPrompt(
          context: AgentContext,
        ): string
      },
      context: AgentContext,
    ): Promise<AgentOutput>
  }
}

export class DefaultRoleRunnerDispatcher
  implements RoleRunnerDispatcher {
  constructor(
    private readonly runners:
      ReadonlyMap<
        AgentRoleId,
        {
          run(
            role: {
              id: AgentRoleId
              purpose: string
              buildPrompt(
                context: AgentContext,
              ): string
            },
            context: AgentContext,
          ): Promise<AgentOutput>
        }
      >,
  ) {}

  get(
    role: AgentRoleId,
  ) {
    const runner =
      this.runners.get(
        role,
      )

    if (
      runner ===
      undefined
    ) {
      throw new Error(
        `No runner registered for role: ${role}`,
      )
    }

    return runner
  }
}

import {
  estimateCostUsd,
  usageDiff,
  usageSnapshot,
} from '../model-router/usage'
import { parseModelPool, getModelFit, probePool, setModelFit, VISION_PIXEL_PNG } from '../model-router/model-capabilities'
import type { ModelScore } from '../model-router/model-capabilities'
import {
  laneLineup,
  enabledPool,
  parseModelWeights,
} from '../model-router/model-weights'
import {
  assignPieces,
  expandNode,
  findNode,
  findMergeConflicts,
  makeRelayRoot,
  openLeaves,
  relayPiecePrompt,
  relayTreeComplete,
  reopenNode,
  resolveNode,
  resolveRelayDepth,
  resolveRelayEnabled,
  resolveRelayMaxRounds,
  resolveRelayProbeEnabled,
  resolveRelayRetries,
  resolveRelayWidth,
  splitRemainder,
  stuckLeaves,
  summarizeTree,
} from './relay'
import type { RelayNode } from './relay'
import {
  applyRelayMemory,
  recordRelayOutcome,
} from './relay-memory'
import { setRelaySnapshot, clearRelaySnapshot } from './relay-status'

export interface FactoryOrchestratorOptions {
  maxRepairAttempts?: number
  eventSink?: FactoryEventSink
  /**
   * Failure recovery (2026-09-23): a reasoning call used ONLY at the
   * repair ceiling to diagnose the failure history and write a fresh
   * plan. Injected (service wires the reasoning route) so tests stub
   * it and offline runs never need a model. Absent = historical
   * ceiling failure, byte-identical.
   */
  diagnoser?: (prompt: string) => Promise<string>
  /** Recovery rounds granted (explicit wins over env; default off). */
  recoveryRounds?: number
  /**
   * Captain fallback (2026-09-27): one diagnostic attempt per model
   * lens at the repair ceiling, injected (service wires the router
   * capabilities) so tests stub it and offline runs never need a
   * model. Absent (or `FACTORY_CAPTAIN` unset) = historical path,
   * byte-identical.
   */
  captainProber?: (lens: CaptainLens, prompt: string) => Promise<string>
  /**
   * Captain judge (2026-09-27): grades one diagnostic attempt into a
   * verdict plus still-open changes. Injected so tests stub it;
   * throw/unparseable scores that attempt 0, never the run.
   */
  captainJudge?: (
    lens: CaptainLens,
    attemptText: string,
  ) => Promise<{ passed: boolean; requiredChanges: string[] }>
  /**
   * Relay prober (2026-10-16, R-BS-14): grades every pool model once per
   * run when the fit registry is empty, so skill routing improves from
   * evidence instead of round-robining forever. Injected (service wires
   * the router) so tests stub it and offline runs never need a model.
   * Absent = historical round-robin, byte-identical.
   */
  relayProber?: (
    modelId: string,
    prompt: string,
    images?: string[],
  ) => Promise<string>
}

export interface OrchestratorRunOptions {
  /**
   * V1.7 hardening — cooperative preemption. Checked between stages and
   * before every repair retry; the live DSH host child is killed by the
   * executor on abort. In-flight model calls are not cancelled mid-flight.
   */
  signal?: AbortSignal
}

export interface RunBudgetLimits {
  maxTokens: number
  maxCostUsd: number
}

/**
 * V1.7 hardening — cost/token budgets. Resolved from
 * FACTORY_BUDGET_TOKENS / FACTORY_BUDGET_USD; unset or invalid means
 * unenforced (Infinity), preserving current behavior. Zero is a valid
 * explicit cap (any model usage stops further repair work).
 */
export function resolveRunBudget(): RunBudgetLimits {
  // NOTE: Number('') is 0, not NaN — an unset/blank variable must mean
  // "unenforced", never a zero cap (a zero cap fails every run on budget).
  const rawTokens = process.env.FACTORY_BUDGET_TOKENS?.trim() || ''
  const rawUsd = process.env.FACTORY_BUDGET_USD?.trim() || ''
  const tokens = rawTokens === '' ? Number.NaN : Number(rawTokens)
  const usd = rawUsd === '' ? Number.NaN : Number(rawUsd)
  return {
    maxTokens:
      Number.isFinite(tokens) && tokens >= 0
        ? tokens
        : Number.POSITIVE_INFINITY,
    maxCostUsd:
      Number.isFinite(usd) && usd >= 0
        ? usd
        : Number.POSITIVE_INFINITY,
  }
}

/**
 * R1 relentless loops - user-set repair ceiling. Resolved from
 * FACTORY_MAX_REPAIR_ATTEMPTS; unset or invalid means the classic
 * default 3, preserving current behavior. Zero is a valid explicit
 * cap (no retries). High values (50, 200) let small models converge
 * over many attempts instead of stopping early. The string `unlimited`
 * removes the repair ceiling entirely: the loop never stops on quality
 * — it stops only on abort, budget guards, or a passing run. That is
 * the never-stop-until-correct mode: your bill, your call (token/USD
 * budgets still guard money by design). The string `unlimited`
 * (or a negative number) removes the repair ceiling entirely: the loop
 * never stops on quality — it stops only on abort, budget guards, or a
 * passing run. That is the never-stop-until-correct mode: your bill,
 * your call (token/USD budgets still guard money by design).
 */
export function resolveMaxRepairAttempts(
  explicit?: number | string,
): number {
  if (
    typeof explicit === 'string' &&
    explicit.trim().toLowerCase() === 'unlimited'
  ) {
    return Number.POSITIVE_INFINITY
  }
  if (
    typeof explicit === 'number' &&
    Number.isFinite(explicit) &&
    explicit >= 0
  ) {
    return Math.floor(explicit)
  }

  const raw =
    process.env.FACTORY_MAX_REPAIR_ATTEMPTS?.trim() ||
    ''

  if (raw.toLowerCase() === 'unlimited') {
    return Number.POSITIVE_INFINITY
  }

  const parsed =
    raw === ''
      ? Number.NaN
      : Number(raw)

  return Number.isFinite(parsed) &&
    parsed >= 0
    ? Math.floor(parsed)
    : 3
}

/**
 * R4 ceilings that protect the user: when the repair ceiling bites, the
 * run must say exactly where it stands and how to resume - partial
 * progress is never a dead end. Appended to every ceiling-exhaustion
 * message (repair loops; abort/budget paths already name their cause).
 */
export function ceilingResumeHint(
  taskId: string,
  attemptsUsed: number,
): string {
  return (
    `Ceiling hit after ${attemptsUsed} recorded attempts ` +
    `(task ${taskId}). Resume: re-run this task - all attempts are ` +
    `preserved in the run history with the last failure above. ` +
    `Raise the ceiling with FACTORY_MAX_REPAIR_ATTEMPTS=<higher>.`
  )
}

/**
 * Controlled-execution contract gate (2026-09-19, V1.6 gobo lesson).
 *
 * The 3B model declares "completed" while contract files are still missing
 * (gobo never wrote server/notes.js). Write-path injection cannot help a
 * file never written, so the Factory — not the model — decides when a run
 * truly ends: every required file must exist on disk before the run counts.
 * Pure existence check (no imports); bootability is proven by the tester's
 * `node --test` verification step, which already gates the repair loop.
 */
export function checkContractGate(
  task: EngineeringTask,
): string[] {
  const requiredFiles =
    task.acceptance
      ?.requiredFiles ??
    []

  const missing: string[] = []

  for (
    const file of requiredFiles
  ) {
    const fullPath =
      join(
        task.workspace,
        file,
      )

    if (
      !existsSync(
        fullPath,
      )
    ) {
      missing.push(
        file,
      )
    }
  }

  return missing
}

/** Lane-diff skip list (pure data): dependency and history trees never count as piece work. */
const RELAY_DIFF_SKIP_DIRS = new Set(['node_modules', '.git'])

const RELAY_DIFF_MAX_FILES = 2000

/**
 * A seat's own numeric score, when it reported one (pure).
 *
 * Ballots are graded by verdict, not by a number, so this is usually null —
 * but a seat that DID hand back a number should not have it thrown away on
 * the way to the operator's dock.
 */
function laneScoreOf(output: AgentOutput | null): number | null {
  if (!output) return null
  const candidates: unknown[] = [
    (output as unknown as Record<string, unknown>).score,
    (output.review as unknown as Record<string, unknown> | undefined)?.score,
  ]
  for (const candidate of candidates) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate)
    ) {
      return candidate
    }
  }
  return null
}

function walkLaneFiles(dir: string, base: string, out: string[]): boolean {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (out.length >= RELAY_DIFF_MAX_FILES) return false
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (RELAY_DIFF_SKIP_DIRS.has(entry.name)) continue
      if (!walkLaneFiles(full, base, out)) return false
    } else if (entry.isFile()) {
      out.push(full.slice(base.length + 1))
    }
  }
  return true
}

/**
 * Lane diff (2026-10-16, R-BM-17): files the lane changed vs the live
 * workspace, by existence + size + bytes — never trusting filesChanged
 * alone, so silent lanes still land their work. Empty on walk failure
 * or over-cap trees (caller falls back to the reported list).
 */
export function diffLaneDir(baseDir: string, laneDir: string): string[] {
  const laneFiles: string[] = []
  if (!walkLaneFiles(laneDir, laneDir, laneFiles)) return []
  const changed: string[] = []
  for (const rel of laneFiles) {
    let laneStat
    try {
      laneStat = statSync(join(laneDir, rel))
    } catch {
      continue
    }
    let baseStat
    try {
      baseStat = statSync(join(baseDir, rel))
    } catch {
      changed.push(rel) // new file
      continue
    }
    if (!baseStat.isFile() || laneStat.size !== baseStat.size) {
      changed.push(rel)
      continue
    }
    try {
      if (!readFileSync(join(laneDir, rel)).equals(readFileSync(join(baseDir, rel)))) {
        changed.push(rel)
      }
    } catch {
      changed.push(rel)
    }
  }
  return changed
}

export class FactoryOrchestrator {
  private readonly registry:
    AgentRegistry

  private readonly dispatcher:
    RoleRunnerDispatcher

  private readonly maxRepairAttempts:
    number

  private readonly diagnoser?:
    (
      prompt: string,
    ) => Promise<string>

  private readonly recoveryRounds:
    number

  private readonly captainProber?:
    (
      lens: CaptainLens,
      prompt: string,
    ) => Promise<string>

  private readonly captainJudge?:
    (
      lens: CaptainLens,
      attemptText: string,
    ) => Promise<{ passed: boolean; requiredChanges: string[] }>

  private readonly relayProber?:
    (
      modelId: string,
      prompt: string,
      images?: string[],
    ) => Promise<string>

  private readonly knowledgeBuilder?:
    KnowledgeBuilder

  private readonly eventSink?:
    FactoryEventSink

  constructor(
    registry:
      AgentRegistry =
        new AgentRegistry(),

    dispatcher:
      RoleRunnerDispatcher,

    options:
      FactoryOrchestratorOptions =
        {},

    knowledgeBuilder?:
      KnowledgeBuilder,
  ) {
    this.registry =
      registry

    this.dispatcher =
      dispatcher

    this.maxRepairAttempts =
      resolveMaxRepairAttempts(
        options.maxRepairAttempts,
      )

    this.diagnoser =
      options.diagnoser

    this.recoveryRounds =
      resolveRecoveryRounds(
        options.recoveryRounds,
      )

    this.captainProber =
      options.captainProber

    this.captainJudge =
      options.captainJudge

    this.relayProber =
      options.relayProber

    this.eventSink =
      options.eventSink

    this.knowledgeBuilder =
      knowledgeBuilder
  }

  private async emit(
    type:
      FactoryEventType,

    taskId:
      string,

    payload:
      Record<string, unknown> = {},

    role?:
      string,
  ): Promise<void> {
    if (
      this.eventSink ===
      undefined
    ) {
      return
    }

    try {
      await this.eventSink.publish({
        id:
          crypto.randomUUID(),

        type,

        taskId,

        timestamp:
          new Date().toISOString(),

        role,

        payload,
      })
    } catch {
      /*
       * Event persistence must never
       * break engineering execution.
       */
    }
  }

  /**
   * Lane visibility (team runs): a lane is one seat of a parallel race.
   *
   * Every lane spoke the same role, so the operator's dock could only ever
   * show ONE coder — the last lane to report — and a two-model duel looked
   * like a single seat. These events name the lane, the model that ran it
   * and how it scored, so the crew is visible while it works.
   *
   * Publishing is never a run failure: the sink may be missing, slow or
   * broken, and a lost receipt must not fail the engineering work.
   */
  private async emitLane(
    type:
      | 'lane.started'
      | 'lane.completed'
      | 'lane.scored',
    taskId:
      string,
    payload:
      Record<string, unknown>,
    role?:
      string,
  ): Promise<void> {
    try {
      await this.emit(
        type,
        taskId,
        payload,
        role,
      )
    } catch {
      // Lane visibility is never a run failure.
    }
  }

  private buildAcceptanceChecks(
    task:
      EngineeringTask,

    verificationPassed:
      boolean,
  ) {
    const checks: Array<{
      criterion: string
      passed: boolean
      details?: string
    }> = []

    const requiredFiles =
      task.acceptance
        ?.requiredFiles ??
      []

    for (
      const file of requiredFiles
    ) {
      const fullPath =
        join(
          task.workspace,
          file,
        )

      const exists =
        existsSync(
          fullPath,
        )

      checks.push({
        criterion:
          `${file} exists`,

        passed:
          exists,

        details:
          exists
            ? `Found ${fullPath}`
            : `Missing ${fullPath}`,
      })
    }

    for (
      const criterion of
      task.acceptanceCriteria ??
      []
    ) {
      if (
        /verification\s+passes/i.test(
          criterion,
        )
      ) {
        checks.push({
          criterion,

          passed:
            verificationPassed,

          details:
            verificationPassed
              ? 'All verification commands passed.'
              : 'One or more verification commands failed.',
        })
      }
    }

    return checks
  }

  private mergeEngineeringResult(
    existing:
      EngineeringResult |
      undefined,

    task:
      EngineeringTask,

    tester:
      AgentOutput,
  ):
    EngineeringResult |
    undefined {
    if (
      existing ===
      undefined
    ) {
      return undefined
    }

    const verificationPassed =
      (
        tester.blockingIssues ??
        []
      ).length ===
      0

    const tests =
      (
        task.verification
          ?.testCommands ??
        []
      ).map(
        command => ({
          command,

          passed:
            verificationPassed,

          output:
            verificationPassed
              ? 'Verification command passed.'
              : (
                  tester.blockingIssues ??
                  []
                ).join(
                  '\n',
                ),
        }),
      )

    const acceptanceChecks =
      this.buildAcceptanceChecks(
        task,
        verificationPassed,
      )

    return {
      ...existing,

      tests,

      acceptanceChecks,
    }
  }

  createPlan(
    task: EngineeringTask,
  ): AgentPlan {
    return {
      taskId:
        task.id,

      steps: [
        'architect',
        'planner',
        'coder',
        'tester',
        'reviewer',
      ],
    }
  }

  async run(
    task: EngineeringTask,
    options: OrchestratorRunOptions = {},
  ): Promise<OrchestrationResult> {
    const signal = options.signal

    // V1.7 hardening — budgets bound repair work, not completed work: the
    // baseline is captured here, every repair retry checks spend since.
    const budget = resolveRunBudget()
    const usageBefore = usageSnapshot()
    clearRelaySnapshot()

    const spentTokens = (): number =>
      usageDiff(usageBefore, usageSnapshot()).reduce(
        (sum, record) => sum + record.promptTokens + record.completionTokens,
        0,
      )

    // Null when unpriced (non-local) usage exists: USD cannot be enforced
    // honestly, so only the token cap applies in that case.
    const spentCostUsd = (): number | null => {
      let total = 0
      for (const record of usageDiff(usageBefore, usageSnapshot())) {
        const cost = estimateCostUsd(record)
        if (
          cost === null &&
          record.promptTokens + record.completionTokens > 0
        ) {
          return null
        }
        total += cost ?? 0
      }
      return total
    }

    const budgetExceededReason = (): string | null => {
      const tokens = spentTokens()
      if (tokens >= budget.maxTokens) {
        return `Budget exceeded: ${tokens} tokens spent (cap ${budget.maxTokens}). No further repair work started.`
      }
      const cost = spentCostUsd()
      if (
        cost !== null &&
        cost >= budget.maxCostUsd
      ) {
        return `Budget exceeded: $${cost.toFixed(4)} spent (cap $${budget.maxCostUsd}). No further repair work started.`
      }
      return null
    }

    const isAborted = (): boolean =>
      signal?.aborted === true

    const plan =
      this.createPlan(
        task,
      )

    const steps:
      AgentStep[] =
      []

    const outputs:
      AgentOutput[] =
      []

    const blockingIssues:
      string[] =
      []

    const repairAttempts:
      RepairAttempt[] =
      []

    let engineeringResult:
      | EngineeringResult
      | undefined

    await this.emit(
      'task.created',
      task.id,
      {
        objective:
          task.objective,

        role:
          task.role,

        workspace:
          task.workspace,
      },
    )

    await this.emit(
      'task.started',
      task.id,
      {
        objective:
          task.objective,
      },
    )

    const blockedResult =
      async (
        reason:
          string,
      ): Promise<OrchestrationResult> => {
        if (
          blockingIssues.length ===
          0
        ) {
          blockingIssues.push(
            reason,
          )
        }

        await this.emit(
          'task.blocked',
          task.id,
          {
            blockingIssues,
          },
        )

        return {
          task,
          status:
            'blocked',
          plan,
          steps,
          finalOutput:
            outputs.at(-1),
          engineeringResult,
          blockingIssues,
          repairAttempts,
        }
      }

    const failedResult =
      async (
        issues:
          string[],
      ): Promise<OrchestrationResult> => {
        blockingIssues.push(
          ...issues,
        )

        await this.emit(
          'task.failed',
          task.id,
          {
            blockingIssues,
          },
        )

        return {
          task,
          status:
            'failed',
          plan,
          steps,
          finalOutput:
            outputs.at(-1),
          engineeringResult,
          blockingIssues,
          repairAttempts,
        }
      }

    // V1.7: a pre-aborted run never starts any stage work.
    if (isAborted()) {
      return failedResult([
        'Run aborted before execution started.',
      ])
    }

    // Failure recovery (2026-09-23): the ceiling is a diagnosis point,
    // not always the end. With rounds granted and a diagnoser wired,
    // the reasoner reads the failure history, writes a fresh plan that
    // lands as planner guidance, and the run earns one ceiling-sized
    // budget more. Anything missing (no rounds, no diagnoser, throw,
    // empty plan) fails exactly as history did. Returns null when the
    // run recovered (caller continues) or the failure result.
    let allowedRepairs = this.maxRepairAttempts
    let recoveriesUsed = 0

    const endAtCeiling = async (
      siteReason: string,
      issues: string[],
    ): Promise<OrchestrationResult | null> => {
      // Captain fallback (2026-09-27): each model lens gets one
      // diagnostic attempt at the failure; the best partial result at
      // or above the bar is nominated captain and guides the crew
      // retry. Solo attempts never ship — they only nominate. One
      // nomination consumes one recovery round; no qualifier (or any
      // throw) falls through to the diagnoser path below.
      if (
        recoveriesUsed < this.recoveryRounds &&
        resolveCaptainEnabled() &&
        this.captainProber !== undefined &&
        !isAborted()
      ) {
        try {
          const totalCriteria = task.acceptanceCriteria.length
          const minScore = resolveCaptainMinScore()
          const candidates: CaptainCandidate[] = []
          for (const lens of CAPTAIN_LENSES) {
            if (isAborted()) break
            let text = ''
            try {
              text = await this.captainProber(
                lens,
                buildCaptainAttemptPrompt(
                  lens,
                  {
                    objective: task.objective,
                    stack: task.stack,
                    role: task.role,
                  },
                  repairAttempts,
                ),
              )
            } catch {
              continue // one lens down is never all lenses down
            }
            let score = 0
            let requiredChanges: string[] = []
            try {
              const judgment = this.captainJudge
                ? await this.captainJudge(lens, text)
                : parseCaptainJudgment(text)
              requiredChanges = judgment.requiredChanges
              score = judgment.passed
                ? 100
                : scoreAttempt(totalCriteria, requiredChanges)
            } catch {
              score = 0 // an unjudgeable attempt nominates nobody
            }
            candidates.push({
              lens,
              score,
              attemptText: text.slice(0, 2000),
              requiredChanges,
            })
          }
          const captain = pickCaptain(candidates, minScore)
          if (captain !== null) {
            recoveriesUsed += 1
            allowedRepairs += Math.max(this.maxRepairAttempts, 1)
            const round = `diagnosis round ${recoveriesUsed}/${this.recoveryRounds}`
            const guidance = buildCaptainGuidance(captain, round)
            outputs.push({
              role: 'planner',
              summary: guidance.summary,
              findings: [],
              recommendations: guidance.recommendations,
              blockingIssues: [],
            })
            repairAttempts.push({
              attempt: repairAttempts.length + 1,
              reason: [
                `Captain ${captain.lens} nominated (${round}).`,
              ],
              reviewerFindings: [],
              requiredChanges: guidance.recommendations,
            })
            await this.emit(
              'repair.started',
              task.id,
              {
                attempt: repairAttempts.length,
                reason: `Captain ${captain.lens} nominated.`,
                reviewerFindings: [],
                requiredChanges: guidance.recommendations,
              },
              'planner',
            )
            return null
          }
        } catch {
          // Captain failure is never a new failure mode: diagnoser next.
        }
      }
      if (
        recoveriesUsed < this.recoveryRounds &&
        this.diagnoser !== undefined &&
        !isAborted()
      ) {
        try {
          const plan = parseRecoveryPlan(
            await this.diagnoser(
              buildDiagnosisPrompt(
                {
                  objective: task.objective,
                  stack: task.stack,
                  role: task.role,
                },
                repairAttempts,
              ),
            ),
          )
          if (plan.strategies.length > 0) {
            recoveriesUsed += 1
            allowedRepairs += Math.max(this.maxRepairAttempts, 1)
            outputs.push({
              role: 'planner',
              summary: `Recovery plan adopted (diagnosis round ${recoveriesUsed}/${this.recoveryRounds}).`,
              findings: plan.rootCause ? [plan.rootCause] : [],
              recommendations: plan.strategies,
              blockingIssues: [],
            })
            repairAttempts.push({
              attempt: repairAttempts.length + 1,
              reason: [
                `Recovery plan adopted (diagnosis round ${recoveriesUsed}/${this.recoveryRounds}).`,
              ],
              reviewerFindings: plan.rootCause ? [plan.rootCause] : [],
              requiredChanges: plan.strategies,
            })
            await this.emit(
              'repair.started',
              task.id,
              {
                attempt: repairAttempts.length,
                reason: 'Recovery plan adopted.',
                reviewerFindings: plan.rootCause ? [plan.rootCause] : [],
                requiredChanges: plan.strategies,
              },
              'planner',
            )
            return null
          }
        } catch {
          // Diagnosis failure is never a new failure mode.
        }
      }
      return failedResult([
        siteReason,
        ...issues,
        ceilingResumeHint(task.id, repairAttempts.length),
      ])
    }

    // Expansion lanes (2026-09-23): duel/vote run the SAME role logic
    // in isolated sinks so parallel lanes never interleave shared
    // evidence. Solo calls omit `lane` and behave byte-identically.
    interface LaneRun {
      task: EngineeringTask
      prevOutputs: AgentOutput[]
      knowledge?: KnowledgeContext
      sink: {
        outputs: AgentOutput[]
        steps: AgentStep[]
        blockingIssues: string[]
        engineeringResult: EngineeringResult | undefined
      }
    }

    const runRole =
      async (
        roleId:
          AgentRoleId,

        options: {
          allowBlockingOutput?:
            boolean
        } = {},

        lane?:
          LaneRun,
      ): Promise<AgentOutput | null> => {
        const laneTask =
          lane?.task ??
          task

        const laneOutputs =
          lane?.sink.outputs ??
          outputs

        const laneSteps =
          lane?.sink.steps ??
          steps

        const laneBlocking =
          lane?.sink.blockingIssues ??
          blockingIssues

        const getResult =
          ():
            | EngineeringResult
            | undefined =>
            lane
              ? lane.sink
                  .engineeringResult
              : engineeringResult

        const setResult = (
          value:
            | EngineeringResult
            | undefined,
        ): void => {
          if (lane) {
            lane.sink.engineeringResult =
              value
          } else {
            engineeringResult =
              value
          }
        }

        const role =
          this.registry.get(
            roleId,
          )

        const runner =
          this.dispatcher.get(
            roleId,
          )

        const step:
          AgentStep = {
          role:
            roleId,

          status:
            'running',
        }

        laneSteps.push(
          step,
        )

        // V1.7: cooperative preemption — a role never starts after abort.
        // The failure surfaces through the existing stage-failure branches,
        // which check the signal first and report abortion, not stage error.
        if (isAborted()) {
          step.status = 'failed'

          laneBlocking.push(
            `Run aborted before role ${roleId}.`,
          )

          await this.emit(
            'agent.completed',
            task.id,
            {
              role: roleId,
              status: 'aborted',
            },
            roleId,
          )

          return null
        }

        const startedEvent =
          roleId ===
          'tester'
            ? 'verification.started'
            : roleId ===
                'reviewer'
              ? 'review.started'
              : 'agent.started'

        await this.emit(
          startedEvent,
          task.id,
          {
            role:
              roleId,
          },
          roleId,
        )

        try {
          // Lanes reuse one prebuilt knowledge pack (same files, copied
          // dirs) so parallel lanes never race the skill backend.
          const knowledge =
            lane?.knowledge ??
            (this.knowledgeBuilder
              ? await this.knowledgeBuilder.build(
                  {
                    objective:
                      laneTask.objective,

                    role:
                      roleId,

                    stack:
                      laneTask.stack,

                    workspace:
                      laneTask.workspace,

                    maxSkills:
                      roleId ===
                      'reviewer'
                        ? 4
                        : 3,
                  },
                )
              : undefined)

          const context:
            AgentContext = {
            task:
              laneTask,

            workspace:
              laneTask.workspace,

            previousOutputs:
              lane?.prevOutputs ?? [
                ...outputs,
              ],

            knowledge,

            reportToolCall:
              (
                tool: string,
                payload:
                  Record<
                    string,
                    unknown
                  > = {},
              ) => {
                void this.emit(
                  'tool.called',
                  task.id,
                  {
                    tool,
                    ...payload,
                  },
                  roleId,
                )
              },

            // Live activity: what the seat is doing WHILE it does it. The
            // lifecycle rows say a seat started and that it finished; between
            // them the run was a silence, and the operator could not tell a
            // working seat from a dead one (operator, 2026-11-04).
            reportActivity:
              (
                activity: AgentActivity,
              ) => {
                void this.emit(
                  'agent.activity',
                  task.id,
                  {
                    ...activity,
                  },
                  roleId,
                )
              },
          }

          // B135: infrastructure failures (tunnel drops, 530/524, fetch
          // failed, socket drops, timeouts) are retried inside the SAME
          // attempt. They never charge a repair and never mark the task
          // failed on their own - only code that fails verification does.
          let output!: AgentOutput
          let infraRetries = 0
          const MAX_INFRA_RETRIES = 3
          while (true) {
            try {
              output = await runner.run(
                role,
                context,
              )
              break
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error)
              if (
                isInfrastructureFailure(message) &&
                infraRetries < MAX_INFRA_RETRIES
              ) {
                infraRetries += 1
                await new Promise(resolve =>
                  setTimeout(resolve, 1000 * infraRetries),
                )
                continue
              }
              // B135/B137: once retries are exhausted (or the failure is an
              // infra error / tool-execution error), do NOT throw (a throw
              // here becomes a charged repair attempt). Record the failure as
              // a blocking issue and return null (abort-like): no repair
              // charged, task fails with an honest reason.
              if (isInfrastructureFailure(message) || isToolExecutionError(message)) {
                const kind = isInfrastructureFailure(message) ? 'Infrastructure' : 'Tool execution'
                const note = `${kind} failure during ${roleId}: ${message}`
                laneBlocking.push(note)
                step.status = 'failed'
                await this.emit(
                  'agent.completed',
                  task.id,
                  {
                    role: roleId,
                    status: 'failed',
                    blockingIssues: [note],
                  },
                  roleId,
                )
                return null
              }
              throw error
            }
          }

          if (
            output.engineeringResult !==
            undefined
          ) {
            setResult(
              output.engineeringResult,
            )
          }

          if (
            roleId ===
              'tester' &&
            getResult() !==
              undefined
          ) {
            setResult(
              this.mergeEngineeringResult(
                getResult() as EngineeringResult,
                laneTask,
                output,
              ),
            )
          }

          step.output =
            output

          const hasBlockingIssues =
            (
              output.blockingIssues ??
              []
            ).length >
            0

          if (
            hasBlockingIssues &&
            options.allowBlockingOutput
          ) {
            step.status =
              'failed'

            laneOutputs.push(
              output,
            )

            const completedEvent =
              roleId ===
              'tester'
                ? 'verification.completed'
                : roleId ===
                    'reviewer'
                  ? 'review.completed'
                  : 'agent.completed'

            await this.emit(
              completedEvent,
              task.id,
              {
                role:
                  roleId,

                status:
                  'failed',

                blockingIssues:
                  output.blockingIssues ??
                  [],
              },
              roleId,
            )

            return output
          }

          if (
            hasBlockingIssues
          ) {
            step.status =
              'failed'

            laneBlocking.push(
              ...(
                output.blockingIssues ??
                []
              ),
            )

            const completedEvent =
              roleId ===
              'tester'
                ? 'verification.completed'
                : roleId ===
                    'reviewer'
                  ? 'review.completed'
                  : 'agent.completed'

            await this.emit(
              completedEvent,
              task.id,
              {
                role:
                  roleId,

                status:
                  'failed',

                blockingIssues:
                  output.blockingIssues ??
                  [],
              },
              roleId,
            )

            return null
          }

          step.status =
            'completed'

          laneOutputs.push(
            output,
          )

          const completedEvent =
            roleId ===
            'tester'
              ? 'verification.completed'
              : roleId ===
                  'reviewer'
                ? 'review.completed'
                : 'agent.completed'

          const reviewStatus =
            roleId ===
              'reviewer'
              ? output.review
                  ?.verdict ??
                'unknown'
              : undefined

          await this.emit(
            completedEvent,
            task.id,
            {
              role:
                roleId,

              status:
                roleId ===
                'reviewer'
                  ? reviewStatus
                  : 'completed',
            },
            roleId,
          )

          return output
        } catch (
          error: unknown
        ) {
          step.status =
            'failed'

          const message =
            error instanceof
            Error
              ? error.message
              : String(
                  error,
                )

          step.error =
            message

          const completedEvent =
            roleId ===
            'tester'
              ? 'verification.completed'
              : roleId ===
                  'reviewer'
                ? 'review.completed'
                : 'agent.completed'

          await this.emit(
            completedEvent,
            task.id,
            {
              role:
                roleId,

              status:
                'failed',

              error:
                message,
            },
            roleId,
          )

          laneBlocking.push(
            `${roleId} failed: ${message}`,
          )

          return null
        }
      }

    // Expansion execution (2026-09-23): the Factory's team shapes.
    // runCoderDuel races N coder lanes in isolated workspace copies;
    // the tester grades every lane and the winner lands back in the
    // task workspace. runReviewVote takes N verdicts on one evidence
    // set; majority rules, ties fail. Both fail open to solo paths
    // below when setup is impossible; budgets/abort bound new lanes,
    // in-flight lanes are bounded by existing host timeouts.
    const buildLaneKnowledge = async (
      roleId: AgentRoleId,
      workspace: string,
    ): Promise<KnowledgeContext | undefined> =>
      this.knowledgeBuilder
        ? await this.knowledgeBuilder.build({
            objective: task.objective,
            role: roleId,
            stack: task.stack,
            workspace,
            maxSkills: roleId === 'reviewer' ? 4 : 3,
          })
        : undefined

    const freshSink = (): {
      outputs: AgentOutput[]
      steps: AgentStep[]
      blockingIssues: string[]
      engineeringResult: EngineeringResult | undefined
    } => ({
      outputs: [],
      steps: [],
      blockingIssues: [],
      engineeringResult: undefined,
    })

    const cleanupLaneDirs = (dirs: string[]): void => {
      for (const dir of dirs) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Lane cleanup is hygiene, never a run failure.
        }
      }
    }

    const runCoderDuel = async (
      width: number,
      repairRound: number,
    ): Promise<
      | { ok: true; coder: AgentOutput | null; tester: AgentOutput | null }
      | { ok: false; failures: string[] }
    > => {
      // No workspace on disk (unit-test tasks) → run the solo pair so
      // the shared stage-failure blocks below handle every outcome.
      if (!existsSync(task.workspace)) {
        const coder = await runRole('coder')
        const tester =
          coder === null
            ? null
            : await runRole('tester', { allowBlockingOutput: true })
        return { ok: true, coder, tester }
      }

      const overBudget = budgetExceededReason()
      if (overBudget !== null || isAborted()) {
        return {
          ok: false,
          failures: [
            overBudget ?? 'Run aborted before duel lanes started.',
          ],
        }
      }

      const coderKnowledge = await buildLaneKnowledge('coder', task.workspace)
      const testerKnowledge = await buildLaneKnowledge('tester', task.workspace)
      const prevOutputs = [...outputs]

      const dirs: string[] = []
      const lanes: { dir: string; ready: boolean }[] = []
      for (let index = 0; index < width; index += 1) {
        const dir = `${task.workspace}.duel-r${repairRound}-l${index}`
        try {
          rmSync(dir, { recursive: true, force: true })
          cpSync(task.workspace, dir, { recursive: true })
          dirs.push(dir)
          lanes.push({ dir, ready: true })
        } catch (error) {
          lanes.push({ dir, ready: false })
        }
      }

      // Heterogeneous team (2026-10-13): lane i runs pool model i per
      // the operator's weights, so N pooled models all work the same
      // question. Empty pool / all-muted = no pins: every lane routes
      // legacy (single-model behavior, byte-identical).
      const pool = parseModelPool(process.env)
      const lineup = laneLineup(
        pool,
        parseModelWeights(process.env, pool.map(model => model.id)),
        lanes.length,
      )

      try {
        const grades = await Promise.all(
          lanes.map(async (lane, index) => {
            const sink = freshSink()
            // Lane identity: two coder lanes are two rows in the operator's
            // dock, and `duel-0` is the name that tells them apart.
            const laneLabel = `duel-${index}`
            const pin = lineup[index]
            const model = pin ?? ''
            if (!lane.ready || isAborted() || budgetExceededReason() !== null) {
              // The lane never ran. Say so: a dead lane must not look like a
              // lane that is merely quiet.
              await this.emitLane(
                'lane.completed',
                task.id,
                {
                  lane: laneLabel,
                  model,
                  role: 'coder',
                  ok: false,
                },
                'coder',
              )
              return {
                index,
                dir: lane.dir,
                sink,
                coder: null,
                tester: null,
                issues: Number.MAX_SAFE_INTEGER,
                note: lane.ready
                  ? 'Lane skipped: abort or budget trip before start.'
                  : 'Lane setup failed: workspace copy failed.',
              }
            }
            await this.emitLane(
              'lane.started',
              task.id,
              {
                lane: laneLabel,
                model,
                role: 'coder',
                round: repairRound,
              },
              'coder',
            )
            const laneTask: EngineeringTask = {
              ...task,
              workspace: lane.dir,
              ...(pin
                ? {
                    modelRequirements: {
                      ...(task.modelRequirements ?? {}),
                      preferredModel: pin,
                    },
                  }
                : {}),
            }
            const coder = await runRole(
              'coder',
              {},
              { task: laneTask, prevOutputs, knowledge: coderKnowledge, sink },
            )
            const tester =
              coder === null
                ? null
                : await runRole(
                    'tester',
                    { allowBlockingOutput: true },
                    { task: laneTask, prevOutputs, knowledge: testerKnowledge, sink },
                  )
            const laneIssues =
              coder === null || tester === null
                ? Number.MAX_SAFE_INTEGER
                : (tester.blockingIssues ?? []).length
            await this.emitLane(
              'lane.completed',
              task.id,
              {
                lane: laneLabel,
                model,
                role: 'coder',
                ok: coder !== null && tester !== null,
              },
              'coder',
            )
            // The grade: how many blocking issues the tester found in this
            // lane. A lane that produced no grade has NO score — null, never
            // a fake zero that would look like a clean lane.
            await this.emitLane(
              'lane.scored',
              task.id,
              {
                lane: laneLabel,
                model,
                score:
                  laneIssues ===
                  Number.MAX_SAFE_INTEGER
                    ? null
                    : laneIssues,
                detail:
                  laneIssues ===
                  Number.MAX_SAFE_INTEGER
                    ? 'lane produced no grade'
                    : `${laneIssues} blocking issue${laneIssues === 1 ? '' : 's'}`,
              },
              'coder',
            )
            return {
              index,
              dir: lane.dir,
              sink,
              coder,
              tester,
              issues: laneIssues,
              note: null as string | null,
            }
          }),
        )

        grades.sort((a, b) => a.issues - b.issues || a.index - b.index)
        const winner = grades[0]

        if (winner.issues === Number.MAX_SAFE_INTEGER) {
          return {
            ok: false,
            failures: grades.map((grade, position) => {
              const detail =
                grade.note ??
                (grade.sink.blockingIssues.length > 0
                  ? grade.sink.blockingIssues.slice(0, 3).join(' | ')
                  : 'coder produced no output')
              return `Lane ${grade.index}: ${detail} (rank ${position + 1}/${grades.length})`
            }),
          }
        }

        // Winner lands: evidence + steps merge in lane order, files copy
        // back so every downstream gate runs on the task workspace.
        for (const grade of grades) {
          steps.push(...grade.sink.steps)
        }
        if (winner.coder) outputs.push(winner.coder)
        if (winner.tester) outputs.push(winner.tester)
        if (winner.sink.engineeringResult !== undefined) {
          engineeringResult = winner.sink.engineeringResult
        }
        cpSync(winner.dir, task.workspace, { recursive: true })
        return { ok: true, coder: winner.coder, tester: winner.tester }
      } finally {
        cleanupLaneDirs(dirs)
      }
    }

    const runReviewVote = async (
      width: number,
      repairRound: number,
    ): Promise<
      | { aborted: true }
      | { verdict: 'fail'; findings: string[] }
      | { verdict: 'pass'; output: AgentOutput }
    > => {
      const knowledge = await buildLaneKnowledge('reviewer', task.workspace)
      const prevOutputs = [...outputs]
      // Heterogeneous ballots (2026-10-13): ballot i is judged by pool
      // model i per the operator's weights. No pool = legacy routing.
      const votePool = parseModelPool(process.env)
      const voteLineup = laneLineup(
        votePool,
        parseModelWeights(process.env, votePool.map(model => model.id)),
        width,
      )
      const ballots = await Promise.all(
        Array.from({ length: width }, async (_, ballotIndex) => {
          const sink = freshSink()
          const ballotPin = voteLineup[ballotIndex]
          // A ballot is a lane too: `vote-0`, `vote-1`, ... each with the
          // model that cast it. The operator sees three ballots, not one
          // "reviewer" that keeps changing its mind.
          const laneLabel = `vote-${ballotIndex}`
          const model = ballotPin ?? ''
          const ballotTask: EngineeringTask = ballotPin
            ? {
                ...task,
                modelRequirements: {
                  ...(task.modelRequirements ?? {}),
                  preferredModel: ballotPin,
                },
              }
            : task
          await this.emitLane(
            'lane.started',
            task.id,
            {
              lane: laneLabel,
              model,
              role: 'reviewer',
              round: repairRound,
            },
            'reviewer',
          )
          const out = await runRole(
            'reviewer',
            { allowBlockingOutput: true },
            { task: ballotTask, prevOutputs, knowledge, sink },
          )
          // A missing or unusable verdict counts as a fail ballot, exactly
          // as the tally counts it.
          const verdict = out?.review?.verdict ?? 'fail'
          await this.emitLane(
            'lane.completed',
            task.id,
            {
              lane: laneLabel,
              model,
              role: 'reviewer',
              ok: verdict === 'pass',
            },
            'reviewer',
          )
          // Ballots are graded by verdict, not by a number; a seat that DID
          // report a numeric score keeps it.
          await this.emitLane(
            'lane.scored',
            task.id,
            {
              lane: laneLabel,
              model,
              score: laneScoreOf(out),
              detail: `verdict ${verdict}`,
            },
            'reviewer',
          )
          return { out, steps: sink.steps }
        }),
      )
      if (isAborted()) {
        return { aborted: true }
      }
      // Merge in ballot order so evidence stays deterministic.
      for (const ballot of ballots) {
        steps.push(...ballot.steps)
        if (ballot.out) outputs.push(ballot.out)
      }
      const tally = tallyReviewVotes(ballots.map(ballot => ballot.out ?? {}))
      if (tally.verdict === 'pass') {
        const passing = ballots.find(
          ballot => ballot.out?.review?.verdict === 'pass',
        )?.out
        if (passing) {
          return { verdict: 'pass', output: passing }
        }
      }
      const findings: string[] = [...tally.findings]
      for (const ballot of ballots) {
        if (ballot.out?.review?.verdict !== 'pass') {
          // `toStringList`, not `.map(change => change.slice(…))`: a small
          // model answers requiredChanges with objects often enough that the
          // raw call threw `change.slice is not a function` and killed a live
          // run at the review stage, after its work was already written (B149).
          findings.push(
            ...toStringList(ballot.out?.review?.requiredChanges).map(change =>
              `Ballot requires: ${change.slice(0, 300)}`,
            ),
          )
          findings.push(
            ...toStringList(ballot.out?.findings).map(finding =>
              finding.slice(0, 300),
            ),
          )
        }
      }
      return { verdict: 'fail', findings }
    }

    // Relay round (2026-10-16): the remainder splits into pieces, each
    // piece races as an isolated lane pinned to its best-fit pool model,
    // winners merge back per touched file, failed pieces expand into
    // inner loops until the depth cap. Returns 'skip' when relay is off
    // or out of budget (caller takes the normal path), 'relayed' when a
    // round ran, 'landed' when the tree completed this round.
    const runRelayRound = async (
      failures: string[],
      repairRound: number,
    ): Promise<'skip' | 'relayed' | 'landed'> => {
      if (!resolveRelayEnabled()) return 'skip'
      if (isAborted()) return 'skip'
      if (budgetExceededReason() !== null) return 'skip'
      if (!existsSync(task.workspace)) return 'skip'
      const maxRelayRounds = resolveRelayMaxRounds()
      if (relayRoundsUsed >= maxRelayRounds) return 'skip'

      const poolIds = parseModelPool(process.env)
      const pool = enabledPool(
        poolIds,
        parseModelWeights(process.env, poolIds.map(model => model.id)),
      )
      // Relay width defaults to 4 lanes. Like duel/vote, that is fleet
      // arithmetic: with a single pooled model it puts four generations on one
      // GPU, so the tunnel starts cutting streams instead of the run finishing.
      // Clamp to the real pool size (never below 1).
      const relayPoolSize = pool.length
      const width = relayPoolSize > 0
        ? Math.max(1, Math.min(resolveRelayWidth(), relayPoolSize))
        : resolveRelayWidth()
      const maxDepth = resolveRelayDepth()
      const maxRetries = resolveRelayRetries()

      // Probe-on-first-relay (R-BS-14): with an empty registry the pool
      // grades itself once, so skill routing starts from evidence.
      // Fail-open: a dead prober keeps round-robin behavior.
      if (
        !relayProbed &&
        pool.length > 0 &&
        this.relayProber !== undefined &&
        resolveRelayProbeEnabled() &&
        getModelFit().pool.length === 0
      ) {
        relayProbed = true
        try {
          const probed = await probePool(pool, this.relayProber, [VISION_PIXEL_PNG])
          setModelFit(pool, probed)
        } catch {
          // Probe failure is never a run failure.
        }
      }
      if (relayBaseScores === null) {
        relayBaseScores = { ...getModelFit().scores }
      }
      const { scores } = getModelFit()

      if (relayTree !== null && relayTreeComplete(relayTree)) {
        relayTree = null // solved tree, fresh failures open a new loop
      }
      if (relayTree === null) {
        const fresh = makeRelayRoot(task.objective)
        expandNode(fresh, failures, pool, scores, width)
        relayTree = fresh
      }
      const leaves = openLeaves(relayTree)
      if (leaves.length === 0) return 'skip'
      relayRoundsUsed += 1

      const coderKnowledge = await buildLaneKnowledge('coder', task.workspace)
      const testerKnowledge = await buildLaneKnowledge('tester', task.workspace)
      const prevOutputs = [...outputs]

      const dirs: string[] = []
      const lanes: { dir: string; ready: boolean }[] = []
      for (let index = 0; index < leaves.length; index += 1) {
        const dir = `${task.workspace}.relay-r${repairRound}-p${index}`
        try {
          rmSync(dir, { recursive: true, force: true })
          cpSync(task.workspace, dir, { recursive: true })
          dirs.push(dir)
          lanes.push({ dir, ready: true })
        } catch {
          lanes.push({ dir, ready: false })
        }
      }

      try {
        const grades = await Promise.all(
          leaves.map(async (leaf, index) => {
            const sink = freshSink()
            const lane = lanes[index]!
            // The handoff: this piece goes to this seat, in this lane. The
            // lane label is what tells two relay pieces apart in the dock.
            const laneLabel = `relay-${index}`
            const model = leaf.assignee ?? ''
            if (!lane.ready || isAborted() || budgetExceededReason() !== null) {
              // The piece never ran. Say so: a dead lane must not look like a
              // lane that is merely quiet.
              await this.emitLane(
                'lane.completed',
                task.id,
                {
                  lane: laneLabel,
                  model,
                  role: 'coder',
                  ok: false,
                },
                'coder',
              )
              return {
                leaf,
                index,
                dir: lane.dir,
                sink,
                coder: null,
                tester: null,
                solved: false,
                issues: [
                  'Lane skipped: abort, budget trip, or workspace copy failed.',
                ],
              }
            }
            await this.emitLane(
              'lane.started',
              task.id,
              {
                lane: laneLabel,
                model,
                role: 'coder',
                round: repairRound,
              },
              'coder',
            )
            const laneTask: EngineeringTask = {
              ...task,
              workspace: lane.dir,
              objective:
                `${task.objective}\n\n${relayPiecePrompt(
                  { id: leaf.id, title: leaf.title, capability: leaf.capability },
                  'factory-team',
                  `relay round ${relayRoundsUsed}/${maxRelayRounds}`,
                  (relayTriesById.get(leaf.id) ?? 0) + 1,
                )}`,
              ...(leaf.assignee
                ? {
                    modelRequirements: {
                      ...(task.modelRequirements ?? {}),
                      preferredModel: leaf.assignee,
                    },
                  }
                : {}),
            }
            const coder = await runRole(
              'coder',
              {},
              { task: laneTask, prevOutputs, knowledge: coderKnowledge, sink },
            )
            const tester =
              coder === null
                ? null
                : await runRole(
                    'tester',
                    { allowBlockingOutput: true },
                    { task: laneTask, prevOutputs, knowledge: testerKnowledge, sink },
                  )
            const issues =
              coder === null || tester === null
                ? ['Coder produced no output.']
                : (tester.blockingIssues ?? [])
            await this.emitLane(
              'lane.completed',
              task.id,
              {
                lane: laneLabel,
                model,
                role: 'coder',
                ok: coder !== null && tester !== null,
              },
              'coder',
            )
            return {
              leaf,
              index,
              dir: lane.dir,
              sink,
              coder,
              tester,
              solved: issues.length === 0,
              issues,
            }
          }),
        )

        // Merge in piece order, touched files only, so simultaneous
        // pieces combine. A lone solved lane with no file list lands
        // whole (stub/small runners may not report filesChanged).
        const mergeFailed = new Set<string>()
        const solved = grades.filter(grade => grade.solved)
        for (const grade of grades) {
          steps.push(...grade.sink.steps)
        }
        for (const grade of solved) {
          if (grade.coder) outputs.push(grade.coder)
          if (grade.tester) outputs.push(grade.tester)
        }
        const landedFiles = new Map<string, string[]>()
        for (const grade of solved) {
          const reported = grade.sink.engineeringResult?.filesChanged ?? []
          // Trust-but-verify (R-BM-17): the diff catches what silent
          // lanes never report; the reported list catches renames and
          // moves the walk cannot see.
          const changed = [
            ...new Set([...reported, ...diffLaneDir(task.workspace, grade.dir)]),
          ]
          landedFiles.set(grade.leaf.id, changed)
          if (changed.length > 0) {
            for (const file of changed) {
              try {
                const src = join(grade.dir, file)
                if (!existsSync(src)) continue
                const dest = join(task.workspace, file)
                mkdirSync(dirname(dest), { recursive: true })
                cpSync(src, dest, { recursive: true })
              } catch {
                // One bad file never blocks the merge.
              }
            }
          } else if (solved.length === 1) {
            try {
              cpSync(grade.dir, task.workspace, { recursive: true })
            } catch {
              // A failed whole-copy un-solves the lane: the piece stays
              // open (or expands) instead of rejecting the whole run.
              mergeFailed.add(grade.leaf.id)
            }
          }
        }

        // Conflicts (R-BM-16): same file touched by two winners merges
        // last-writer-wins in piece order, but the clash is recorded so
        // the next round re-verifies the merged file instead of
        // trusting it.
        const conflicts = findMergeConflicts(
          solved
            .filter(grade => !mergeFailed.has(grade.leaf.id))
            .map(grade => ({
              id: grade.leaf.id,
              files: landedFiles.get(grade.leaf.id) ?? [],
            })),
        )
        if (conflicts.length > 0) {
          repairAttempts.push({
            attempt: repairRound + 1,
            reason: conflicts.map(
              conflict =>
                `Relay merge conflict on ${conflict.file} (pieces ${conflict.pieces.join(', ')}): last writer won, re-verify.`,
            ),
            reviewerFindings: conflicts.map(conflict => conflict.file),
            requiredChanges: conflicts.map(
              conflict => `Re-verify merged ${conflict.file}.`,
            ),
          })
        }

        for (const grade of grades) {
          const landed = grade.solved && !mergeFailed.has(grade.leaf.id)
          if (landed) {
            resolveNode(
              relayTree!,
              grade.leaf.id,
              true,
              (grade.coder?.summary ?? 'piece solved').slice(0, 1000),
            )
          } else {
            resolveNode(relayTree!, grade.leaf.id, false)
            const tries = (relayTriesById.get(grade.leaf.id) ?? 0) + 1
            relayTriesById.set(grade.leaf.id, tries)
            const leafIssues = mergeFailed.has(grade.leaf.id)
              ? ['Winner files could not land back (merge failed).']
              : grade.issues
            const node = findNode(relayTree!, grade.leaf.id)
            if (node && tries < maxRetries) {
              // Tries left: same piece goes again with an escalated
              // approach before it ever splits inward.
              reopenNode(relayTree!, grade.leaf.id)
            } else if (node && node.depth < maxDepth && !isAborted()) {
              expandNode(node, leafIssues, pool, scores, width)
            }
            repairAttempts.push({
              attempt: repairRound + 1,
              reason: [
                `Relay piece failed (round ${repairRound + 1}, ${grade.leaf.id} try ${tries}/${maxRetries} by ${grade.leaf.assignee || 'fallback'}).`,
              ],
              reviewerFindings: leafIssues.slice(0, 3),
              requiredChanges: leafIssues.slice(0, 3),
            })
          }
        }

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt: repairRound + 1,
            reason: `Relay: ${solved.length}/${grades.length} pieces solved.`,
            blockingIssues: grades.flatMap(grade =>
              grade.solved ? [] : grade.issues.slice(0, 2),
            ),
          },
          'coder',
        )

        const done = relayTreeComplete(relayTree)
        // Anti-thrash (R-BS-15): the round after a landing verifies the
        // merged work solo instead of dueling the whole task again.
        if (done) relayForceSolo = true
        // Operator visibility (R-BM-25): snapshot the live tree for status.
        const census = summarizeTree(relayTree)
        setRelaySnapshot({
          roundsUsed: relayRoundsUsed,
          maxRounds: maxRelayRounds,
          open: census.open,
          solved: census.done.length,
          failed: census.failed,
          stuck: stuckLeaves(relayTree, maxDepth).map(leaf => leaf.id),
        })
        // Learning write-back (R-BS-29): lane wins and losses fold into
        // fit scores, so the next round picks proven crew first.
        for (const grade of grades) {
          if (grade.leaf.assignee) {
            recordRelayOutcome(
              grade.leaf.assignee,
              grade.leaf.capability,
              grade.solved && !mergeFailed.has(grade.leaf.id),
            )
          }
        }
        if (relayBaseScores !== null) {
          setModelFit(pool, applyRelayMemory(relayBaseScores))
        }
        return done ? 'landed' : 'relayed'
      } finally {
        cleanupLaneDirs(dirs)
      }
    }

    if (
      !(await runRole(
        'architect',
      ))
    ) {
      if (isAborted()) {
        return failedResult([
          'Run aborted during architect stage.',
        ])
      }
      return blockedResult(
        'Architect stage failed.',
      )
    }

    if (
      !(await runRole(
        'planner',
      ))
    ) {
      if (isAborted()) {
        return failedResult([
          'Run aborted during planner stage.',
        ])
      }
      return blockedResult(
        'Planner stage failed.',
      )
    }

    // Full-catalog sweep runs at most once per task (max difficulty only).
    let catalogSwept = false

    // Relay team loop (2026-10-16): race+relay until done. The tree
    // persists across repair rounds; a completed tree rebuilds from
    // fresh failures, so race+relay repeats until everything verifies.
    let relayTree: RelayNode | null = null
    let relayRoundsUsed = 0
    let relayForceSolo = false
    let relayProbed = false
    let relayBaseScores: Record<string, ModelScore> | null = null
    const relayTriesById = new Map<string, number>()

    for (
      let repair = 0;
      ;
      repair += 1
    ) {
      // V1.7: no new repair work after abort or once the spend cap is hit.
      // Completed work is never failed on budget — only further retries stop.
      if (isAborted()) {
        return failedResult([
          'Run aborted before further repair work.',
        ])
      }
      const overBudget = budgetExceededReason()
      if (overBudget !== null) {
        return failedResult([
          overBudget,
        ])
      }

      // Expansion (2026-09-23): the Factory picks the work shape every
      // round from difficulty + repair history — solo, duel (coder
      // lanes race), or vote (reviewer ballots) — escalating on
      // failure. Low band stays solo: historical behavior byte-identical.
      // Anti-thrash (R-BS-15, 2026-10-16): the round after relay lands
      // verifies the merged work solo instead of dueling the whole task
      // again — one calm round, then the policy resumes.
      let expansion = resolveExpansion({
        level: scoreDifficulty({
          objective: task.objective,
          stack: task.stack,
          role: task.role,
          failedAttempts: repairAttempts.length,
        }).level,
        failedRounds: repairAttempts.length,
      })
      if (relayForceSolo) {
        relayForceSolo = false
        expansion = { mode: 'solo', duelWidth: 1, voteWidth: 1 }
      }
      // Fan-out follows the MODEL POOL, not the band (2026-11-01 live finding).
      // Duel/vote widths default to 2 and 3, which is right for a fleet of
      // different models — and wrong for one model on one GPU: the lanes
      // serialize on that single device, so a run took 8+ minutes, the Colab
      // tunnel cut the stream mid-generation (`Stream ended without
      // finish_reason`), and the same model dueled against itself for no
      // diversity at all. With a pool of N distinct models, N is the honest
      // ceiling; with one model the shape is solo, which is what the operator
      // actually has.
      const poolSize = parseModelPool(process.env).length
      if (poolSize > 0) {
        const capped = Math.max(1, poolSize)
        if (expansion.duelWidth > capped) expansion = { ...expansion, duelWidth: capped }
        if (expansion.voteWidth > capped) expansion = { ...expansion, voteWidth: capped }
        if (expansion.mode === 'duel' && expansion.duelWidth < 2) {
          expansion = { ...expansion, mode: 'solo', duelWidth: 1 }
        }
      }

      // Duel fills coder+tester from racing lanes; a total lane wipeout
      // repairs here, anything else flows into the shared blocks below.
      const duel =
        expansion.mode === 'duel' && expansion.duelWidth > 1
          ? await runCoderDuel(expansion.duelWidth, repair)
          : null

      if (duel !== null && !duel.ok) {
        // Wipeout enters relay first (R-BM-15): a race that fails
        // everywhere still feeds the team loop instead of dying here.
        if ((await runRelayRound(duel.failures, repair)) !== 'skip') {
          continue
        }
        // One entry per failed lane: each lane burned a prompt, and the
        // locked engine semantic is "each failed try is recorded" — a
        // shared round entry would hide half the spend.
        for (const [position, failure] of duel.failures.entries()) {
          repairAttempts.push({
            attempt: repair + 1,
            reason: [
              `Duel lane failed (round ${repair + 1}, rank ${position + 1}/${duel.failures.length}).`,
            ],
            reviewerFindings: [failure],
            requiredChanges: [failure],
          })
        }

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt: repair + 1,
            reason: `Duel: all ${expansion.duelWidth} coder lanes failed.`,
            blockingIssues: duel.failures,
          },
          'coder',
        )

        if (repair >= allowedRepairs) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after duel failure.',
            duel.failures,
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      const coder =
        duel !== null
          ? duel.coder
          : await runRole(
              'coder',
            )

      if (
        coder ===
        null
      ) {
        // V1.7: abortion is not a repair reason — stop without recording
        // another repair attempt.
        if (isAborted()) {
          return failedResult([
            'Run aborted during coder stage.',
          ])
        }
        // Controlled execution (2026-09-19): a coder failure (live: the DSH
        // host's internal verification/acceptance failed, e.g. gobo's missing
        // server/notes.js) enters the repair loop instead of blocking at the
        // coder stage with 0 repairs. The gate — not the model — decides.
        // The missing-file list rides in the repair record so the next DSH
        // prompt names the exact file to create (zhmb: 4 blind retries).
        const coderFailures =
          blockingIssues.splice(
            0,
          )

        const gateAfterCoder =
          checkContractGate(
            task,
          )

        const failures = [
          ...coderFailures,
          ...gateAfterCoder.map(
            file =>
              `Contract gate: missing required file ${file}. Create it with the exact contract exports, then run node --test.`,
          ),
        ]

        if ((await runRelayRound(failures, repair)) !== 'skip') {
          continue
        }

        repairAttempts.push({
          attempt:
            repair + 1,

          reason: [
            'Coder stage failed.',
          ],

          reviewerFindings:
            failures,

          requiredChanges:
            failures,
        })

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt:
              repair + 1,

            reason:
              'Coder stage failed.',

            blockingIssues:
              failures,
          },
          'coder',
        )

        if (
          repair >=
          allowedRepairs
        ) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after coder failure.',
            failures,
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      const tester =
        duel !== null
          ? duel.tester
          : await runRole(
              'tester',
              {
                allowBlockingOutput:
                  true,
              },
            )

      if (
        tester ===
        null
      ) {
        if (isAborted()) {
          return failedResult([
            'Run aborted during tester stage.',
          ])
        }
        return blockedResult(
          'Tester stage failed.',
        )
      }

      const testerFailed =
        (
          tester.blockingIssues ??
          []
        ).length >
        0

      if (
        testerFailed
      ) {
        const failures =
          tester.blockingIssues ??
          []

        if ((await runRelayRound(failures, repair)) !== 'skip') {
          continue
        }

        repairAttempts.push({
          attempt:
            repair + 1,

          reason: [
            'Factory verification failed.',
          ],

          reviewerFindings:
            failures,

          requiredChanges:
            failures,
        })

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt:
              repair + 1,

            reason:
              'Factory verification failed.',

            blockingIssues:
              failures,
          },
        )

        if (
          repair >=
          allowedRepairs
        ) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after verification failure.',
            failures,
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      // Controlled execution: the contract gate runs even when `node --test`
      // passes — a premature "completed" with files still missing (gobo:
      // notes.js never written) must repair, not proceed to review.
      const gateMissing =
        checkContractGate(
          task,
        )

      if (
        gateMissing.length >
        0
      ) {
        const failures =
          gateMissing.map(
            file =>
              `Contract gate: missing required file ${file}. Create it with the exact contract exports, then run node --test.`,
          )

        if ((await runRelayRound(failures, repair)) !== 'skip') {
          continue
        }

        repairAttempts.push({
          attempt:
            repair + 1,

          reason: [
            'Contract gate failed.',
          ],

          reviewerFindings:
            failures,

          requiredChanges:
            failures,
        })

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt:
              repair + 1,

            reason:
              'Contract gate failed.',

            blockingIssues:
              failures,
          },
          'tester',
        )

        if (
          repair >=
          allowedRepairs
        ) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after contract-gate failure.',
            failures,
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      // Vote takes N verdicts on one evidence set; majority rules, ties
      // fail into the shared repair path. Solo keeps the single call.
      const ballot =
        expansion.mode === 'vote' && expansion.voteWidth > 1
          ? await runReviewVote(expansion.voteWidth, repair)
          : null

      if (ballot !== null && 'aborted' in ballot) {
        return failedResult([
          'Run aborted during reviewer stage.',
        ])
      }

      if (ballot !== null && ballot.verdict === 'fail') {
        if ((await runRelayRound([...ballot.findings], repair)) !== 'skip') {
          continue
        }
        repairAttempts.push({
          attempt: repair + 1,
          reason: ['Reviewer vote rejected the implementation.'],
          reviewerFindings: ballot.findings,
          requiredChanges: ballot.findings,
        })

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt: repair + 1,
            reason: 'Reviewer vote rejected the implementation.',
            reviewerFindings: ballot.findings,
            requiredChanges: ballot.findings,
          },
          'reviewer',
        )

        if (repair >= allowedRepairs) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after reviewer vote failure.',
            ballot.findings,
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      const reviewer =
        ballot !== null
          ? ballot.output
          : await runRole(
              'reviewer',
              {
                allowBlockingOutput:
                  true,
              },
            )

      if (
        reviewer ===
        null
      ) {
        if (isAborted()) {
          return failedResult([
            'Run aborted during reviewer stage.',
          ])
        }
        return blockedResult(
          'Reviewer stage failed.',
        )
      }

      const review =
        reviewer.review

      if (
        review ===
        undefined
      ) {
        const reason =
          'Reviewer output was not valid JSON.'

        repairAttempts.push({
          attempt:
            repair + 1,

          reason: [
            reason,
          ],

          reviewerFindings:
            reviewer.findings ??
            [],

          requiredChanges: [
            'Reviewer must return valid JSON.',
          ],
        })

        await this.emit(
          'repair.started',
          task.id,
          {
            attempt:
              repair + 1,

            reason,
          },
          'reviewer',
        )

        if (
          repair >=
          allowedRepairs
        ) {
          const ending = await endAtCeiling(
            'Maximum repair attempts reached after reviewer output failure.',
            ['Reviewer must return valid JSON.'],
          )
          if (ending === null) {
            continue
          }
          return ending
        }

        continue
      }

      if (
        review.verdict ===
        'pass'
      ) {
        // Verification drives the end: even a reviewer pass cannot complete
        // the run while the contract gate is unmet.
        const gateAtEnd =
          checkContractGate(
            task,
          )

        if (
          gateAtEnd.length >
          0
        ) {
          const failures =
            gateAtEnd.map(
              file =>
                `Contract gate: missing required file ${file}. Create it with the exact contract exports, then run node --test.`,
            )

          repairAttempts.push({
            attempt:
              repair + 1,

            reason: [
              'Contract gate failed at review.',
            ],

            reviewerFindings:
              failures,

            requiredChanges:
              failures,
          })

          await this.emit(
            'repair.started',
            task.id,
            {
              attempt:
                repair + 1,

              reason:
                'Contract gate failed at review.',

              blockingIssues:
                failures,
            },
            'reviewer',
          )

          if (
            repair >=
            allowedRepairs
          ) {
            const ending = await endAtCeiling(
              'Maximum repair attempts reached after contract-gate failure at review.',
              failures,
            )
            if (ending === null) {
              continue
            }
            return ending
          }

          continue
        }

        // ECC specialist gate (small crew, phase 2): the difficulty meter
        // scores this round (repair history escalates the band) and the
        // selected specialists judge the same evidence. An explicit fail
        // repairs exactly like a reviewer rejection. Absent runners or
        // malformed output never block. At max difficulty the gate sweeps
        // the FULL catalog once per run (superpower fallback); later max
        // visits reuse the band cap.
        const difficulty = scoreDifficulty({
          objective: task.objective,
          stack: task.stack,
          role: task.role,
          failedAttempts: repairAttempts.length,
        })

        let specialistFailures: SpecialistGateFailure[] = []
        try {
          const reviewerRunner = this.dispatcher.get('reviewer') as unknown as {
            runSpecialistGate?: (
              outputs: AgentOutput[],
              task: EngineeringTask,
              options?: {
                maxAgents?: number
                sweepAll?: boolean
              },
            ) => Promise<SpecialistGateFailure[]>
          }
          if (typeof reviewerRunner.runSpecialistGate === 'function') {
            const sweepAll =
              difficulty.level === 'max' && !catalogSwept
            specialistFailures = await reviewerRunner.runSpecialistGate(
              outputs,
              task,
              {
                maxAgents: difficulty.maxAgents,
                sweepAll,
              },
            )
            if (sweepAll) {
              catalogSwept = true
            }
          }
        } catch {
          specialistFailures = []
        }

        if (specialistFailures.length > 0) {
          const specialistFindings = specialistFailures.flatMap(
            failure => [`[${failure.specialist}]`, ...failure.findings],
          )
          const specialistChanges = specialistFailures.flatMap(
            failure => failure.requiredChanges,
          )
          repairAttempts.push({
            attempt: repair + 1,
            reason: [
              `Specialist review rejected the implementation (difficulty: ${difficulty.level}).`,
            ],
            reviewerFindings: specialistFindings,
            requiredChanges: specialistChanges,
          })

          await this.emit(
            'repair.started',
            task.id,
            {
              attempt: repair + 1,
              reason: 'Specialist review rejected the implementation.',
              reviewerFindings: specialistFindings,
              requiredChanges: specialistChanges,
            },
            'reviewer',
          )

          if (repair >= allowedRepairs) {
            const ending = await endAtCeiling(
              'Maximum repair attempts reached after specialist rejection.',
              specialistChanges,
            )
            if (ending === null) {
              continue
            }
            return ending
          }

          continue
        }

        await this.emit(
          'task.completed',
          task.id,
          {
            status:
              'completed',
          },
        )

        return {
          task,
          status:
            'completed',
          plan,
          steps,
          finalOutput:
            reviewer,
          engineeringResult,
          blockingIssues: [],
          repairAttempts,
        }
      }

      const requiredChanges =
        toStringList(review.requiredChanges)

      if (
        (await runRelayRound(
          [...toStringList(review.findings), ...requiredChanges],
          repair,
        )) !== 'skip'
      ) {
        continue
      }

      repairAttempts.push({
        attempt:
          repair + 1,

        reason: [
          'Reviewer rejected the implementation.',
        ],

        reviewerFindings:
          review.findings,

        requiredChanges,
      })

      await this.emit(
        'repair.started',
        task.id,
        {
          attempt:
            repair + 1,

          reason:
            'Reviewer rejected the implementation.',

          reviewerFindings:
            review.findings,

          requiredChanges,
        },
        'reviewer',
      )

      if (
        repair >=
        allowedRepairs
      ) {
        const ending = await endAtCeiling(
          'Maximum repair attempts reached.',
          [...requiredChanges],
        )
        if (ending === null) {
          continue
        }
        return ending
      }
    }
  }
}
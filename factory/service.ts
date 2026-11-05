import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
} from './orchestrator'

import {
  ReadOnlyModelRunner,
  CodingRunner,
  TestingRunner,
  ReviewRunner,
} from './agents/role-runners'

import {
  createModelRouter,
  RegistryModelRouter,
} from './model-router'

import {
  DeterministicProvider,
} from './model-router/providers/deterministic'

import { AgentRegistry } from './agents'
import { FactoryExecutor } from './executor'
import { VerificationEngine } from './verification'

import {
  PersistentFactoryEventBus,
} from './events'

import { migrateLegacyState } from './state-migration'

import type {
  FactoryEvent,
} from './events'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  EccSkillAdapter,
  BuiltinSkillAdapter,
  GstackSkillAdapter,
  OdesignSkillAdapter,
  PocockSkillAdapter,
  RepowiseSkillAdapter,
  SkillSafetyAdapter,
  OutputDisciplineAdapter,
  UiVerifyAdapter,
  DesignReviewAdapter,
  SkillEvolutionAdapter,
  AddyQualityAdapter,
  ImpeccableAdapter,
  SkillAuthoringAdapter,
  ArchifyAdapter,
  CompositeSkillSource,
  KnowledgeBuilder,
} from './knowledge'

import {
  prepareTaskInput,
} from './context/input-window'

import {
  buildCaptainJudgePrompt,
  parseCaptainJudgment,
} from './orchestrator/captain'

import {
  askLaya,
  buildLayaGuardQuestions,
  buildLayaState,
  interpretGuard,
  resolveLayaConfig,
  shouldTriggerLaya,
} from './agents/laya-decider'

import type {
  EngineeringResult,
  EngineeringTask,
} from './contracts'

import { EVENTS_PATH, DSH_ROOT, DSH_AGENTS_HOME } from './paths'

import { resolve } from 'node:path'

import {
  usageSnapshot,
  usageDiff,
  estimateCostUsd,
} from './model-router/usage'

import type { UsageRecord } from './model-router/usage'

export interface FactoryService {
  run(
    task: EngineeringTask,
    options?: {
      signal?: AbortSignal
    },
  ): Promise<EngineeringResult>

  // D1 scale: bounded parallel lanes. Results preserve input order.
  // Every task MUST have a distinct workspace (isolation gate throws
  // on duplicates). One shared signal aborts all lanes; per-task
  // signals are D2 scope. Concurrency cap: options.maxParallel ??
  // FACTORY_MAX_PARALLEL ?? 1 (unset/invalid/0 floor to 1).
  //
  // D2 guardrails: options.signals[i] aborts lane i alone (abort-one);
  // options.signal (or a budget trip) aborts every lane (abort-all).
  // A lane that throws is recorded as a failed result - one lane can
  // never reject runMany or kill the others. options.budget caps
  // shared token/spend across lanes (usage registry); on trip, no new
  // lane starts and in-flight lanes are aborted. runMany only rejects
  // on the isolation-gate violation.
  runMany(
    tasks: EngineeringTask[],
    options?: {
      maxParallel?: number
      signal?: AbortSignal
      signals?: (AbortSignal | undefined)[]
      budget?: LaneBudget
    },
  ): Promise<EngineeringResult[]>

  events(
    taskId?: string,
  ): Promise<FactoryEvent[]>
}

export interface LaneBudget {
  maxTokens?: number
  maxUsd?: number
}

// D2 guardrails: pure shared-budget check over usage records.
// Returns the trip reason, or undefined while inside budget.
// Spend is fail-open: models with unknown pricing enforce the token
// cap only (never block on a cost that cannot be computed).
export function laneBudgetExceeded(
  records: UsageRecord[],
  budget: LaneBudget,
): string | undefined {
  const tokens = records.reduce(
    (sum, record) =>
      sum +
      record.promptTokens +
      record.completionTokens,
    0,
  )

  if (
    budget.maxTokens !== undefined &&
    tokens > budget.maxTokens
  ) {
    return `token budget exceeded (${tokens} > ${budget.maxTokens})`
  }

  if (budget.maxUsd !== undefined) {
    let cost = 0
    let unknown = false

    for (const record of records) {
      const estimate =
        estimateCostUsd(record)

      if (estimate === null) {
        unknown = true
      } else {
        cost += estimate
      }
    }

    if (
      !unknown &&
      cost > budget.maxUsd
    ) {
      return `spend budget exceeded ($${cost} > $${budget.maxUsd})`
    }
  }

  return undefined
}

function laneFailedResult(
  taskId: string,
  reason: string,
  diagnostics?: string,
): EngineeringResult {
  return {
    taskId,
    status: 'failed',
    summary: reason,
    output: '',
    filesChanged: [],
    tests: [],
    acceptanceChecks: [],
    diagnostics,
  }
}

function resolveMaxParallel(
  requested?: number,
): number {
  const raw =
    requested ??
    process.env.FACTORY_MAX_PARALLEL ??
    1

  const parsed =
    typeof raw === 'number'
      ? raw
      : Number.parseInt(
          String(raw),
          10,
        )

  return Number.isFinite(parsed) &&
    parsed >= 1
    ? Math.floor(parsed)
    : 1
}

export async function createFactoryService():
  Promise<FactoryService> {
  await migrateLegacyState()

  const eventBus =
    new PersistentFactoryEventBus({
      filePath: EVENTS_PATH,
    })

  const executionMode =
    (
      process.env.FACTORY_EXECUTION_MODE ??
      'live'
    ).trim().toLowerCase()

  const router =
    executionMode ===
    'deterministic'
      ? (() => {
          const deterministic =
            new RegistryModelRouter()

          deterministic.register(
            new DeterministicProvider(),
          )

          return deterministic
        })()
      : createModelRouter()

  const ctx =
    new Context()

  await ctx.plugin(
    SkillRegistry,
  )

  await ctx.plugin(
    SkillFileSystem,
    {
      dshHome:
        DSH_ROOT,
      agentsHome:
        DSH_AGENTS_HOME,
    },
  )

  // Knowledge: DSH packages first (incumbent), ECC playbooks appended
  // (dormant skills/ surface, woken 2026-09-21), Factory builtins next
  // (DDG search recipe — keyless discovery under fetch-only tools),
  // gstack doctrine next (investigate/cso/review checklists, distilled
  // 2026-09-24), design doctrine next (OpenDesign brief + frontend
  // build rules, distilled 2026-09-24), real-engineering doctrine next
  // (Pocock tdd/diagnosing/code-review, distilled 2026-09-24),
  // verification/memory doctrine next (repowise ladder + memory model,
  // distilled 2026-09-24 — the two patterns we lacked), skill-safety
  // next (SkillSpector pattern catalog distilled 2026-09-24 — vet what
  // the composite itself serves; scanner tool unadopted), output
  // discipline next (ADHD action-first outputs distilled 2026-09-24 —
  // terse machine-read handoffs between stages), DOM-first UI checks
  // next (page-agent text-DOM verification distilled 2026-09-24 — UI
  // asserts without screenshots or vision models), interface verdicts
  // next (krehel better-interface doctrine distilled 2026-09-24 —
  // scoped, evidenced, trigger-escalated UI review), skill evolution
  // next (microsoft SkillOpt doctrine distilled 2026-09-24 — gated
  // card updates: bounded patches, held-out validation, human
  // adoption), in-flight doubt + written constraints next (addyosmani
  // pair distilled 2026-09-24 — disprove-biased doubter, contract bar
  // with diff-watch), durable product truth next (impeccable doctrine
  // distilled 2026-09-24 — record-once truth vs per-surface direction),
  // skill authoring next (anthropics skill-creator distilled 2026-09-24
  // — trigger-accurate cards, draft-then-prove; source-available doc
  // skills excluded by license), evidence-grounded diagrams last
  // (archify doctrine distilled 2026-09-24 — typed spec, repo-inspected
  // facts, validate-before-handoff).
  // Relevance-ranked and char-capped downstream, so small-model ceilings hold.
  const knowledgeBuilder =
    new KnowledgeBuilder(
      new CompositeSkillSource(
        new CompositeSkillSource(
          new CompositeSkillSource(
            new CompositeSkillSource(
              new CompositeSkillSource(
                new CompositeSkillSource(
                  new CompositeSkillSource(
                    new CompositeSkillSource(
                      new CompositeSkillSource(
                        new CompositeSkillSource(
                          new DshSkillAdapter(ctx),
                          new EccSkillAdapter(),
                        ),
                        new BuiltinSkillAdapter(),
                      ),
                      new GstackSkillAdapter(),
                    ),
                    new OdesignSkillAdapter(),
                  ),
                  new PocockSkillAdapter(),
                ),
                new RepowiseSkillAdapter(),
              ),
              new SkillSafetyAdapter(),
            ),
            new OutputDisciplineAdapter(),
          ),
          new UiVerifyAdapter(),
        ),
        new CompositeSkillSource(
          new CompositeSkillSource(
            new CompositeSkillSource(
              new DesignReviewAdapter(),
              new SkillEvolutionAdapter(),
            ),
            new AddyQualityAdapter(),
          ),
          new CompositeSkillSource(
            new CompositeSkillSource(
              new ImpeccableAdapter(),
              new SkillAuthoringAdapter(),
            ),
            new ArchifyAdapter(),
          ),
        ),
      ),
    )

  const readOnlyRunner =
    new ReadOnlyModelRunner(
      router,
    )

  const executor =
    new FactoryExecutor({
      router,
    })

  const codingRunner =
    new CodingRunner(
      executor,
    )

  const testingRunner =
    new TestingRunner(
      new VerificationEngine(),
    )

  const reviewRunner =
    new ReviewRunner(
      router,
    )

  const dispatcher =
    new DefaultRoleRunnerDispatcher(
      new Map([
        [
          'architect',
          readOnlyRunner,
        ],
        [
          'planner',
          readOnlyRunner,
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

  const orchestrator =
    new FactoryOrchestrator(
      new AgentRegistry(),
      dispatcher,
      {
        eventSink:
          eventBus,
        // Failure recovery (2026-09-23): at the repair ceiling the
        // reasoning route diagnoses the failure history into a fresh
        // plan (R1 on the trio). Rounds come from the env
        // (`FACTORY_RECOVERY_ROUNDS`, default 0 = off until proven).
        diagnoser:
          prompt =>
            router
              .complete({ capability: 'reasoning' }, prompt)
              .then(response => response.text),
        // Captain fallback (2026-09-27): each lens attempts through
        // its own route (planner→reasoning, coder→coding,
        // vision→vision); the reasoning route judges each attempt.
        // Env-gated (`FACTORY_CAPTAIN=1`, default off); solo attempts
        // never ship, they only nominate.
        captainProber: (lens, prompt) =>
          router
            .complete(
              {
                capability:
                  lens === 'planner'
                    ? 'reasoning'
                    : lens === 'vision'
                      ? 'vision'
                      : 'coding',
              },
              prompt,
            )
            .then(response => response.text),
        captainJudge: (lens, attemptText) =>
          router
            .complete(
              { capability: 'reasoning' },
              buildCaptainJudgePrompt(lens, attemptText),
            )
            .then(response => parseCaptainJudgment(response.text)),
        // Relay prober (2026-10-16, R-BS-14): per-model skill grading
        // for the team loop; pins route each probe to its own model.
        relayProber: (modelId, prompt, images) =>
          router
            .complete(
              { capability: 'coding', preferredModel: modelId, images },
              prompt,
            )
            .then(response => response.text),
      },
      knowledgeBuilder,
    )

  const service: FactoryService = {
    async run(
      task: EngineeringTask,
      options: {
        signal?: AbortSignal
      } = {},
    ): Promise<EngineeringResult> {
      // Laya guard pre-pass (2026-09-23, optional, fail-open): when the
      // operator opts in (`FACTORY_LAYA_ENABLED=1` + local `laya-serve`),
      // score the task-only state on jailbreak/injection before the
      // expensive pipeline. Blocked tasks fail fast; laya down or
      // disabled means the run continues untouched (deterministic and
      // default runs never touch the network here).
      const layaConfig = resolveLayaConfig()
      if (layaConfig.enabled && shouldTriggerLaya(task) !== null) {
        try {
          const laya = await askLaya(
            buildLayaState(task),
            buildLayaGuardQuestions(),
            {
              baseURL: layaConfig.baseURL,
              apiKey: layaConfig.apiKey || undefined,
              timeoutMs: layaConfig.timeoutMs,
              maxCalls: layaConfig.maxCalls,
            },
          )
          const guard = interpretGuard(laya.answers, layaConfig.minConfidence)
          if (guard.blocked) {
            return {
              taskId: task.id,
              status: 'failed',
              summary: `Laya guard blocked: ${guard.hits.join(', ')}.`,
              output: '',
              filesChanged: [],
              tests: [],
              acceptanceChecks: [],
              diagnostics: `Laya guard blocked: ${guard.hits.join(', ')}.`,
            }
          }
        } catch {
          // Fail open by design: no guard verdict, no block.
        }
      }

      // Unlimited input window (2026-09-22): oversized task inputs are
      // split and distilled to a working brief (full text saved to
      // INPUT_FULL.md in the workspace) instead of dying on the model
      // ceiling or losing content to truncation. Fitting inputs pass
      // through untouched; distill failure degrades to truncation.
      // Spend surfaces in the usage registry like every other call.
      const prepared = await prepareTaskInput(
        task,
        prompt =>
          router
            .complete({ capability: 'reasoning' }, prompt)
            .then(response => response.text),
      )

      const orchestration =
        await orchestrator.run(
          prepared.task,
          {
            signal:
              options.signal,
          },
        )

      // The orchestration status is authoritative.
      // A coder may produce a successful EngineeringResult
      // even when a later tester/reviewer blocks the task.
      if (
        orchestration.status ===
          'completed' &&
        orchestration.engineeringResult !==
          undefined
      ) {
        return orchestration.engineeringResult
      }

      const failedStatus =
        orchestration.status ===
        'completed'
          ? 'completed'
          : 'failed'

      return {
        taskId:
          task.id,

        status:
          failedStatus,

        summary:
          orchestration.status ===
          'completed'
            ? 'Factory orchestration completed.'
            : orchestration.status ===
                'blocked'
              ? 'Factory orchestration was blocked.'
              : 'Factory orchestration failed.',

        output:
          orchestration.finalOutput
            ?.findings
            ?.join('\n') ?? '',

        filesChanged:
          orchestration.finalOutput
            ?.filesChanged ?? [],

        tests: [],

        acceptanceChecks: [],

        provider:
          orchestration.engineeringResult
            ?.provider,

        model:
          orchestration.engineeringResult
            ?.model,

        diagnostics:
          orchestration.blockingIssues
            .length > 0
            ? orchestration.blockingIssues.join(
                '\n',
              )
            : orchestration.status ===
                'blocked'
              ? 'Factory orchestration was blocked.'
              : undefined,
      }
    },

    async runMany(
      tasks: EngineeringTask[],
      options: {
        maxParallel?: number
        signal?: AbortSignal
        signals?: (AbortSignal | undefined)[]
        budget?: LaneBudget
      } = {},
    ): Promise<EngineeringResult[]> {
      if (tasks.length === 0) {
        return []
      }

      const seen =
        new Set<string>()

      for (const task of tasks) {
        const key = resolve(
          task.workspace,
        )

        if (seen.has(key)) {
          throw new Error(
            `runMany: duplicate workspace ${task.workspace} (parallel lanes must be isolated)`,
          )
        }

        seen.add(key)
      }

      const maxParallel =
        resolveMaxParallel(
          options.maxParallel,
        )

      // Budget trips abort in-flight lanes through this controller;
      // the trip reason marks lanes that never started.
      const budgetAbort =
        new AbortController()

      let budgetTripReason:
        | string
        | undefined

      const baseline =
        usageSnapshot()

      const laneSignal = (
        index: number,
      ): AbortSignal | undefined => {
        const candidates = [
          options.signals?.[index],
          options.signal,
          budgetAbort.signal,
        ].filter(
          (
            candidate,
          ): candidate is AbortSignal =>
            candidate !== undefined,
        )

        if (candidates.length === 0) {
          return undefined
        }

        if (candidates.length === 1) {
          return candidates[0]
        }

        return AbortSignal.any(
          candidates,
        )
      }

      const checkBudget = (): void => {
        if (
          options.budget ===
            undefined ||
          budgetTripReason !==
            undefined
        ) {
          return
        }

        const reason =
          laneBudgetExceeded(
            usageDiff(
              baseline,
              usageSnapshot(),
            ),
            options.budget,
          )

        if (reason !== undefined) {
          budgetTripReason = reason
          budgetAbort.abort(reason)
        }
      }

      const results =
        new Array<EngineeringResult>(
          tasks.length,
        )

      let next = 0

      const runLane =
        async (): Promise<void> => {
          while (true) {
            const index = next
            next += 1

            if (
              index >= tasks.length
            ) {
              return
            }

            if (
              budgetTripReason !==
              undefined
            ) {
              results[index] =
                laneFailedResult(
                  tasks[index].id,
                  'Lane never started: shared budget tripped.',
                  budgetTripReason,
                )

              continue
            }

            try {
              results[index] =
                await service.run(
                  tasks[index],
                  {
                    signal:
                      laneSignal(
                        index,
                      ),
                  },
                )
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error)

              results[index] =
                laneFailedResult(
                  tasks[index].id,
                  `Lane failed: ${message}`,
                  error instanceof Error
                    ? error.stack
                    : message,
                )
            }

            checkBudget()
          }
        }

      const lanes: Promise<void>[] =
        []

      for (
        let lane = 0;
        lane <
        Math.min(
          maxParallel,
          tasks.length,
        );
        lane += 1
      ) {
        lanes.push(runLane())
      }

      await Promise.all(lanes)

      return results
    },

    async events(
      taskId?: string,
    ): Promise<FactoryEvent[]> {
      return eventBus.list(
        taskId,
      )
    },
  }

  return service
}
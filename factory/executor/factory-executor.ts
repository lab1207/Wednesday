import {
  ChangeCollector,
} from '../changes'

import { AcceptanceChecker } from '../acceptance'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts/index'

import type {
  AgentActivity,
} from '../events/types'

import type {
  ModelRoute,
} from '../model-router/types'

import {
  createModelRouter,
  RegistryModelRouter,
  seatModelPin,
} from '../model-router/index'

import {
  VerificationEngine,
} from '../verification'

import {
  buildIdentitySection,
} from '../agents/identity'

import {
  HOST,
} from '../paths'

import {
  WorkspaceWatcher,
} from './workspace-watch'

import {
  consumeHostOutput,
  flushHostOutput,
  hostOutput,
} from './host-output'

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

export interface FactoryExecutorOptions {
  router?: RegistryModelRouter
  verification?: VerificationEngine
  changes?: ChangeCollector
  acceptance?: AcceptanceChecker
  /** Wall-clock cap for the live DSH host child. Overrides FACTORY_EXECUTOR_TIMEOUT_MS. */
  timeoutMs?: number
}

export const DEFAULT_EXECUTOR_TIMEOUT_MS = 1800000

/**
 * V1.7 hardening — timeouts. Resolves the live-host wall-clock cap:
 * explicit option wins, then FACTORY_EXECUTOR_TIMEOUT_MS, then the
 * 30-minute default (matches the live benchmark budget used in V1.6).
 * Non-finite/non-positive values fall back to the default so a typo can
 * never disable the cap or kill a run instantly.
 */
export function resolveExecutorTimeoutMs(explicit?: number): number {
  if (
    explicit !== undefined &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return explicit
  }
  const fromEnv = Number(
    process.env.FACTORY_EXECUTOR_TIMEOUT_MS?.trim() || '',
  )
  if (
    Number.isFinite(fromEnv) &&
    fromEnv > 0
  ) {
    return fromEnv
  }
  return DEFAULT_EXECUTOR_TIMEOUT_MS
}

/**
 * Workspace fail-fast (layer audit 2026-09-21): a missing task workspace
 * used to fall back to the install root silently, running the task in the
 * wrong place. Combined with submit-time validation, no run ever executes
 * outside its assigned workspace. Pure (unit-tested).
 */
export function resolveTaskWorkspace(workspace: string): string {
  if (!existsSync(workspace)) {
    throw new Error(
      `Task workspace does not exist: ${workspace}. Refusing to run elsewhere.`,
    )
  }
  return workspace
}

export interface FactoryExecutorRunOptions {
  /**
   * V1.7 hardening — preemption. A pre-aborted run never spawns the host;
   * an abort in flight kills the host child and fails the run.
   */
  signal?: AbortSignal
  /**
   * Live activity: what the seat is doing while it does it. The seat's
   * reasoning, the text it committed, the commands it ran and the files it
   * wrote all arrive here as they happen.
   */
  onActivity?: (activity: AgentActivity) => void
}

export class FactoryExecutor {
  private readonly router:
    RegistryModelRouter

  private readonly verification:
    VerificationEngine

  private readonly changes:
    ChangeCollector

  private readonly acceptance:
    AcceptanceChecker

  private readonly executionMode:
    'live' | 'deterministic'

  private readonly timeoutMs:
    number

  constructor(
    options: FactoryExecutorOptions = {},
  ) {
    this.router =
      options.router ??
      createModelRouter()

    this.verification =
      options.verification ??
      new VerificationEngine()

    this.changes =
      options.changes ??
      new ChangeCollector()

    this.acceptance =
      options.acceptance ??
      new AcceptanceChecker()

    this.executionMode =
      (
        process.env.FACTORY_EXECUTION_MODE ??
        'live'
      ).trim().toLowerCase() ===
      'deterministic'
        ? 'deterministic'
        : 'live'

    this.timeoutMs =
      resolveExecutorTimeoutMs(
        options.timeoutMs,
      )
  }

  async execute(
    task: EngineeringTask,
    options: FactoryExecutorRunOptions = {},
  ): Promise<EngineeringResult> {
    if (
      options.signal?.aborted ===
      true
    ) {
      return {
        taskId:
          task.id ||
          randomUUID(),
        status: 'failed',
        summary:
          'Factory execution aborted before start.',
        output: '',
        filesChanged: [],
        tests: [],
        acceptanceChecks: [],
        diagnostics:
          'Run aborted before the executor started.',
      }
    }

    if (
      this.executionMode ===
      'deterministic'
    ) {
      return this.executeDeterministic(
        task,
      )
    }

    const route =
      await this.router.select(
        (() => {
          // Crew seat pin (2026-10-31, provider-agnostic crews): when the
          // coder seat has an env override, it wins as preferredModel —
          // including a `provider/` prefix the router resolves per call.
          const pin = seatModelPin(task.role ?? 'coder')
          return pin
            ? { ...(task.modelRequirements ?? {}), preferredModel: pin }
            : task.modelRequirements
        })(),
      )

    const before =
      await this.changes.snapshot(
        task.workspace,
      )

    return this.runHost(
      task,
      route,
      before,
      options.signal,
      options.onActivity,
    )
  }

  private async executeDeterministic(
    task: EngineeringTask,
  ): Promise<EngineeringResult> {
    const taskId =
      task.id ||
      randomUUID()

    const before =
      await this.changes.snapshot(
        task.workspace,
      )

    try {
      mkdirSync(
        task.workspace,
        {
          recursive: true,
        },
      )

      this.applyDeterministicTask(
        task,
      )

      const verificationPlan =
        task.verification

      let verification = {
        passed: true,
        setup: [] as Array<{
          command: string
          passed: boolean
          output?: string
        }>,
        tests: [] as Array<{
          command: string
          passed: boolean
          output?: string
        }>,
      }

      if (
        verificationPlan !==
        undefined
      ) {
        verification =
          await this.verification.verify(
            task.workspace,
            verificationPlan.setupCommands,
            verificationPlan.testCommands,
          )
      }

      const changes =
        await this.changes.collect(
          task.workspace,
          before,
        )

      const acceptanceChecks =
        await this.acceptance.check(
          task.workspace,
          task.acceptance,
          verification.passed,
        )

      const allAcceptancePassed =
        acceptanceChecks.length ===
          0 ||
        acceptanceChecks.every(
          check => check.passed,
        )

      const allPassed =
        verification.passed &&
        allAcceptancePassed

      return {
        taskId,
        status:
          allPassed
            ? 'completed'
            : 'failed',

        summary:
          allPassed
            ? 'Deterministic Factory execution, verification, and acceptance completed.'
            : 'Deterministic Factory execution completed but verification or acceptance failed.',

        output:
          'Deterministic execution mode.',

        filesChanged: [
          ...changes.added,
          ...changes.modified,
          ...changes.deleted.map(
            file =>
              `DELETED:${file}`,
          ),
        ],

        tests: [
          ...verification.setup,
          ...verification.tests,
        ],

        acceptanceChecks,

        provider:
          'deterministic',

        model:
          'deterministic-v1',

        diagnostics:
          allPassed
            ? undefined
            : 'Deterministic verification or acceptance failed.',
      }
    } catch (
      error: unknown
    ) {
      return {
        taskId,
        status: 'failed',
        summary:
          'Deterministic Factory execution failed.',
        output: '',
        filesChanged: [],
        tests: [],
        acceptanceChecks: [],
        provider:
          'deterministic',
        model:
          'deterministic-v1',
        diagnostics:
          error instanceof Error
            ? error.stack ??
              error.message
            : String(error),
      }
    }
  }

  private applyDeterministicTask(
    task: EngineeringTask,
  ): void {
    const text =
      [
        task.objective,
        ...task.acceptanceCriteria,
      ]
        .filter(Boolean)
        .join('\n')

    const exactCreate =
      text.match(
        /create\s+([A-Za-z0-9_.\\/-]+)\s+containing\s+exactly\s*[:\-]?\s*["'`]?([A-Za-z0-9_ -]+?)["'`]?(?:\.\s|\.?$)/i,
      )

    if (!exactCreate) {
      return
    }

    const relativePath =
      exactCreate[1].trim()

    const content =
      exactCreate[2].trim()

    const workspaceRoot =
      resolve(task.workspace)

    const filePath =
      resolve(
        workspaceRoot,
        relativePath,
      )

    // Platform-neutral containment check. The old prefix test hardcoded a
    // Windows separator, so every write was refused on Linux/macOS.
    const withinWorkspace =
      relative(
        workspaceRoot,
        filePath,
      )

    if (
      withinWorkspace === '' ||
      withinWorkspace.startsWith('..') ||
      isAbsolute(withinWorkspace)
    ) {
      throw new Error(
        `Deterministic executor refused path outside workspace: ${relativePath}`,
      )
    }

    const parent =
      join(
        filePath,
        '..',
      )

    mkdirSync(
      parent,
      {
        recursive: true,
      },
    )

    writeFileSync(
      filePath,
      content + '\n',
      'utf8',
    )
  }

  private runHost(
    task: EngineeringTask,
    route: ModelRoute,
    before: Awaited<
      ReturnType<
        ChangeCollector['snapshot']
      >
    >,
    signal?: AbortSignal,
    onActivity?: (activity: AgentActivity) => void,
  ): Promise<EngineeringResult> {
    return new Promise(
      resolveResult => {
        const taskId =
          task.id ||
          randomUUID()

        const prompt = [
          buildIdentitySection(),
          '',
          `Engineering task: ${task.objective}`,
          task.role
            ? `Role: ${task.role}`
            : undefined,
          task.stack
            ? `Stack: ${task.stack}`
            : undefined,
          task.constraints.length > 0
            ? `Constraints:\n${task.constraints
                .map(
                  x => `- ${x}`,
                )
                .join('\n')}`
            : undefined,
          task.acceptanceCriteria.length > 0
            ? `Acceptance criteria:\n${task.acceptanceCriteria
                .map(
                  x => `- ${x}`,
                )
                .join('\n')}`
            : undefined,
          '',
          'Work directly in the assigned workspace.',
          'Complete the task and verify the acceptance criteria.',
          'At the end, summarize what you changed and what verification you performed.',
        ]
          .filter(
            (
              x,
            ): x is string =>
              x !== undefined,
          )
          .join('\n')

        const child =
          spawn(
            process.execPath,
            [
              TSX_CLI,
              HOST,
            ],
            {
              // Fail fast: submit-time validation should have caught this;
              // the executor never silently runs in the install root.
              cwd: resolveTaskWorkspace(task.workspace),
              env: {
                ...process.env,
                DSH_FACTORY_TASK_PROMPT:
                  prompt,
                DSH_FACTORY_TASK_WORKSPACE:
                  task.workspace,
                DSH_LLM_PROVIDER:
                  route.provider,
                DSH_LLM_MODEL:
                  route.model,
              },
              stdio: [
                'ignore',
                'pipe',
                'pipe',
              ],
              windowsHide:
                true,
            },
          )

        // V1.7 hardening — wall-clock cap: a hung host child fails the run
        // instead of hanging the Factory forever. The timer is cleared on
        // every exit path; on fire the child is killed and the close handler
        // below reports an executor timeout.
        let timedOut = false
        const hostTimeoutMs = this.timeoutMs
        const hostTimer = setTimeout(
          () => {
            timedOut = true
            child.kill()
          },
          hostTimeoutMs,
        )
        if (typeof hostTimer.unref === 'function') {
          hostTimer.unref()
        }

        // V1.7 hardening — preemption: aborting kills the host child and
        // fails the run instead of letting it continue in the background.
        // Abort is operator intent, so it takes precedence over the timeout
        // message when both fire.
        let abortFired = false
        const onAbort = (): void => {
          abortFired = true
          child.kill()
        }
        if (signal?.aborted === true) {
          onAbort()
        } else {
          signal?.addEventListener('abort', onAbort, { once: true })
        }

        // The answer, with the host's live activity lines removed. stdout
        // carries both: the activity lines are marked, and the marked lines
        // are the ONLY lines that are not the answer.
        const output = hostOutput()
        let stderr = ''

        const reportActivity = (activity: AgentActivity): void => {
          try {
            onActivity?.(activity)
          } catch {
            // A listener that throws must not end the run.
          }
        }

        // The workspace watcher: what the seat touches, while it touches it.
        const watcher = new WorkspaceWatcher(task.workspace, change => {
          reportActivity({
            kind: 'file',
            detail: change.path,
            status: change.change,
          })
        })
        watcher.start()

        child.stdout.on(
          'data',
          chunk => {
            for (const activity of consumeHostOutput(output, String(chunk))) {
              reportActivity(activity)
            }
          },
        )

        child.stderr.on(
          'data',
          chunk => {
            stderr += String(
              chunk,
            )
          },
        )

        child.on(
          'error',
          error => {
            clearTimeout(hostTimer)
            signal?.removeEventListener('abort', onAbort)
            watcher.stop()
            resolveResult({
              taskId,
              status:
                'failed',
              summary:
                'Factory executor failed to start.',
              output:
                output.answer,
              filesChanged: [],
              tests: [],
              acceptanceChecks: [],
              provider:
                route.provider,
              model:
                route.model,
              diagnostics:
                error.message,
            })
          },
        )

        child.on(
          'close',
          code => {
            clearTimeout(hostTimer)
            signal?.removeEventListener('abort', onAbort)
            watcher.stop()
            // The last line may have arrived without its newline.
            for (const activity of flushHostOutput(output)) {
              reportActivity(activity)
            }
            if (abortFired) {
              resolveResult({
                taskId,
                status:
                  'failed',
                summary:
                  'Factory execution aborted.',
                output:
                  output.answer,
                filesChanged:
                  [],
                tests:
                  [],
                acceptanceChecks:
                  [],
                provider:
                  route.provider,
                model:
                  route.model,
                diagnostics:
                  `Factory host was killed after an abort signal. stderr: ${stderr || 'no output'}`,
              })

              return
            }
            if (timedOut) {
              resolveResult({
                taskId,
                status:
                  'failed',
                summary:
                  'Factory executor timeout.',
                output:
                  output.answer,
                filesChanged:
                  [],
                tests:
                  [],
                acceptanceChecks:
                  [],
                provider:
                  route.provider,
                model:
                  route.model,
                diagnostics:
                  `Factory host exceeded the ${hostTimeoutMs} ms executor timeout and was killed. stderr: ${stderr || 'no output'}`,
              })

              return
            }
            const finish =
              async (): Promise<void> => {
                const verificationPlan =
                  task.verification

                if (
                  code !==
                  0
                ) {
                  resolveResult({
                    taskId,
                    status:
                      'failed',
                    summary:
                      'Factory execution failed.',
                    output:
                      output.answer,
                    filesChanged:
                      [],
                    tests:
                      [],
                    acceptanceChecks:
                      [],
                    provider:
                      route.provider,
                    model:
                      route.model,
                    diagnostics:
                      stderr ||
                      `Factory host exited with code ${code}.`,
                  })

                  return
                }

                if (
                  verificationPlan ===
                  undefined
                ) {
                  resolveResult({
                    taskId,
                    status:
                      'completed',
                    summary:
                      'Factory execution completed without a verification plan.',
                    output:
                      output.answer,
                    filesChanged:
                      [],
                    tests:
                      [],
                    acceptanceChecks:
                      [],
                    provider:
                      route.provider,
                    model:
                      route.model,
                    diagnostics:
                      stderr ||
                      undefined,
                  })

                  return
                }

                const verification =
                  await this.verification.verify(
                    task.workspace,
                    verificationPlan.setupCommands,
                    verificationPlan.testCommands,
                  )

                const changes =
                  await this.changes.collect(
                    task.workspace,
                    before,
                  )

                const acceptanceChecks =
                  await this.acceptance.check(
                    task.workspace,
                    task.acceptance,
                    verification.passed,
                  )

                const allAcceptancePassed =
                  acceptanceChecks.length ===
                    0 ||
                  acceptanceChecks.every(
                    check =>
                      check.passed,
                  )

                const allPassed =
                  verification.passed &&
                  allAcceptancePassed

                resolveResult({
                  taskId,
                  status:
                    allPassed
                      ? 'completed'
                      : 'failed',
                  summary:
                    allPassed
                      ? 'Factory execution, verification, and acceptance completed.'
                      : 'Factory execution completed but verification or acceptance failed.',
                  output:
                    output.answer,
                  filesChanged: [
                    ...changes.added,
                    ...changes.modified,
                    ...changes.deleted.map(
                      file =>
                        `DELETED:${file}`,
                    ),
                  ],
                  tests: [
                    ...verification.setup,
                    ...verification.tests,
                  ],
                  acceptanceChecks,
                  provider:
                    route.provider,
                  model:
                    route.model,
                  diagnostics:
                    stderr ||
                    undefined,
                })
              }

            void finish().catch(
              (
                error: unknown,
              ) => {
                resolveResult({
                  taskId,
                  status:
                    'failed',
                  summary:
                    'Factory verification failed unexpectedly.',
                  output:
                    output.answer,
                  filesChanged:
                    [],
                  tests:
                    [],
                  acceptanceChecks:
                    [],
                  provider:
                    route.provider,
                  model:
                    route.model,
                  diagnostics:
                    error instanceof
                    Error
                      ? error.stack ??
                        error.message
                      : String(
                          error,
                        ),
                })
              },
            )
          },
        )
      },
    )
  }
}
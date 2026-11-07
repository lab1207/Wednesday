import { toStringList } from './text-list'
import { redactSensitiveText } from '../security/redaction'

import type {
  AgentContext,
  AgentOutput,
  AgentRole,
} from '../agents/types'

import {
  RegistryModelRouter,
  seatModelPin,
} from '../model-router'

import {
  describeJsonFailure,
  parseJsonLoose,
} from '../model-router/json-repair'

import type {
  ReviewResult,
} from './types'

import {
  FactoryExecutor,
} from '../executor'

import {
  VerificationEngine,
} from '../verification'

import {
  isDepAuditEnabled,
  isSecurityScanEnabled,
  runSecurityScan,
} from '../verification/security-scan'

import type {
  SecurityScanResult,
} from '../verification/security-scan'

import type {
  CodingAgentProvider,
} from '../agent-providers'

import {
  openCodeProvider,
} from '../agent-providers'

import {
  buildCrewGuidance,
  getCachedCatalog,
  getCachedSmallCrew,
  getCachedSmallCrewSync,
  rankCatalog,
  selectCrewForTask,
} from './ecc-crew'

import {
  buildIdentitySection,
} from './identity'

import type {
  EccAgent,
} from './ecc-crew'

import {
  buildRulesGuidance,
  getCachedRulesForTask,
  getCachedRulesForTaskSync,
} from './ecc-rules'

import type {
  EngineeringTask,
} from '../contracts/index'

export function buildKnowledgeAwarePrompt(
  role: AgentRole,
  context: AgentContext,
): string {
  const knowledgeSection =
    context.knowledge?.rendered
      ? [
          '',
          'FACTORY KNOWLEDGE:',
          context.knowledge.rendered,
        ].join('\n')
      : ''

  return [
    buildIdentitySection(),
    '',
    role.buildPrompt(context),
    knowledgeSection,
  ].join('\n')
}

/**
 * R2 escalation ladder (relentless loops): each retry must differ, not
 * just repeat (the zhmb lesson - identical prompts fail identically).
 * failedTries = failed coder tries so far this run. Round 1 keeps the
 * standard wording; round 2-3 orders a strategy change; round 4+
 * orders split-and-land. Pure (unit-tested); wired into the shared
 * repair-feedback builder so BOTH coder paths escalate.
 */
export function repairEscalationGuidance(
  failedTries: number,
): string {
  if (failedTries >= 4) {
    return [
      `SPLIT AND LAND (repair round ${failedTries + 1}):`,
      'stop rewriting the whole task - the last approaches all failed.',
      'Implement the smallest failing piece first so verification turns',
      'green on something, then extend piece by piece.',
      'List what you deliberately deferred.',
    ].join('\n')
  }

  if (failedTries >= 2) {
    return [
      `STRATEGY CHANGE (repair round ${failedTries + 1}):`,
      `the last ${failedTries} approaches failed - do not adjust the`,
      'same code again. Pick a different implementation strategy',
      '(different file layout, different control flow, or a simpler',
      'algorithm) and state the switch in one line.',
    ].join('\n')
  }

  return ''
}

/**
 * C3 depth (orchestration, Core): surface the planner's file-level guidance
 * explicitly in the coder prompt instead of burying it in capped history.
 */
export function buildPlannerGuidance(
  context: AgentContext,
): string {
  const plannerOutputs =
    context.previousOutputs.filter(
      output =>
        output.role ===
        'planner',
    )

  const latest =
    plannerOutputs.at(-1)

  if (
    latest ===
    undefined
  ) {
    return ''
  }

  const lines: string[] = [
    'PLANNER GUIDANCE:',
  ]

  const recommendations =
    latest.recommendations ??
    []

  if (
    recommendations.length >
    0
  ) {
    lines.push(
      'Planned steps:',
      ...recommendations
        .slice(0, 8)
        .map(
          item =>
            `- ${limitText(
              item,
              1000,
            )}`,
        ),
    )
  }

  const findings =
    latest.findings ??
    []

  if (
    findings.length >
    0
  ) {
    lines.push(
      'Planner findings:',
      ...findings
        .slice(0, 8)
        .map(
          item =>
            `- ${limitText(
              item,
              1000,
            )}`,
        ),
    )
  }

  if (
    lines.length ===
    1
  ) {
    return ''
  }

  return limitText(
    lines.join('\n'),
    4000,
  )
}

export interface RoleRunner {
  run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput>
}

function limitText(
  value: unknown,
  max = 4000,
): string {
  const text =
    typeof value === 'string'
      ? value
      : String(value ?? '')

  if (
    text.length <= max
  ) {
    return text
  }

  return [
    text.slice(0, max),
    '',
    `[truncated ${
      text.length - max
    } characters]`,
  ].join('\n')
}

function baseOutput(
  role: AgentRole,
  context: AgentContext,
  summary: string,
  findings: string[],
  recommendations: string[] = [],
  blockingIssues: string[] = [],
): AgentOutput {
  return {
    role: role.id,
    summary,
    instructions:
      role.buildPrompt(context),
    findings,
    recommendations,
    blockingIssues,
  }
}

export class AnalysisRunner
  implements RoleRunner {
  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    const prompt =
      buildKnowledgeAwarePrompt(
        role,
        context,
      )

    return baseOutput(
      role,
      context,
      `${role.id} analysis prepared.`,
      [
        'Analysis-only stage.',
        `Prompt length: ${prompt.length} characters.`,
        'No workspace modifications were requested.',
      ],
      [
        'Pass the analysis to the next orchestration stage.',
      ],
    )
  }
}

export interface CodingRunnerOptions {
  agentProvider?: CodingAgentProvider
}

export class CodingRunner
  implements RoleRunner {
  private readonly agentProvider?:
    CodingAgentProvider

  constructor(
    private readonly executor:
      FactoryExecutor,
    options:
      CodingRunnerOptions = {},
  ) {
    this.agentProvider =
      options.agentProvider
  }

  private resolveAgentProvider():
    CodingAgentProvider | undefined {
    const configured =
      (
        process.env
          .FACTORY_CODER_PROVIDER ??
        ''
      )
        .trim()
        .toLowerCase()

    if (
      configured ===
      'opencode'
    ) {
      return (
        this.agentProvider ??
        openCodeProvider
      )
    }

    return this.agentProvider
  }

  private buildRepairFeedback(
    context: AgentContext,
  ): string {
    const testerOutputs =
      context.previousOutputs.filter(
        output =>
          output.role ===
          'tester',
      )

    const latestTester =
      testerOutputs.at(-1)

    const coderOutputs =
      context.previousOutputs.filter(
        output =>
          output.role ===
          'coder',
      )

    const latestCoder =
      coderOutputs.at(-1)

    const lines: string[] = [
      'PREVIOUS VERIFICATION RESULT:',
    ]

    const blockingIssues =
      latestTester?.blockingIssues ??
      []

    const findings =
      latestTester?.findings ??
      []

    if (
      blockingIssues.length > 0
    ) {
      lines.push(
        'BLOCKING ISSUES:',
        ...blockingIssues
          .slice(0, 10)
          .map(
            item =>
              `- ${limitText(
                item,
                1000,
              )}`,
          ),
      )
    }

    if (
      findings.length > 0
    ) {
      lines.push(
        '',
        'VERIFICATION FINDINGS:',
        ...findings
          .slice(0, 10)
          .map(
            item =>
              `- ${limitText(
                item,
                1000,
              )}`,
          ),
      )
    }

    // Repair wiring (2026-09-19): coder-stage failures (live: DSH host
    // verification/acceptance or contract-gate misses) previously died as
    // terminal blocks with no tester output. Feed the last coder's blocking
    // issues into the next attempt so repairAttempts count real repairs.
    const coderBlocking =
      latestCoder?.blockingIssues ??
      []

    if (
      coderBlocking.length > 0 &&
      latestTester === undefined
    ) {
      lines.push(
        '',
        'PREVIOUS CODER FAILURE:',
        ...coderBlocking
          .slice(0, 10)
          .map(
            item =>
              `- ${limitText(
                item,
                1000,
              )}`,
          ),
      )
    }

    // R2 escalation: count failed coder tries so far; the guidance
    // text varies the strategy by round on BOTH coder paths.
    const failedTries =
      coderOutputs.filter(
        output =>
          output.blockingIssues.length >
          0,
      ).length

    const escalation =
      repairEscalationGuidance(
        failedTries,
      )

    if (escalation.length > 0) {
      lines.push(
        '',
        escalation,
      )
    }

    if (
      lines.length === 1
    ) {
      return ''
    }

    return limitText(
      lines.join('\n'),
      7000,
    )
  }

  private buildExternalCodingPrompt(
    context: AgentContext,
  ): string {
    const task =
      context.task

    const requiredFiles =
      task.acceptance
        ?.requiredFiles ??
      []

    const tests =
      task.verification
        ?.testCommands ??
      []

    const repairFeedback =
      this.buildRepairFeedback(
        context,
      )

    const isRepair =
      repairFeedback.length > 0

    const plannerGuidance =
      buildPlannerGuidance(
        context,
      )

    const sections = [
      buildIdentitySection(),
      '',
      'You are the CODER for an AI software factory.',
      '',
      isRepair
        ? 'THIS IS A REPAIR ATTEMPT.'
        : 'THIS IS THE INITIAL IMPLEMENTATION ATTEMPT.',
      '',
      'Execute the task immediately.',
      '',
      `TASK ID: ${task.id}`,
      `WORKSPACE: ${context.workspace}`,
      '',
      'EXACT OBJECTIVE:',
      task.objective,
      '',
      'REQUIRED FILES:',
      requiredFiles.length > 0
        ? requiredFiles
            .map(
              file =>
                `- ${file}`,
            )
            .join('\n')
        : '- None specified.',
      '',
      'ACCEPTANCE CRITERIA:',
      task.acceptanceCriteria.length > 0
        ? task.acceptanceCriteria
            .map(
              criterion =>
                `- ${criterion}`,
            )
            .join('\n')
        : '- Complete the exact objective.',
      '',
      'VERIFICATION COMMANDS:',
      tests.length > 0
        ? tests
            .map(
              command =>
                `- ${command}`,
            )
            .join('\n')
        : '- None specified.',
    ]

    if (
      plannerGuidance.length >
      0
    ) {
      sections.push(
        '',
        plannerGuidance,
      )
    }

    // ECC engineering rules (dormant rules/ surface, woken 2026-09-21):
    // stack guidelines ride the coder prompt, silent when absent.
    // Sync builder: sync cached read (first call loads small files once).
    try {
      const rulesGuidance =
        buildRulesGuidance(
          getCachedRulesForTaskSync({
            stack:
              task.stack,
            objective:
              task.objective,
          }),
        )

      if (
        rulesGuidance.length >
        0
      ) {
        sections.push(
          '',
          rulesGuidance,
        )
      }
    } catch {
      // Rules must never break coding.
    }

    if (
      isRepair
    ) {
      sections.push(
        '',
        repairFeedback,
        '',
        'REPAIR INSTRUCTIONS:',
        'Fix the verification failure above.',
        'Inspect the existing workspace before changing anything.',
        'Do not repeat the failed approach.',
        'Make the smallest change required to satisfy the objective.',
      )

      // ECC specialists on repair rounds only (woken 2026-09-21): fresh
      // expert eyes exactly when prior attempts failed. Silent when absent.
      try {
        const repairCrewGuidance =
          buildCrewGuidance(
            selectCrewForTask(
              getCachedSmallCrewSync(),
              {
                stack:
                  task.stack,
                objective:
                  task.objective,
              },
            ),
          )

        if (
          repairCrewGuidance.length >
          0
        ) {
          sections.push(
            '',
            repairCrewGuidance,
          )
        }
      } catch {
        // Specialists must never break coding.
      }
    }

    sections.push(
      '',
      'STRICT EXECUTION RULES:',
      '- Work directly in the specified workspace.',
      '- Use the exact required filenames.',
      '- Create the exact requested content.',
      '- Do not substitute another filename.',
      '- Do not create demonstration or example files.',
      '- Do not modify unrelated files.',
      '- Do not ask the user for another task.',
      '- Inspect the final result.',
      '- Verify the acceptance criteria before finishing.',
      '',
      'FINAL REQUIREMENT:',
      'Perform the task now.',
    )

    return limitText(
      sections.join('\n'),
      12000,
    )
  }

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    const prompt =
      buildKnowledgeAwarePrompt(
        role,
        context,
      )

    const agentProvider =
      this.resolveAgentProvider()

    if (
      agentProvider !==
      undefined
    ) {
      const externalPrompt =
        this.buildExternalCodingPrompt(
          context,
        )

      const repairAttempt =
        context.previousOutputs.some(
          output =>
            (
              output.role ===
              'tester' ||
              output.role ===
              'coder'
            ) &&
            (
              output.blockingIssues
                ?.length ??
              0
            ) > 0,
        )

      console.log(
        '[factory-coder] dispatching external agent',
      )

      console.log(
        redactSensitiveText(
          JSON.stringify(
            {
              provider:
                agentProvider.id,
              taskId:
                context.task.id,
              workspace:
                context.workspace,
              repairAttempt,
              objective:
                context.task.objective,
              promptLength:
                externalPrompt.length,
              acceptanceCriteria:
                context.task
                  .acceptanceCriteria,
              requiredFiles:
                context.task
                  .acceptance
                  ?.requiredFiles ??
                [],
              verification:
                context.task
                  .verification
                  ?.testCommands ??
                [],
            },
            null,
            2,
          ),
        ),
      )

      const result =
        await agentProvider.run({
          taskId:
            context.task.id,
          workspace:
            context.workspace,
          prompt:
            externalPrompt,
          timeoutMs:
            // Local (CPU) runs generate far slower than cloud providers;
            // the default is for OpenRouter-scale speeds. Raise via
            // FACTORY_CODER_TIMEOUT_MS for local model runs.
            Number(
              process.env.FACTORY_CODER_TIMEOUT_MS?.trim() ||
              300000,
            ),
          autoApprove:
            (
              process.env
                .FACTORY_CODER_AUTO_APPROVE ??
              ''
            )
              .trim()
              .toLowerCase() ===
            'true',
        })

      const engineeringResult = {
        taskId:
          context.task.id,

        status:
          result.status ===
          'completed'
            ? 'completed'
            : 'failed',

        summary:
          result.status ===
          'completed'
            ? `${result.provider} coding agent completed.`
            : `${result.provider} coding agent failed.`,

        output:
          result.output ??
          '',

        filesChanged:
          result.filesChanged ??
          [],

        tests: [],

        acceptanceChecks: [],

        provider:
          result.provider,

        model:
          result.model,

        diagnostics:
          result.diagnostics,
      }

      context.reportToolCall?.(
        `${result.provider}.coding-agent`,
        {
          status:
            result.status,
          // Which files the seat actually wrote. The run's tool row and the
          // live agent dock read this, so "coding-agent · PASS" no longer
          // leaves the operator guessing what changed until /result.
          files:
            result.filesChanged,
        },
      )

      return {
        role:
          role.id,

        summary:
          result.status ===
          'completed'
            ? `${result.provider} coding agent completed.`
            : `${result.provider} coding agent failed.`,

        instructions:
          externalPrompt,

        findings: [
          `Coding agent: ${result.provider}`,
          limitText(
            result.output,
            6000,
          ),
        ].filter(Boolean),

        recommendations: [
          result.status ===
          'completed'
            ? 'Run Factory verification against the workspace.'
            : 'Repair or retry the coding-agent execution.',
        ],

        blockingIssues:
          result.status ===
          'failed'
            ? [
                limitText(
                  result.diagnostics ??
                    `${result.provider} failed.`,
                  3000,
                ),
              ]
            : [],

        filesChanged:
          result.filesChanged ??
          [],

        engineeringResult,
      }
    }

    // Repair wiring for the live DSH path (2026-09-19): the executor builds
    // its host prompt from task.objective, so the previous failure detail
    // must ride along here — otherwise every retry re-runs the identical
    // initial prompt (zhmb: 4 identical attempts, notes.js never written).
    const coderRepairFeedback =
      this.buildRepairFeedback(
        context,
      )

    const coderPlannerGuidance =
      buildPlannerGuidance(
        context,
      )

    // ECC engineering rules on the live DSH path too (silent when absent).
    let coderRulesGuidance = ''
    try {
      coderRulesGuidance =
        buildRulesGuidance(
          await getCachedRulesForTask({
            stack:
              context.task.stack,
            objective:
              context.task.objective,
          }),
        )
    } catch {
      coderRulesGuidance = ''
    }

    // ECC specialists on repair rounds of the live path too (silent absent).
    let coderCrewGuidance = ''
    try {
      if (coderRepairFeedback.length > 0) {
        coderCrewGuidance =
          buildCrewGuidance(
            selectCrewForTask(
              await getCachedSmallCrew(),
              {
                stack:
                  context.task.stack,
                objective:
                  context.task.objective,
              },
            ),
          )
      }
    } catch {
      coderCrewGuidance = ''
    }

    const extras = [
      buildIdentitySection(),
      coderPlannerGuidance,
      coderRepairFeedback,
      coderRulesGuidance,
      coderCrewGuidance,
    ].filter(
      section =>
        section.length >
        0,
    )

    const task = {
      ...context.task,
      objective:
        extras.length > 0
          ? `${prompt}\n\n${extras.join('\n\n')}`
          : prompt,
    }

    const result =
      await this.executor.execute(
        task,
        {
          // Live activity from the coder: the text it commits, the commands it
          // runs, the files it writes — while it does them, not after the
          // turn (operator, 2026-11-04).
          onActivity: activity => {
            context.reportActivity?.(activity)
          },
        },
      )

    return {
      role:
        role.id,

      summary:
        result.summary,

      instructions:
        task.objective,

      findings: [
        limitText(
          result.output,
          6000,
        ),
        ...result.filesChanged.map(
          file =>
            `Changed: ${file}`,
        ),
      ].filter(Boolean),

      recommendations: [
        result.tests.length ===
          0 ||
        result.tests.every(
          test =>
            test.passed,
        )
          ? 'Verification evidence is passing.'
          : 'Review failed verification evidence before proceeding.',
      ],

      blockingIssues:
        result.status ===
        'failed'
          ? [
              limitText(
                result.diagnostics ??
                  result.summary,
                3000,
              ),
            ]
          : [],

      filesChanged:
        result.filesChanged,

      engineeringResult:
        result,
    }
  }
}

export class TestingRunner
  implements RoleRunner {
  constructor(
    private readonly verification:
      VerificationEngine =
        new VerificationEngine(),
  ) {}

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    const plan =
      context.task.verification

    if (
      plan ===
      undefined
    ) {
      return baseOutput(
        role,
        context,
        'Tester could not run because no verification plan exists.',
        [
          'No verification plan was supplied by the task.',
        ],
        [],
        [
          'Missing verification plan.',
        ],
      )
    }

    const result =
      await this.verification.verify(
        context.workspace,
        plan.setupCommands,
        plan.testCommands,
      )

    for (const setup of result.setup) {
      context.reportToolCall?.(
        'verification.setup',
        {
          command: setup.command,
          passed: setup.passed,
        },
      )
    }

    for (const test of result.tests) {
      context.reportToolCall?.(
        'verification.test',
        {
          command: test.command,
          passed: test.passed,
        },
      )
    }

    const tests =
      result.tests.map(
        test =>
          `${
            test.passed
              ? 'PASS'
              : 'FAIL'
          }: ${test.command}`,
      )

    // In-loop security scan (2026-09-23): green builds still prove
    // they leak no secrets and call nothing dangerous — findings block
    // exactly like failing tests, so the repair loop fixes them the
    // same way. Skipped/failed scans never block (fail-open); disable
    // all with FACTORY_SECURITY_SCAN=0, dep audit is opt-in separately.
    if (result.passed && isSecurityScanEnabled()) {
      let scan: SecurityScanResult | null = null
      try {
        scan = await runSecurityScan(context.workspace, {
          depAudit: isDepAuditEnabled(),
        })
      } catch {
        scan = null
      }
      const findings = scan?.findings ?? []
      if (findings.length > 0) {
        context.reportToolCall?.(
          'verification.security',
          {
            findings: findings.length,
          },
        )
        const blocking = findings.map(
          finding =>
            `SECURITY ${finding.file}:${finding.line} [${finding.rule}]: ${finding.detail}`,
        )
        return baseOutput(
          role,
          context,
          'Tester security scan failed.',
          tests,
          [
            'Send security findings to the coder for repair.',
          ],
          blocking,
        )
      }
    }

    return baseOutput(
      role,
      context,
      result.passed
        ? 'Tester verification passed.'
        : 'Tester verification failed.',
      tests,
      result.passed
        ? [
            'Pass evidence to the reviewer.',
          ]
        : [
            'Send failed verification evidence to the coder for repair.',
          ],
      result.passed
        ? []
        : result.tests
            .filter(
              test =>
                !test.passed,
            )
            .map(
              test =>
                limitText(
                  `${test.command}: ${test.output}`,
                  2500,
                ),
            ),
    )
  }
}

/**
 * The reviewer's verdict and, when there is none, WHY there is none.
 *
 * A muted reviewer is worse than a wrong one: the seat had an answer and
 * the run dropped it on the floor, so the operator saw a silent seat
 * instead of a broken parse. The outcome carries the reason so the caller
 * can put it in the receipt.
 */
export interface ReviewerParseOutcome {
  /** The parsed verdict, when the answer carried one. */
  review?: ReviewResult
  /** Why the answer carried no verdict (absent when it did). */
  failure?: string
}

/**
 * Shape a parsed verdict into the review result every caller expects.
 *
 * Strings, always: the callers below and in the orchestrator call string
 * methods on every entry (B149).
 */
function toReviewResult(
  parsed: Partial<ReviewResult>,
  verdict: ReviewResult['verdict'],
): ReviewResult {
  return {
    verdict:
      verdict,

    summary:
      typeof parsed.summary ===
      'string'
        ? parsed.summary
        : '',

    findings:
      toStringList(
        parsed.findings,
      ),

    requiredChanges:
      toStringList(
        parsed.requiredChanges,
      ),

    evidence:
      toStringList(
        parsed.evidence,
      ),
  }
}

/**
 * Parse the reviewer's answer (2026-11-06).
 *
 * The strict path is UNCHANGED: a well-formed answer parses exactly as it
 * always did, byte for byte. When the strict path finds nothing, the
 * SHARED salvage path (`parseJsonLoose`) gets a turn - a small model that
 * wrapped its verdict in a markdown fence, in single quotes, or in prose
 * used to have its verdict dropped on the floor. When even that finds
 * nothing, the REASON is recorded (`describeJsonFailure`) instead of being
 * swallowed, so the reviewer seat is never mute without an explanation.
 */
export function parseReviewerOutcome(
  text: string,
): ReviewerParseOutcome {
  const raw =
    text.trim()

  if (
    raw.length === 0
  ) {
    return {
      failure:
        describeJsonFailure(
          text,
        ),
    }
  }

  const candidates: string[] = [
    raw,
  ]

  const stripped =
    raw
      .replace(
        /^```json\s*/i,
        '',
      )
      .replace(
        /^```\s*/i,
        '',
      )
      .replace(
        /\s*```$/i,
        '',
      )
      .trim()

  if (
    stripped !== raw
  ) {
    candidates.push(
      stripped,
    )
  }

  const firstBrace =
    raw.indexOf('{')

  const lastBrace =
    raw.lastIndexOf('}')

  if (
    firstBrace >= 0 &&
    lastBrace >
      firstBrace
  ) {
    candidates.push(
      raw.slice(
        firstBrace,
        lastBrace + 1,
      ),
    )
  }

  const firstLine =
    raw
      .split(/\r?\n/)
      .map(
        line =>
          line.trim(),
      )
      .find(
        line =>
          line.length > 0,
      ) ??
    ''

  if (
    /^PASS\b/i.test(
      firstLine,
    )
  ) {
    return {
      review: {
        verdict:
          'pass',
        summary:
          raw,
        findings: [],
        requiredChanges: [],
        evidence: [
          limitText(
            raw,
            2000,
          ),
        ],
      },
    }
  }

  if (
    /^FAIL\b/i.test(
      firstLine,
    )
  ) {
    return {
      review: {
        verdict:
          'fail',
        summary:
          raw,
        findings: [
          limitText(
            raw,
            2000,
          ),
        ],
        requiredChanges: [
          'Reviewer returned FAIL without structured required changes.',
        ],
        evidence: [],
      },
    }
  }

  // Did any candidate parse as JSON at all? A parse that carries no
  // verdict is a different failure from a parse that failed, and the
  // operator deserves to be told which one happened.
  let sawJson = false

  for (
    const candidate of candidates
  ) {
    try {
      const parsed =
        JSON.parse(
          candidate,
        ) as Partial<ReviewResult>

      if (
        typeof parsed ===
          'object' &&
        parsed !== null
      ) {
        sawJson = true
      }

      if (
        parsed.verdict !==
          'pass' &&
        parsed.verdict !==
          'fail'
      ) {
        continue
      }

      return {
        review:
          toReviewResult(
            parsed,
            parsed.verdict,
          ),
      }
    } catch {
      // Continue trying candidates.
    }
  }

  // The salvage path: markdown fences, single-quoted strings, prose around
  // the payload, a payload that was cut off mid-flight. Same helper the
  // model router uses, so the reviewer and the router agree on what a
  // recoverable answer looks like.
  const loose =
    parseJsonLoose<Partial<ReviewResult>>(
      raw,
    )

  if (
    loose !== null &&
    typeof loose === 'object'
  ) {
    sawJson = true

    if (
      loose.verdict ===
        'pass' ||
      loose.verdict ===
        'fail'
    ) {
      return {
        review:
          toReviewResult(
            loose,
            loose.verdict,
          ),
      }
    }
  }

  return {
    failure:
      sawJson
        ? 'reviewer JSON parsed but carried no usable verdict (expected "pass" or "fail").'
        : describeJsonFailure(
            text,
          ),
  }
}

/**
 * The reviewer's verdict, or undefined when the answer carried none.
 *
 * The signature and the return shape are the ones the callers depend on:
 * undefined means "no verdict". The REASON now travels beside it
 * (`parseReviewerOutcome`), so the reviewer seat is never mute without an
 * explanation.
 */
function parseReviewerResponse(
  text: string,
): ReviewResult | undefined {
  return parseReviewerOutcome(text).review
}

/**
 * ECC small crew for the reviewer: load once, select per task, render the
 * checklist section. Silent (empty section) when the checkout is absent or
 * nothing matches — review must never break on crew availability.
 */
async function crewGuidanceSection(context: AgentContext): Promise<string[]> {
  try {
    const crew = await getCachedSmallCrew()
    const guidance = buildCrewGuidance(
      selectCrewForTask(crew, {
        objective: context.task.objective,
        stack: context.task.stack,
        role: context.task.role,
      }),
    )
    return guidance ? [guidance] : []
  } catch {
    return []
  }
}

export interface SpecialistGateFailure {
  specialist: string
  findings: string[]
  requiredChanges: string[]
}

export interface SpecialistGateOptions {
  crew?: EccAgent[]
  responder?: (
    specialist: EccAgent,
    prompt: string,
  ) => Promise<string>
  maxAgents?: number
  /**
   * Full-catalog sweep (last resort): ignore the small crew and rank the
   * whole catalog. Runs ONCE per task (the orchestrator tracks it in the
   * repair record) — 68 specialists is the most expensive single step in
   * the Factory by design.
   */
  sweepAll?: boolean
}

/**
 * Pure selection for the gate: band cap over the small crew, or the full
 * catalog ranked when sweeping. Offline-testable without files or models.
 */
export function selectForGate(
  smallCrew: EccAgent[],
  catalog: EccAgent[],
  task: { objective?: string; stack?: string; role?: string },
  maxAgents?: number,
  sweepAll?: boolean,
): EccAgent[] {
  const cap = maxAgents ?? Number.POSITIVE_INFINITY
  if (sweepAll === true) {
    return rankCatalog(catalog, task, Math.min(cap, catalog.length))
  }
  if (smallCrew.length >= cap) {
    return selectCrewForTask(smallCrew, task, cap)
  }
  return rankCatalog(catalog, task, cap)
}

export class ReviewRunner
  implements RoleRunner {
  constructor(
    private readonly router:
      RegistryModelRouter,
  ) {}

  /**
   * Specialist gate (ECC small crew, phase 2): after the main reviewer
   * passes, each selected specialist judges the same evidence with its own
   * checklist. An explicit `fail` verdict blocks completion into the repair
   * loop; malformed output is ignored (the main reviewer stays
   * authoritative). No events emitted — the locked lifecycle sequence is
   * untouched; findings surface through the repair record.
   */
  async runSpecialistGate(
    outputs: AgentOutput[],
    task: EngineeringTask,
    options?: SpecialistGateOptions,
  ): Promise<SpecialistGateFailure[]> {
    let selected: EccAgent[]
    try {
      const taskText = {
        objective: task.objective,
        stack: task.stack,
        role: task.role,
      }
      if (options?.crew !== undefined && options?.sweepAll !== true) {
        selected = selectCrewForTask(
          options.crew,
          taskText,
          options?.maxAgents,
        )
      } else {
        selected = selectForGate(
          await getCachedSmallCrew(),
          await getCachedCatalog(),
          taskText,
          options?.maxAgents,
          options?.sweepAll,
        )
      }
    } catch {
      return []
    }

    const evidence = outputs
      .map(
        output =>
          [
            `ROLE: ${output.role}`,
            `SUMMARY: ${limitText(output.summary, 1000)}`,
            ...(output.findings ?? []).slice(0, 5),
          ].join('\n'),
      )
      .join('\n\n')

    // Parallel dimension reviewers (ECC orch-review pattern): independent
    // specialists routinely flag the same lines, so findings merge across
    // dimensions on normalized text — one bug, one repair entry, first
    // reporter attributed. Promise.all preserves selection order.
    const verdicts = await Promise.all(
      selected.map(async specialist => {
        const checklist = buildCrewGuidance([specialist])
        const prompt = [
          `You are ${specialist.name}: ${specialist.description}`,
          '',
          'Judge the implementation below against YOUR checklist only.',
          'Return EXACTLY one JSON object, no Markdown:',
          '{"verdict": "pass"|"fail", "summary": "...", "findings": [], "requiredChanges": [], "evidence": []}',
          'Verdict "fail" ONLY for a material problem in your specialty; otherwise "pass".',
          '',
          checklist,
          '',
          `ORIGINAL TASK:\n${task.objective}`,
          '',
          `ACCEPTANCE CRITERIA:\n${task.acceptanceCriteria.join('\n')}`,
          '',
          `EVIDENCE:\n${evidence}`,
        ].join('\n')

        let text: string
        try {
          text =
            options?.responder !== undefined
              ? await options.responder(specialist, prompt)
              : (
                  await this.router.complete(
                    // Same catalog rule as the main verdict: checklist
                    // judges type JSON on the coding route, never the
                    // reasoning route.
                    // Crew seat pin (2026-11-06): the specialists judge
                    // FOR the reviewer, so they run on the REVIEWER's own
                    // model when the crew staffs one - and on the coder
                    // slot's model when it does not (legacy, unchanged).
                    {
                      capability: 'coding',
                      ...(seatModelPin('reviewer')
                        ? { preferredModel: seatModelPin('reviewer') }
                        : {}),
                      // The tokens belong to the reviewer seat.
                      seat: 'reviewer',
                    },
                    prompt,
                  )
                ).text
        } catch {
          return null
        }

        const parsed = parseReviewerResponse(text)
        if (parsed?.verdict !== 'fail') return null
        return {
          specialist: specialist.name,
          findings: parsed.findings ?? [],
          requiredChanges: parsed.requiredChanges ?? [],
        }
      }),
    )

    const failures: SpecialistGateFailure[] = []
    const seen = new Set<string>()
    for (const verdict of verdicts) {
      if (!verdict) continue
      const uniqueFindings = verdict.findings.filter(finding => {
        const key = finding.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      const uniqueChanges = verdict.requiredChanges.filter(change => {
        const key = change.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (uniqueFindings.length > 0 || uniqueChanges.length > 0) {
        failures.push({
          specialist: verdict.specialist,
          findings: uniqueFindings,
          requiredChanges: uniqueChanges,
        })
      }
    }

    return failures
  }

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    const evidence =
      context.previousOutputs
        .map(
          output =>
            [
              `ROLE: ${output.role}`,
              `SUMMARY: ${limitText(
                output.summary,
                1500,
              )}`,
              'FINDINGS:',
              ...(output.findings ??
                [])
                .slice(0, 8)
                .map(
                  item =>
                    `- ${limitText(
                      item,
                      1500,
                    )}`,
                ),
              'RECOMMENDATIONS:',
              ...(output.recommendations ??
                [])
                .slice(0, 8)
                .map(
                  item =>
                    `- ${limitText(
                      item,
                      1000,
                    )}`,
                ),
              'BLOCKING ISSUES:',
              ...(output.blockingIssues ??
                [])
                .slice(0, 8)
                .map(
                  item =>
                    `- ${limitText(
                      item,
                      1500,
                    )}`,
                ),
            ].join('\n'),
        )
        .join('\n\n')

    const reviewPrompt = [
      buildIdentitySection(),
      '',
      'You are the FINAL ENGINEERING REVIEWER.',
      '',
      'The coder has implemented the task.',
      'The tester has already verified the implementation.',
      '',
      'Your job is only to decide whether the implementation should be accepted.',
      '',
      'Return EXACTLY one JSON object.',
      'Do not return Markdown.',
      'Do not return a plan.',
      'Do not return headings.',
      'Do not explain your reasoning outside the JSON.',
      '',
      'REQUIRED JSON SHAPE:',
      '{',
      '  "verdict": "pass",',
      '  "summary": "brief summary",',
      '  "findings": [],',
      '  "requiredChanges": [],',
      '  "evidence": []',
      '}',
      '',
      'Use "verdict": "pass" when the task is complete and verification evidence passes.',
      'Use "verdict": "fail" only when a material problem remains.',
      'When verdict is pass, requiredChanges MUST be an empty array.',
      'When verdict is fail, requiredChanges MUST contain concrete fixes.',
      '',
      `ORIGINAL TASK:\n${context.task.objective}`,
      '',
      `ACCEPTANCE CRITERIA:\n${
        context.task.acceptanceCriteria
          .map(
            criterion =>
              `- ${criterion}`,
          )
          .join('\n')
      }`,
      '',
      `EVIDENCE:\n${evidence}`,
      '',
      // ECC small crew (reviewer only in phase 1; coder wiring is the
      // expansion step): specialist checklists sharpen the verdict.
      ...(await crewGuidanceSection(context)),
    ].join('\n')

    const response =
      await this.router.complete(
        {
          ...(context.task
            .modelRequirements ??
            {}),
          // Crew 1 catalog: the coder owns coder + tester + reviewer
          // stages (R1 plans only). Reasoning here would route review
          // verdicts to the planner AND risk <think> leakage into the
          // structured parse — the coder types the verdict.
          capability:
            'coding',
          // The reviewer is a SEAT (2026-11-06): its own model when the
          // crew staffs one, the coder slot's model when it does not
          // (legacy - an unchanged profile behaves exactly as before).
          ...(seatModelPin(role.id)
            ? { preferredModel: seatModelPin(role.id) }
            : {}),
          // The seat name rides along so the provider attributes the
          // tokens to the teammate that spent them.
          seat:
            'reviewer',
        },
        reviewPrompt,
        // The reviewer thinks too: its reasoning is the operator's window into
        // a stage that otherwise sits silent for a minute.
        {
          onReasoning: piece => {
            context.reportActivity?.({
              kind: 'reasoning',
              text: piece,
            })
          },
        },
      )

    const outcome =
      parseReviewerOutcome(
        response.text,
      )

    const review =
      outcome.review

    if (
      review ===
      undefined
    ) {
      return {
        role:
          role.id,

        summary:
          'Reviewer returned invalid structured output.',

        instructions:
          reviewPrompt,

        findings: [
          limitText(
            response.text,
            4000,
          ),
        ],

        recommendations: [
          'Retry reviewer using the exact JSON contract.',
        ],

        // The REASON the verdict was lost rides into the receipt
        // (2026-11-06): a muted reviewer says WHY it was mute, so the
        // operator reads a broken parse instead of a silent seat.
        blockingIssues: [
          `Reviewer output was not valid JSON or PASS/FAIL: ${outcome.failure ?? 'unknown parse failure'}`,
        ],

        review:
          undefined,
      }
    }

    return {
      role:
        role.id,

      summary:
        review.summary,

      instructions:
        reviewPrompt,

      findings:
        review.findings,

      recommendations:
        review.requiredChanges,

      blockingIssues:
        review.verdict ===
        'fail'
          ? review.requiredChanges
          : [],

      review,
    }
  }
}

export class ReadOnlyModelRunner
  implements RoleRunner {
  constructor(
    private readonly router:
      RegistryModelRouter,
  ) {}

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    const prompt =
      buildKnowledgeAwarePrompt(
        role,
        context,
      )

    const result =
      await this.router.complete(
        {
          ...(context.task
            .modelRequirements ??
            {}),
          capability:
            'reasoning',
          // The seat's own model (2026-11-06): a seat that runs a model
          // here uses its own crew model when the crew staffs one (the
          // tester seat on `FACTORY_CREW_TESTER_MODEL`), and the coder
          // slot's model when it does not (legacy - an unchanged profile
          // behaves exactly as before).
          ...(seatModelPin(role.id)
            ? { preferredModel: seatModelPin(role.id) }
            : {}),
          // The seat name rides along so the provider attributes the
          // tokens to the teammate that spent them.
          seat:
            role.id,
        },
        [
          buildIdentitySection(),
          '',
          prompt,
          '',
          'You are operating in analysis-only mode.',
          'Do not modify files.',
          'Do not execute commands.',
          'Return a concise engineering report for the next stage.',
        ].join('\n'),
        // Live reasoning: the seat's thinking reaches the operator while it
        // happens, not as one blob at the end (operator, 2026-11-04).
        {
          onReasoning: piece => {
            context.reportActivity?.({
              kind: 'reasoning',
              text: piece,
            })
          },
        },
      )

    return {
      role:
        role.id,

      summary:
        `${role.id} produced a model-driven analysis.`,

      instructions:
        prompt,

      findings: [
        limitText(
          result.text,
          6000,
        ),
      ],

      recommendations: [
        'Pass this analysis to the next orchestration stage.',
      ],

      blockingIssues: [],
    }
  }
}
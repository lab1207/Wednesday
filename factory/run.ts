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

import type {
  RoleRunner,
} from './agents/role-runners'

import type {
  AgentRoleId,
} from './agents/types'

import {
  createModelRouter,
} from './model-router'

import { AgentRegistry } from './agents'
import { ANALYSIS_ROLES } from './agents/roles'
import { FactoryExecutor } from './executor'
import { VerificationEngine } from './verification'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { redactSensitiveText } from './security/redaction'

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
  ProjectMemoryAdapter,
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

import type { EngineeringTask } from './contracts'
import { DSH_ROOT, DSH_AGENTS_HOME } from './paths'

interface CliOptions {
  objective: string
  workspace: string
  role: string
  stack: string
  constraints: string[]
  acceptanceCriteria: string[]
  requiredFiles: string[]
  setupCommands: string[]
  testCommands: string[]
  expansion: string
  lanes: string
}

function readOption(
  args: string[],
  name: string,
  fallback: string,
): string {
  const index = args.indexOf(name)

  if (index === -1) {
    return fallback
  }

  const value = args[index + 1]

  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }

  return value
}

function readListOption(
  args: string[],
  name: string,
): string[] {
  const value = readOption(args, name, '')

  if (!value) {
    return []
  }

  return value
    .split('|')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseArgs(
  args: string[],
): CliOptions {
  const objective = readOption(
    args,
    '--objective',
    '',
  )

  if (!objective) {
    throw new Error(
      'Missing required option: --objective',
    )
  }

  return {
    objective,
    workspace: readOption(
      args,
      '--workspace',
      process.cwd(),
    ),
    role: readOption(
      args,
      '--role',
      'backend',
    ),
    stack: readOption(
      args,
      '--stack',
      'python',
    ),
    constraints: readListOption(
      args,
      '--constraints',
    ),
    acceptanceCriteria: readListOption(
      args,
      '--acceptance',
    ),
    requiredFiles: readListOption(
      args,
      '--required-files',
    ),
    setupCommands: readListOption(
      args,
      '--setup',
    ),
    testCommands: readListOption(
      args,
      '--tests',
    ),
    // Team or solo from the CLI (2026-10-13): --solo forces one model,
    // --team forces the pool duel (width via --lanes, default 2).
    // Both only set FACTORY_EXPANSION/FACTORY_DUEL_WIDTH for this run;
    // profile env wins when flags are absent.
    expansion: readOption(
      args,
      '--expansion',
      args.includes('--solo')
        ? 'solo'
        : args.includes('--team')
          ? 'duel'
          : '',
    ),
    lanes: readOption(
      args,
      '--lanes',
      '',
    ),
  }
}

async function main(): Promise<void> {
  const options = parseArgs(
    process.argv.slice(2),
  )

  if (options.expansion) process.env.FACTORY_EXPANSION = options.expansion
  if (options.lanes) process.env.FACTORY_DUEL_WIDTH = options.lanes

  const router =
    createModelRouter()

  // ECC / DSH skill environment.
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(
    SkillFileSystem,
    {
      dshHome:
        DSH_ROOT,
      agentsHome:
        DSH_AGENTS_HOME,
    },
  )

  // THE CONTEXT MUST BE DISPOSED (2026-11-07).
  //
  // This is the ONE-SHOT path: the process runs a task, prints a receipt
  // and is supposed to be gone. The DSH skill filesystem watches every
  // skill root it discovers (about twenty-three open watchers), so
  // without this the run finishes, prints its receipt, and the process
  // sits there forever with the event loop held open. A CLI that never
  // exits is a CLI nobody can use in a pipeline.
  try {
    await runWithContext(
      ctx,
      router,
      options,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runWithContext(
  ctx: Context,
  router: ReturnType<typeof createModelRouter>,
  options: ReturnType<typeof parseArgs>,
): Promise<void> {
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
          // WHAT THE FACTORY LEARNED ABOUT THIS WORKSPACE (2026-11-05).
          // Every other adapter is static doctrine - the same card for every
          // workspace, every run - so the factory forgot everything between
          // runs. This one carries the facts the last runs established here.
          new ProjectMemoryAdapter(),
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

  // Agent runners.
  const readOnlyRunner =
    new ReadOnlyModelRunner(router)

  const codingRunner =
    new CodingRunner(
      new FactoryExecutor(),
    )

  const testingRunner =
    new TestingRunner(
      new VerificationEngine(),
    )

  const reviewRunner =
    new ReviewRunner(router)

  // The ANALYSIS-ONLY seats (2026-11-07) run on the READ-ONLY runner -- the
  // one that actually calls a model.
  const seatRunners =
    new Map<
      AgentRoleId,
      RoleRunner
    >(
      ANALYSIS_ROLES.map(
        role =>
          [
            role,
            readOnlyRunner,
          ] as [
            AgentRoleId,
            RoleRunner,
          ],
      ),
    )

  seatRunners.set('coder', codingRunner)
  seatRunners.set('tester', testingRunner)
  seatRunners.set('reviewer', reviewRunner)

  // Agent dispatcher.
  const dispatcher =
    new DefaultRoleRunnerDispatcher(
      seatRunners,
    )

  const task: EngineeringTask = {
    id: `factory-${Date.now()}`,

    workspace:
      options.workspace,

    objective:
      options.objective,

    role:
      options.role,

    stack:
      options.stack,

    constraints:
      options.constraints,

    acceptanceCriteria:
      options.acceptanceCriteria,

    modelRequirements: {
      capability: 'coding',
    },

    acceptance:
      options.requiredFiles.length > 0
        ? {
            requiredFiles:
              options.requiredFiles,
          }
        : undefined,

    verification:
      options.setupCommands.length > 0 ||
      options.testCommands.length > 0
        ? {
            setupCommands:
              options.setupCommands,
            testCommands:
              options.testCommands,
          }
        : undefined,
  }

  console.log(
    JSON.stringify(
      {
        event: 'factory.start',
        task,
      },
      null,
      2,
    ),
  )

  const orchestrator =
    new FactoryOrchestrator(
      new AgentRegistry(),
      dispatcher,
      {
        // Failure recovery (2026-09-23): same reasoning-route diagnoser
        // as the service; rounds env-gated, default off.
        diagnoser:
          prompt =>
            router
              .complete({ capability: 'reasoning' }, prompt)
              .then(response => response.text),
        // Captain fallback (2026-09-27): same lens routes + judge as
        // the service; env-gated (`FACTORY_CAPTAIN=1`, default off).
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

  // Laya guard pre-pass (2026-09-23, optional, fail-open): same gate as
  // the service — blocked tasks stop before the pipeline, laya down or
  // disabled means the run continues untouched.
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
        console.log(
          JSON.stringify(
            {
              event: 'factory.blocked',
              reason: `Laya guard blocked: ${guard.hits.join(', ')}.`,
            },
            null,
            2,
          ),
        )
        process.exitCode = 1
        return
      }
    } catch {
      // Fail open by design: no guard verdict, no block.
    }
  }

  // Unlimited input window (2026-09-22): distill oversized inputs to a
  // working brief before the pipeline (same pre-pass as the service).
  const prepared = await prepareTaskInput(
    task,
    prompt =>
      router
        .complete({ capability: 'coding' }, prompt)
        .then(response => response.text),
  )

  const result =
    await orchestrator.run(prepared.task)

  console.log(
    JSON.stringify(
      {
        event: 'factory.complete',
        result,
      },
      null,
      2,
    ),
  )
}

void main().catch(
  (error: unknown) => {
    console.error(
      JSON.stringify(
        {
          event: 'factory.error',
          error: redactSensitiveText(
            error instanceof Error ? error.message : String(error),
          ),
        },
        null,
        2,
      ),
    )

    process.exitCode = 1
  },
)
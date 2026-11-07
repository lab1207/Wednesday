// D4 live lanes - two parallel tasks against the live 3B model.
//
// LIVE-GATED: needs Colab + ngrok upstream + proxy on 127.0.0.1:18090.
//   1. Start Colab cells, copy the ngrok URL into ~/.wednesday/.env as
//      LOCAL_TOOL_PROXY_UPSTREAM=https://<sub>.ngrok-free.dev/v1
//   2. npx tsx factory/dsh-worker/local-tool-proxy.ts  (background)
//   3. npx tsx factory/service-live-lanes-test.ts
//
// Proves live: 2 parallel lanes complete through the real model with
// ordered results, per-lane event completion, recorded token usage,
// and the shared token budget armed (holds). Evidence dir is kept
// (not deleted) for the session record.

import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import type { EngineeringTask } from './contracts'

// The service is held here so the exit path can dispose it (see the bottom
// of this file).
let activeService: { dispose(): Promise<void> } | undefined

const PROXY_BASE_URL =
  process.env.LOCAL_LLM_BASE_URL ??
  'http://127.0.0.1:18090/v1'

async function probeProxy(): Promise<void> {
  const response = await fetch(
    `${PROXY_BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/json',
        authorization:
          'Bearer live-lanes-probe',
      },
      body: JSON.stringify({
        model:
          process.env.LOCAL_LLM_MODEL ??
          'qwen2.5-coder-3b-instruct',
        messages: [
          {
            role: 'user',
            content:
              'Reply with exactly: PROXY_OK',
          },
        ],
        max_tokens: 16,
      }),
      signal:
        AbortSignal.timeout(30000),
    },
  )

  if (!response.ok) {
    throw new Error(
      `proxy probe failed: HTTP ${response.status} (is the proxy up with a fresh ngrok URL?)`,
    )
  }

  const raw =
    await response.text()

  // The proxy may answer SSE even for non-stream requests; either
  // shape proves the tunnel is alive and the model is answering.
  let text = raw

  try {
    const body = JSON.parse(
      raw,
    ) as {
      choices?: Array<{
        message?: {
          content?: string
        }
      }>
    }

    text =
      body.choices?.[0]?.message
        ?.content ?? raw
  } catch {
    if (!raw.includes('data:')) {
      throw new Error(
        `proxy probe returned non-model bytes: ${raw.slice(0, 120)}`,
      )
    }
  }

  console.log(
    `proxy probe: HTTP 200, reply: ${text.slice(0, 60)}`,
  )
}

async function main(): Promise<void> {
  // Live evidence is KEPT for the session record.
  const evidenceRoot = join(
    tmpdir(),
    'opencode',
    `d4-live-lanes-${Date.now()}`,
  )

  await mkdir(evidenceRoot, {
    recursive: true,
  })

  process.env.FACTORY_EXECUTION_MODE =
    'live'
  process.env.FACTORY_LLM_PROVIDER =
    'local'
  process.env.LOCAL_LLM_BASE_URL =
    PROXY_BASE_URL
  process.env.LOCAL_LLM_MODEL ??=
    'qwen2.5-coder-3b-instruct'
  process.env.LOCAL_LLM_API_KEY ??=
    'live-lanes-key'
  process.env.WEDNESDAY_STATE_HOME =
    join(evidenceRoot, 'state')
  process.env.FACTORY_EVENTS_PATH =
    join(evidenceRoot, 'events.jsonl')

  // Fail fast before burning GPU: stale tunnel dies here, not mid-run.
  await probeProxy()

  const {
    createFactoryService,
    laneBudgetExceeded,
  } = await import('./service')
  const { usageSnapshot, usageDiff } =
    await import(
      './model-router/usage'
    )

  const service =
    await createFactoryService()
  activeService = service

  const makeTask = async (
    id: string,
    subject: string,
  ): Promise<EngineeringTask> => ({
    id,
    workspace: await mkdtemp(
      join(evidenceRoot, `${id}-`),
    ),
    objective: `Write a tiny Python module about ${subject} with a single pure function plus a one-line docstring. Keep it minimal.`,
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: [],
    acceptance: {
      requiredFiles: [],
    },
    verification: {
      setupCommands: [],
      testCommands: [],
    },
  })

  const usageBefore =
    usageSnapshot()

  const tasks = await Promise.all([
    makeTask(
      'live-lane-a',
      'triangle numbers',
    ),
    makeTask(
      'live-lane-b',
      'palindrome checks',
    ),
  ])

  const results =
    await service.runMany(tasks, {
      maxParallel: 2,
      budget: { maxTokens: 100000 },
    })

  assert.equal(results.length, 2)

  for (
    let index = 0;
    index < 2;
    index += 1
  ) {
    assert.equal(
      results[index].taskId,
      tasks[index].id,
    )
    assert.equal(
      results[index].status,
      'completed',
      `live lane ${tasks[index].id}: ${JSON.stringify(results[index]).slice(0, 400)}`,
    )

    const lane = await service.events(
      tasks[index].id,
    )

    assert.equal(
      lane.at(-1)?.type,
      'task.completed',
    )
  }

  const spent = usageDiff(
    usageBefore,
    usageSnapshot(),
  )
  const spentTokens = spent.reduce(
    (sum, record) =>
      sum +
      record.promptTokens +
      record.completionTokens,
    0,
  )

  assert.ok(
    spentTokens > 0,
    'live lanes must record real token usage',
  )
  assert.equal(
    laneBudgetExceeded(spent, {
      maxTokens: 100000,
    }),
    undefined,
    '100k shared budget must hold for two tiny lanes',
  )

  console.log(
    `LIVE LANES TEST: PASS (2/2 completed, ${spentTokens} tokens, evidence: ${evidenceRoot})`,
  )
}

void main()
  .catch(
    (error: unknown) => {
      console.error(error)
      process.exitCode = 1
    },
  )
  .finally(async () => {
    // THE SERVICE MUST BE DISPOSED (2026-11-07).
    //
    // The service's skill filesystem watches every skill root it discovers
    // (about twenty-three open handles). A forced `process.exit()` tears
    // those handles down mid-close, and libuv asserts on it: the process
    // died with 0xC0000409 instead of exiting 0, and whether it happened
    // depended on the machine's mood. Disposing closes the watchers
    // properly, and the process ends on its own.
    try {
      await activeService?.dispose()
    } catch {
      // Best effort: the proof has already been printed.
    }
  })

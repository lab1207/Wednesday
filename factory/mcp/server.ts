/**
 * WEDNESDAY OVER MCP (2026-11-14).
 *
 * Wednesday is not a harness any more. It is a capability a harness connects
 * to, the way it connects to any other MCP server: one `npx` command, a few
 * lines of config, and the operator keeps the terminal, editor or desktop
 * app they already live in.
 *
 * WHAT CROSSES THE WIRE, AND WHAT DOES NOT: the outside model is a
 * MESSENGER. It sends a sentence and reports what comes back. The seats -
 * architect, planner, coder, reviewer, verifier - stay inside. This surface
 * therefore exposes ONE coarse run tool plus the lifecycle calls needed to
 * follow it, and it deliberately exposes no per-seat tools. If `architect`
 * and `implementer` were callable from outside, the frontier model would
 * become the team lead and the small-model team would become day labour,
 * which is the opposite of what Wednesday is for.
 *
 * TRANSPORT: newline-delimited JSON-RPC 2.0 over stdio, the same framing
 * `factory/mcp/client.ts` already speaks in the other direction. Nothing is
 * ever written to stdout except protocol messages; diagnostics go to stderr,
 * because one stray `console.log` corrupts the stream and the client dies.
 */

import { createInterface } from 'node:readline'

import { readFile } from 'node:fs/promises'

import {
  cancelJob,
  getJob,
  jobView,
  listJobs,
  submitRun,
  waitForJob,
} from './jobs'

import {
  activeCrew,
  applyCrew,
} from '../teams/crew-store'

import type { Job, JobView, RunRequest } from './jobs'

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Versions this server is known to speak. Unknown requests downgrade. */
const SUPPORTED_PROTOCOLS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]

const FALLBACK_PROTOCOL = '2025-06-18'

/**
 * The longest a single `wednesday_wait` call may block. Clients cancel a
 * tool call on their own timeout, which is usually well under a minute, and
 * a cancelled call looks like a crash to the operator. Stay under.
 */
const MAX_WAIT_SECONDS = 55
const DEFAULT_WAIT_SECONDS = 45

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

let serverVersion = '0.0.0'

let progressCounter = 0

/**
 * The crew this process adopted at startup.
 *
 * The operator staffs a team once, in the shared state home, and every
 * harness that connects should get THAT team - not a second roster invented
 * by the MCP layer. `applyCrew` writes the same env slots the terminal
 * harness writes, so the engine reads one truth either way.
 */
let adoptedCrewId: string | null = null

function adoptTeam(): void {
  const crew = activeCrew()

  if (!crew) {
    return
  }

  applyCrew(crew)
  adoptedCrewId = crew.id
}

function write(
  message: unknown,
): void {
  process.stdout.write(
    `${JSON.stringify(message)}\n`,
  )
}

function writeResult(
  id: string | number | null,
  result: unknown,
): void {
  write({
    jsonrpc: '2.0',
    id,
    result,
  })
}

function writeError(
  id: string | number | null,
  code: number,
  message: string,
): void {
  write({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

function notify(
  method: string,
  params: Record<string, unknown>,
): void {
  write({
    jsonrpc: '2.0',
    method,
    params,
  })
}

function negotiateProtocol(
  requested: unknown,
): string {
  if (
    typeof requested === 'string' &&
    SUPPORTED_PROTOCOLS.includes(requested)
  ) {
    return requested
  }

  return FALLBACK_PROTOCOL
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/**
 * Descriptions are read by an outside model, so they say what the tool does
 * AND what the caller must not do. The "do not do this yourself" rule lives
 * in the prompt as well, because some clients never show descriptions.
 */
const TOOLS = [
  {
    name: 'wednesday_run',
    title: 'Start a Wednesday engineering run',
    description:
      'Hand a request to Wednesday, the staffed small-model engineering team. ' +
      'Returns immediately with a job id; the team then works in its own sandbox ' +
      '(plan, implement, review, verify). Do NOT attempt the request yourself - ' +
      'start the run and follow it with wednesday_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description:
            "The operator's request in their own words. One sentence is enough.",
        },
        workspace: {
          type: 'string',
          description:
            'Absolute path to the project the work happens in. Defaults to the ' +
            "server's own directory, which most clients set to the project root.",
        },
        role: {
          type: 'string',
          description: 'Seat role hint (backend, frontend, docs...).',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hard rules the team must respect.',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'What counts as done.',
        },
        tests: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Commands that must pass before the run counts as verified.',
        },
        required_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the run must touch or produce.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'wednesday_status',
    title: 'Check a Wednesday run',
    description:
      'Current state of a run plus the last few steps the team took. Cheap and ' +
      'safe to poll.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'wednesday_wait',
    title: 'Wait for a Wednesday run',
    description:
      'Block until the run finishes, or until the wait window closes and returns ' +
      'done: false. Call it again to keep waiting. This is the normal way to ' +
      'follow a run: start, wait, wait, then read the result.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        timeout_seconds: {
          type: 'number',
          description: `How long to block, at most ${MAX_WAIT_SECONDS}s. Defaults to ${DEFAULT_WAIT_SECONDS}s.`,
        },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'wednesday_result',
    title: 'Read a finished Wednesday run',
    description:
      'The verdict: status, summary, files changed, tests, acceptance checks and ' +
      'diagnostics. Report this faithfully to the operator, failures included - ' +
      'do not substitute your own implementation for a failed run.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'wednesday_cancel',
    title: 'Cancel a Wednesday run',
    description:
      'Stop a queued or running job. The team stops between stages, and the ' +
      'result is marked cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'wednesday_jobs',
    title: 'List Wednesday runs',
    description:
      'This session\'s runs, newest first. Useful after a client restart to find ' +
      'a run that is still going.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wednesday_team',
    title: 'Show the staffed team',
    description:
      'Read-only: the crew the operator selected (seats, models, policy) and ' +
      'whether this server adopted it. The team is chosen in Wednesday, not by ' +
      'the calling model.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

const PROMPTS = [
  {
    name: 'run',
    title: 'Wednesday: hand the job to the small-model team',
    description:
      'Send the operator\'s request to Wednesday instead of attempting it in this ' +
      'session. Use it when the operator asks for real engineering work in a ' +
      'repository.',
    arguments: [
      {
        name: 'request',
        description: "The operator's request, verbatim.",
        required: true,
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function textResult(
  payload: unknown,
  isError = false,
): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof payload === 'string'
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  }
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name]

  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}

function stringList(
  args: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = args[name]

  if (!Array.isArray(value)) {
    return undefined
  }

  const items =
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)

  return items.length > 0 ? items : undefined
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name]

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function requireJobId(
  args: Record<string, unknown>,
): string {
  const id = stringArg(args, 'job_id')

  if (!id) {
    throw new Error('job_id is required.')
  }

  return id
}

function jobSummary(
  job: Job,
): Record<string, unknown> {
  return {
    job_id: job.id,
    state: job.state,
    request: job.request,
    workspace: job.workspace,
    elapsed_ms: job.elapsedMs,
    ...(job.error ? { error: job.error } : {}),
  }
}

/**
 * One wire shape for every lifecycle tool. The outside model reads this
 * blindly and rewords it for the operator, so the keys must not change
 * between `wednesday_status`, `wednesday_wait` and `wednesday_result`.
 */
function viewPayload(
  view: JobView,
): Record<string, unknown> {
  return {
    ...jobSummary(view),
    done: view.done,
    progress: view.progress,
    ...(view.hermesTaskId
      ? { hermes_task_id: view.hermesTaskId }
      : {}),
    ...(view.result
      ? { result: view.result }
      : {}),
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'wednesday_run': {
      const request = stringArg(args, 'request')

      if (!request) {
        return textResult(
          'request is required: say what the team should build.',
          true,
        )
      }

      const input: RunRequest = {
        request,
        workspace: stringArg(args, 'workspace'),
        role: stringArg(args, 'role'),
        constraints: stringList(args, 'constraints'),
        acceptanceCriteria: stringList(
          args,
          'acceptance_criteria',
        ),
        tests: stringList(args, 'tests'),
        requiredFiles: stringList(
          args,
          'required_files',
        ),
      }

      try {
        const job = await submitRun(input)

        return textResult({
          ...jobSummary(job),
          next:
            'Wednesday is working. Call wednesday_wait (repeat while done is false), then wednesday_result.',
        })
      } catch (error) {
        return textResult(
          error instanceof Error
            ? error.message
            : String(error),
          true,
        )
      }
    }

    case 'wednesday_status': {
      const view = await jobView(
        requireJobId(args),
      )

      if (!view) {
        return textResult('No such job.', true)
      }

      return textResult(viewPayload(view))
    }

    case 'wednesday_wait': {
      const id = requireJobId(args)

      const requested =
        numberArg(args, 'timeout_seconds') ??
        DEFAULT_WAIT_SECONDS

      const seconds = Math.min(
        Math.max(requested, 1),
        MAX_WAIT_SECONDS,
      )

      const token =
        meta?.progressToken

      const outcome =
        await waitForJob(
          id,
          seconds * 1000,
          (job: Job) => {
            if (token === undefined) {
              return
            }

            progressCounter += 1

            notify('notifications/progress', {
              progressToken: token,
              progress: progressCounter,
              total: 100,
              message: `wednesday: ${job.state} (${Math.round(job.elapsedMs / 1000)}s)`,
            })
          },
        )

      if (!outcome) {
        return textResult('No such job.', true)
      }

      const view = await jobView(id)

      return textResult({
        ...(view
          ? viewPayload(view)
          : jobSummary(outcome.job)),
        done: outcome.done,
        ...(outcome.done
          ? {}
          : {
              next: 'Still running. Call wednesday_wait again.',
            }),
      })
    }

    case 'wednesday_result': {
      const view = await jobView(
        requireJobId(args),
      )

      if (!view) {
        return textResult('No such job.', true)
      }

      if (!view.done) {
        return textResult({
          job_id: view.id,
          state: view.state,
          done: false,
          elapsed_ms: view.elapsedMs,
          progress: view.progress,
          note:
            'Still running. Use wednesday_wait, or wednesday_cancel to stop it.',
        })
      }

      return textResult(viewPayload(view))
    }

    case 'wednesday_cancel': {
      const job = cancelJob(
        requireJobId(args),
      )

      if (!job) {
        return textResult('No such job.', true)
      }

      return textResult({
        ...jobSummary(job),
        note: 'Cancel requested. The team stops between stages.',
      })
    }

    case 'wednesday_jobs': {
      return textResult({
        jobs: listJobs().map(jobSummary),
      })
    }

    case 'wednesday_team': {
      const selected = activeCrew()

      return textResult({
        adopted: adoptedCrewId,
        selected:
          selected
            ? {
                id: selected.id,
                name: selected.name,
                seats: selected.seats,
                policy: selected.policy ?? null,
              }
            : null,
        in_sync:
          (selected?.id ?? null) === adoptedCrewId,
        note: selected
          ? 'Adopted at startup: these seats and this policy drive every run in ' +
            'this connection. If selected and adopted differ, the crew changed ' +
            'after this server started - reconnect to adopt it.'
          : 'No crew selected. Every seat runs on the route default, and the ' +
            'task difficulty picks the shape (auto).',
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

/**
 * The instruction that keeps the outside model a messenger. Written as a
 * directive because a hedged prompt is a prompt the frontier model ignores
 * in favour of just doing the work itself.
 */
function wednesdayPrompt(
  request: string,
): string {
  return [
    "The operator's request below belongs to Wednesday, the staffed small-model " +
      'engineering team. It does not belong to you.',
    '',
    `Request: ${request}`,
    '',
    'Do this:',
    '1. Call wednesday_run with that request (use the project workspace).',
    '2. Call wednesday_wait. While it returns done: false, call it again.',
    '3. Call wednesday_result.',
    "4. Report Wednesday's summary, files changed, tests and verdict to the " +
      'operator faithfully - failures included.',
    '',
    'Do not do the work yourself. Do not read or edit files to help it along. ' +
      "Do not replace a failed run with your own implementation. If Wednesday " +
      'fails, report the failure and its diagnostics; the operator decides what ' +
      'happens next.',
  ].join('\n')
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: negotiateProtocol(
          params.protocolVersion,
        ),
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: 'wednesday',
          version: serverVersion,
        },
        instructions:
          'Wednesday is a staffed small-model engineering team. Send work with ' +
          'wednesday_run, follow it with wednesday_wait, read it with ' +
          'wednesday_result. Do not do the work yourself.',
      }

    case 'ping':
      return {}

    case 'tools/list':
      return { tools: TOOLS }

    case 'tools/call': {
      const name = params.name
      const args = params.arguments

      if (typeof name !== 'string') {
        throw new Error('tools/call requires a tool name.')
      }

      return callTool(
        name,
        args && typeof args === 'object'
          ? (args as Record<string, unknown>)
          : {},
        params._meta && typeof params._meta === 'object'
          ? (params._meta as Record<string, unknown>)
          : undefined,
      )
    }

    case 'prompts/list':
      return { prompts: PROMPTS }

    case 'prompts/get': {
      const name = params.name

      if (name !== 'run') {
        throw new Error(`Unknown prompt: ${String(name)}`)
      }

      const args = params.arguments

      const request =
        args && typeof args === 'object'
          ? stringArg(
              args as Record<string, unknown>,
              'request',
            )
          : undefined

      if (!request) {
        throw new Error(
          "The 'request' argument is required.",
        )
      }

      return {
        description:
          'Hand the operator\'s request to Wednesday.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: wednesdayPrompt(request),
            },
          },
        ],
      }
    }

    // Clients send these and expect either silence or an empty result.
    case 'notifications/initialized':
    case 'logging/setLevel':
      return {}

    default:
      throw new MethodNotFound(method)
  }
}

class MethodNotFound extends Error {
  readonly code = -32601

  constructor(method: string) {
    super(`Method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function handleLine(
  line: string,
): Promise<void> {
  const trimmed = line.trim()

  if (!trimmed) {
    return
  }

  let message: JsonRpcRequest

  try {
    message = JSON.parse(trimmed) as JsonRpcRequest
  } catch {
    writeError(null, -32700, 'Parse error')

    return
  }

  // A response from the client to one of our notifications: nothing to do.
  if (typeof message.method !== 'string') {
    return
  }

  const isNotification = message.id === undefined
  const params =
    message.params && typeof message.params === 'object'
      ? message.params
      : {}

  try {
    const result =
      await dispatch(message.method, params)

    if (!isNotification) {
      writeResult(message.id ?? null, result)
    }
  } catch (error) {
    if (isNotification) {
      return
    }

    const code =
      error instanceof MethodNotFound
        ? error.code
        : -32603

    const text =
      error instanceof Error
        ? error.message
        : String(error)

    // Tool failures are results with isError, not protocol errors; anything
    // reaching here is a broken request, so a protocol error is correct.
    writeError(message.id ?? null, code, text)
  }
}

async function loadVersion(): Promise<void> {
  try {
    const raw = await readFile(
      new URL('../../package.json', import.meta.url),
      'utf8',
    )

    const parsed =
      JSON.parse(raw) as { version?: unknown }

    if (typeof parsed.version === 'string') {
      serverVersion = parsed.version
    }
  } catch {
    // A renamed or absent package.json is cosmetic: the tools still work.
  }
}

async function main(): Promise<void> {
  await loadVersion()

  adoptTeam()

  // A client that walks away closes our stdout. That is a normal shutdown,
  // not a crash, and it must not print a stack trace into the client's log.
  process.stdout.on('error', () => {
    process.exit(0)
  })

  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  lines.on('line', (line: string) => {
    void handleLine(line)
  })

  lines.on('close', () => {
    process.exit(0)
  })

  process.stderr.write(
    `wednesday mcp ${serverVersion} ready (stdio)\n`,
  )
}

void main()

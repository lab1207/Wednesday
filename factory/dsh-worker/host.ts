import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { DSH_ROOT, WORKER_DIRECTORY, runtimeRoot } from '../paths'
import { extractFencedToolCalls, runFencedToolCalls } from './fenced-tools'
import { workerProvider } from './provider-route'
import { redactSecrets } from './secret-redaction'

/**
 * Factory dsh host (2026-10-30).
 *
 * Boots the host context, then drives the dsh ACP worker DIRECTLY with raw
 * JSON-RPC (initialize -> session/new -> session/prompt). The SDK client
 * (`@agentclientprotocol/sdk` ClientSideConnection, used by
 * dsh-subagent-acp's `startAcpRun`) hangs at `conn.prompt()` on this runtime
 * while the raw driver completes the same turn in seconds — see
 * factory/dsh-worker/sdk-probe.ts. The raw driver is therefore the live
 * execution seam.
 *
 * Contract with the executor (factory/executor/factory-executor.ts):
 *  - stdout: the agent's answer text (what the operator sees).
 *  - stderr: the JSON result receipt + diagnostics.
 *  - exit code: 0 on a completed turn, 1 otherwise.
 */

const log = (message: string): void => {
  // Never let a key, the tunnel URL/host, or any secret-shaped env value
  // reach stderr — the host's stderr is inherited by the executor and shown
  // to the operator, and undici errors can carry the upstream host:port.
  process.stderr.write(`[factory-host] ${redactSecrets(message)}\n`)
}

/**
 * Live activity lines on stdout.
 *
 * stdout is the ANSWER, so activity travels on marked lines and the executor
 * strips them before the answer is assembled. The marker is deliberately
 * unlikely to occur in a model's prose.
 *
 * The ACP bridge emits one `agent_message_chunk` per committed assistant
 * message, so these arrive WHILE the coder works — the operator sees the seat
 * talk and act instead of watching a spinner until the turn ends (operator,
 * 2026-11-04).
 */
const ACTIVITY_MARK = '@@WEDNESDAY_ACTIVITY@@'

const emitActivity = (activity: {
  kind: 'reasoning' | 'text' | 'tool' | 'file'
  text?: string
  tool?: string
  detail?: string
  status?: string
}): void => {
  try {
    process.stdout.write(`${ACTIVITY_MARK}${JSON.stringify(activity)}\n`)
  } catch {
    // A closed pipe ends the run; it must not end the host any earlier.
  }
}

log('START')

const hostConfig = resolveConfigPath(
  join(WORKER_DIRECTORY, 'host.cordis.yml'),
  undefined,
)

const taskPrompt =
  process.env.DSH_FACTORY_TASK_PROMPT ??
  'Create factory-test.txt containing exactly DSH_FILE_TEST_OK. Then read it back and reply with exactly: DSH_FILE_TEST_OK'

const taskWorkspace =
  process.env.DSH_FACTORY_TASK_WORKSPACE ??
  process.cwd()

log(`WORKSPACE=${taskWorkspace}`)

// Same rule as cordis.yml's acp provider: explicit DSH_LLM_PROVIDER wins;
// LOCAL_LLM_BASE_URL only falls back to local when no provider was named.
const modelProvider = workerProvider()

const model =
  process.env.DSH_LLM_MODEL?.trim() ||
  'stealth/ox-alpha'

// A local OpenAI-compatible server issues no credential; the placeholder key
// keeps the named-credential route from failing at boot.
if (modelProvider === 'local') {
  if (
    !process.env.LOCAL_LLM_API_KEY?.trim()
  ) {
    process.env.LOCAL_LLM_API_KEY =
      'local'
  }
  if (
    !process.env.LOCAL_LLM_BASE_URL?.trim()
  ) {
    process.env.LOCAL_LLM_BASE_URL =
      'http://127.0.0.1:1337/v1'
  }
}

// Values consumed by host.cordis.yml; set before boot parses its expressions.
const runtime = runtimeRoot()
const runtimeWorker = runtime
  ? join(runtime, 'node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')
  : undefined
const workerBin = runtimeWorker && existsSync(runtimeWorker)
  ? runtimeWorker
  : join(DSH_ROOT, 'packages', 'examples', 'factory-acp-worker', 'lib', 'bin.js')

const workerConfig = join(WORKER_DIRECTORY, 'cordis.yml')

// The host context still registers the `acp` subagent plugin; point it at the
// same worker/config so the context stays coherent (the direct driver below
// does NOT go through it — the SDK client hangs).
process.env.WEDNESDAY_ACP_WORKER = workerBin
process.env.WEDNESDAY_WORKER_CONFIG = workerConfig

// Child env: the parent's environment plus the deployment variables this run
// needs. The child needs the model route (provider/model/base URL/key); the
// rest of the ambient environment is inherited on purpose — a scrubbed env
// (dropping DSH_* names) is what made the coder stage look like a hang.
const childEnv: NodeJS.ProcessEnv = { ...process.env }
childEnv.DSH_LLM_PROVIDER = modelProvider
childEnv.DSH_LLM_MODEL = model
childEnv.DSH_FACTORY_TASK_WORKSPACE = taskWorkspace
if (modelProvider === 'local') {
  childEnv.LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY ?? 'local'
  childEnv.LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:1337/v1'
}
if (process.env.OPENROUTER_API_KEY) childEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (process.env.ZEN_API_KEY) childEnv.ZEN_API_KEY = process.env.ZEN_API_KEY
if (process.env.ZEN_BASE_URL) childEnv.ZEN_BASE_URL = process.env.ZEN_BASE_URL
// 2026-10-31 provider-agnostic crews: a seat pinned `nvidia/…` routes here,
// so the worker needs the NVIDIA credential too.
if (process.env.NVIDIA_API_KEY) childEnv.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY
if (process.env.NVIDIA_BASE_URL) childEnv.NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL

let ctx: Awaited<ReturnType<typeof boot>> | undefined
let parent: Awaited<ReturnType<typeof ctx.agents.create>> | undefined

try {
  log('BOOT_START')

  ctx = await boot(
    'factory-dsh-host',
    hostConfig,
  )

  log('BOOT_OK')

  log('PARENT_CREATE_START')

  parent = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: {
      cwd: taskWorkspace,
    },
    agentOptions: {
      provider: modelProvider,
      model,
    },
  })

  log(
    `PARENT_CREATE_OK id=${parent.agent.id}`,
  )

  log('ACP_START')

  const worker = spawn(process.execPath, [workerBin, '--config', workerConfig], {
    cwd: taskWorkspace,
    env: childEnv,
    // The ACP protocol rides stdout; the worker's own diagnostics go to the
    // inherited stderr so they reach the executor's diagnostics verbatim.
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const lines = createInterface({ input: worker.stdout })

  let seq = 0
  const write = (payload: unknown): void => {
    try {
      worker.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // The worker died mid-write; the exit handler settles the turn.
    }
  }
  const send = (method: string, params: unknown): void => {
    seq += 1
    write({ jsonrpc: '2.0', id: seq, method, params })
  }

  let promptStop: string | undefined
  let promptError: string | undefined
  let promptAnswered = false
  let workerExited = false
  let workerExitCode: number | null = null
  let sessionId: string | undefined
  // The prompt request id grows on retry, so `message.id === promptId` below
  // always matches the in-flight attempt.
  let promptId = 3
  // Transient stream failures (dead tunnel mid-turn, proxy restart, upstream
  // 5xx) end the turn with no answer. One resend fixes most of them; the old
  // behavior let the repair loop repeat the same dead call (2026-10-31).
  // Two resends by default (2026-11-01 live finding): a Colab/Cloudflare tunnel
  // routinely closes a long generation once — `Stream ended without
  // finish_reason` — and with one resend the coder stage died on the second cut
  // and the whole run failed after the model had already produced the work.
  const turnRetriesMax = (() => {
    const n = Number(process.env.FACTORY_TURN_RETRIES?.trim())
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 3) : 2
  })()
  let turnRetriesLeft = turnRetriesMax
  const fold: string[] = []
  // A native tool call shows up as a tool_call/tool_call_update session
  // update. Small models often answer with the tool call as fenced TEXT
  // instead — if no native call was seen, the fenced fallback below runs.
  let sawNativeToolCall = false

  const turnDone = new Promise<void>((resolve) => {
    // A dead child must settle the turn: without this the host waits out its
    // full cap on a worker that already failed to boot.
    worker.once('exit', (code, signal) => {
      workerExited = true
      workerExitCode = code
      if (!promptAnswered) {
        promptError = `ACP worker exited before answering the turn (code=${code ?? 'null'}, signal=${signal ?? '-'})`
        resolve()
      }
    })
    lines.on('line', (line: string) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      // Agent -> client REQUEST (permission, fs, etc.)
      if (message.method !== undefined && message.id !== undefined) {
        if (message.method === 'session/request_permission') {
          const options = message.params?.options as Array<{ optionId?: string; kind?: string }> | undefined
          const allow = options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
          write({
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: allow !== undefined ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } },
          })
        } else {
          write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not implemented' } })
        }
        return
      }
      // Notification (session/update etc.)
      if (message.method !== undefined) {
        const update = message.params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          const text = update.content.text ?? ''
          fold.push(text)
          // The seat's committed text, live. The executor turns this into an
          // `agent.activity` event, so the operator sees the coder work.
          emitActivity({ kind: 'text', text })
        }
        if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          sawNativeToolCall = true
          // A native tool call names itself: the title is the human sentence
          // ("Read src/index.ts", "Bash: npm test"), the kind is the class.
          const title = typeof update.title === 'string' ? update.title : undefined
          const kind = typeof update.kind === 'string' ? update.kind : undefined
          const status = typeof update.status === 'string' ? update.status : undefined
          const path = Array.isArray(update.locations)
            ? update.locations.find((where: any) => typeof where?.path === 'string')?.path
            : undefined
          emitActivity({
            kind: 'tool',
            tool: title ?? kind,
            detail: typeof path === 'string' ? path : undefined,
            status,
          })
        }
        return
      }
      // Response to one of our requests.
      if (message.id === 1) {
        if (message.error !== undefined) {
          promptError = `ACP initialize failed: ${JSON.stringify(message.error)}`
          resolve()
          return
        }
        log('ACP_INITIALIZE_OK')
        send('session/new', { cwd: taskWorkspace, mcpServers: [] })
      } else if (message.id === 2) {
        if (message.error !== undefined) {
          promptError = `ACP session/new failed: ${JSON.stringify(message.error)}`
          resolve()
          return
        }
        log('ACP_SESSION_OK')
        sessionId = message.result?.sessionId
        send('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: taskPrompt }],
        })
      } else if (message.id === promptId) {
        const err = message.error === undefined ? undefined : JSON.stringify(message.error)
        if (err !== undefined && turnRetriesLeft > 0 && !workerExited) {
          turnRetriesLeft -= 1
          promptId += 1
          log(`ACP_TURN_RETRY left=${turnRetriesLeft} reason=${err.slice(0, 160)}`)
          send('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: taskPrompt }],
          })
          return
        }
        promptAnswered = true
        promptStop = message.result?.stopReason
        promptError = err
        try {
          worker.stdin.end()
        } catch {
          // Already gone.
        }
        resolve()
      }
    })
  })

  // Kick off the ACP handshake.
  send('initialize', { protocolVersion: 1, clientCapabilities: {} })

  // Wait for the turn to complete. The cap follows the SAME operator knob the
  // role runner uses for the coder (FACTORY_CODER_TIMEOUT_MS, default 5 min):
  // a small model on a remote GPU needs minutes per turn, and a cap shorter
  // than the executor's own timeout kills a healthy turn.
  const turnCapMs = (() => {
    const configured = Number(process.env.FACTORY_CODER_TIMEOUT_MS?.trim())
    return Number.isFinite(configured) && configured > 0
      ? configured + 30_000
      : 330_000
  })()
  const capTimer = setTimeout(() => {
    log('ACP_TURN_TIMEOUT')
    worker.kill('SIGKILL')
  }, turnCapMs)

  await turnDone
  clearTimeout(capTimer)

  const answer = fold.join('').trim()

  // Fenced-tool fallback (2026-10-31 live-run finding): a small model can
  // emit its tool call as a ```json block in plain text. Those never execute
  // inside the worker, so run them here, confined to the task workspace, and
  // append the transcript so the next turn sees what actually happened.
  let finalAnswer = answer
  if (!sawNativeToolCall) {
    const fenced = extractFencedToolCalls(answer)
    if (fenced.length > 0) {
      log(`FENCED_TOOL_FALLBACK calls=${fenced.length}`)
      const transcript = await runFencedToolCalls(taskWorkspace, fenced, (call, status) => {
        // The command the model asked for, and whether it ran. The arguments
        // carry the path or the command line, in the shapes the small models
        // actually emit.
        const args = call.args ?? {}
        const detail = ['command', 'cmd', 'script', 'file_path', 'path', 'file']
          .map(key => args[key])
          .find(value => typeof value === 'string' && value.trim().length > 0)
        emitActivity({
          kind: 'tool',
          tool: call.name,
          detail: typeof detail === 'string' ? detail : undefined,
          status,
        })
      })
      finalAnswer = `${answer}\n\n[fenced tool calls executed by host]\n${transcript}`
    }
  }

  if (promptAnswered && promptStop === 'end_turn') {
    log('ACP_TURN_OK stopReason=end_turn')

    // stdout carries the answer: the executor puts it in the result receipt.
    if (finalAnswer.length > 0) {
      process.stdout.write(`${finalAnswer}\n`)
    }

    process.stderr.write(
      redactSecrets(
        JSON.stringify(
          {
            stopReason: 'completed',
            output: finalAnswer.length > 0 ? [{ type: 'text', text: finalAnswer }] : [],
            diagnostic: promptError,
          },
          null,
          2,
        ),
      ) + '\n',
    )
  } else {
    log(`ACP_TURN_FAILED stopReason=${promptStop ?? 'none'}`)

    process.stderr.write(
      redactSecrets(
        JSON.stringify(
          {
            stopReason: promptStop === undefined ? 'error' : promptStop,
            output: [],
            diagnostic: promptError ?? `ACP turn ended with stopReason=${promptStop ?? 'none'}`,
          },
          null,
          2,
        ),
      ) + '\n',
    )

    process.exitCode = 1
  }

  // Wait for the worker to exit. The worker can crash in its own teardown on
  // Windows (libuv assert) AFTER the answer arrived — that must not fail a
  // completed turn — but a crash BEFORE the answer already failed above.
  if (!workerExited) {
    await new Promise<void>((resolve) => {
      worker.once('exit', (code, signal) => {
        workerExited = true
        workerExitCode = code
        log(`WORKER_EXIT code=${code ?? 'null'} signal=${signal ?? '-'}`)
        resolve()
      })
    })
  } else {
    log(`WORKER_EXIT code=${workerExitCode ?? 'null'}`)
  }

} catch (error) {
  log(
    `ERROR ${
      error instanceof Error
        ? error.stack ?? error.message
        : String(error)
    }`,
  )

  process.exitCode = 1
} finally {
  log('CLEANUP_START')

  try {
    if (parent) {
      await parent.dispose()
    }
  } catch (error) {
    log(
      `PARENT_DISPOSE_ERROR ${String(error)}`,
    )
  }

  try {
    if (ctx) {
      await ctx.fiber.dispose()
    }
  } catch (error) {
    log(
      `CTX_DISPOSE_ERROR ${String(error)}`,
    )
  }

  log('CLEANUP_DONE')
}

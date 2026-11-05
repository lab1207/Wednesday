import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeRoot } from '../paths'
import { redactSecrets } from './secret-redaction'

/**
 * ACP probe (2026-10-30, full-loop): drives the ACP worker DIRECTLY through
 * the complete coder turn — initialize, session/new, session/prompt — with a
 * scripted OpenAI-compatible model server (write -> read -> answer), fully
 * offline. Host, plugin, and subprocess env scrub are all removed.
 *
 * History: the 2026-10-30 first probe never actually SENT initialize (it only
 * reacted to the response), so its "silent worker" verdict was void; the
 * handshake-only bisect (acp-bisect.ts) answered in every configuration
 * including the failing probe's exact setup. The remaining suspect region is
 * between session/prompt and the first LLM call — exactly what this driver
 * exercises. Run: npx tsx factory/dsh-worker/acp-probe.ts
 */

const runtime = runtimeRoot()
const workerBin = runtime
  ? join(runtime, 'node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')
  : undefined
if (!workerBin || !existsSync(workerBin)) {
  console.error(`ACP PROBE: FAIL — no worker bin (runtime=${runtime ?? 'none'})`)
  process.exit(1)
}
const configPath = join(process.cwd(), 'factory', 'dsh-worker', 'cordis.yml')
if (!existsSync(configPath)) {
  console.error(`ACP PROBE: FAIL — no config (${configPath})`)
  process.exit(1)
}

interface ToolCall {
  name: string
  args: string
}

interface Turn {
  toolCalls?: ToolCall[]
  content?: string
}

/** Scripted agent behavior: write the file, read it back, then answer. */
const script: Turn[] = [
  { toolCalls: [{ name: 'write', args: JSON.stringify({ path: 'probe-test.txt', content: 'PROBE_OK' }) }] },
  { toolCalls: [{ name: 'read', args: JSON.stringify({ path: 'probe-test.txt' }) }] },
  { content: 'PROBE_OK' },
]

const calls: Array<{ url: string; model?: string; messages?: number; tools?: number; stream?: boolean }> = []
let turnProbe = 0
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += String(chunk) })
  req.on('end', () => {
    let body: { model?: string; messages?: unknown[]; tools?: unknown[]; stream?: boolean } = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    calls.push({ url: req.url ?? '', model: body.model, messages: body.messages?.length, tools: body.tools?.length, stream: body.stream })
    console.log(`[${Date.now() - baseEpoch}ms] MODEL CALL #${calls.length} ${req.url} model=${body.model} msgs=${body.messages?.length} tools=${body.tools?.length} stream=${body.stream}`)
    const turn = script[turnProbe++] ?? script[script.length - 1]!
    if (turnProbe > script.length + 2) turnProbe = script.length
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = {
      id: `cmpl-probe-${turnProbe}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'probe-fake',
      choices: [] as unknown[],
    }
    if (turn.toolCalls) {
      for (const [i, call] of turn.toolCalls.entries()) {
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: i, id: `call-${turnProbe}-${i}`, type: 'function', function: { name: call.name, arguments: call.args } }] },
            finish_reason: null,
          }],
        })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: turn.content }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  })
})
server.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { server.once('listening', resolve) })
const baseEpoch = Date.now()
const baseURL = `http://127.0.0.1:${(server.address() as { port?: number }).port}/v1`

const workspace = await mkdtemp(join(process.env.LOCALAPPDATA ?? tmpdir(), 'acp-probe-'))
await mkdir(workspace, { recursive: true })

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_LLM_PROVIDER: 'local',
  DSH_LLM_MODEL: 'probe-fake',
  LOCAL_LLM_BASE_URL: baseURL,
  LOCAL_LLM_API_KEY: 'local',
  WEDNESDAY_WORKER_CONFIG: configPath,
}

const worker = spawn(process.execPath, [workerBin, '--config', configPath], {
  cwd: workspace,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderr = ''
worker.stderr.setEncoding('utf8').on('data', data => { stderr += data })

const TASK = 'Create probe-test.txt containing exactly PROBE_OK. Then read it back and reply with exactly: PROBE_OK'

let seq = 0
const send = (method: string, params: unknown): void => {
  const id = ++seq
  worker.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  console.log(`[${Date.now() - baseEpoch}ms] -> ${method} (req ${id})`)
  return
}

let promptStop: string | undefined
let promptError: string | undefined
let promptAnswered = false

const lines = createInterface({ input: worker.stdout })
lines.on('line', line => {
  let message: Record<string, any>
  try {
    message = JSON.parse(line)
  } catch {
    console.log(`[${Date.now() - baseEpoch}ms] <- (unparsable) ${line.slice(0, 200)}`)
    return
  }
  const hasMethod = message.method !== undefined
  if (hasMethod && message.id !== undefined) {
    // Agent -> client REQUEST. Mirror the host policy (permission allow);
    // answer anything else with an error so the turn sees a denial, never
    // client silence.
    console.log(`[${Date.now() - baseEpoch}ms] <- AGENT REQUEST ${message.method} (req ${message.id}) ${JSON.stringify(message.params ?? {}).slice(0, 200)}`)
    if (message.method === 'session/request_permission') {
      const options = message.params?.options as Array<{ optionId?: string; kind?: string }> | undefined
      const allow = options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
      const answer = allow !== undefined
        ? { outcome: 'selected', optionId: allow.optionId }
        : { outcome: 'cancelled' }
      worker.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: answer } })}\n`)
    } else {
      worker.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'client does not implement this capability (probe)' } })}\n`)
    }
    return
  }
  if (hasMethod) {
    // Notification (no id): session/update etc.
    const kind = message.params?.update?.sessionUpdate ?? message.method
    console.log(`[${Date.now() - baseEpoch}ms] <- notify ${message.method} ${String(kind).slice(0, 120)} ${JSON.stringify(message.params ?? {}).slice(0, 240)}`)
    return
  }
  // Response to one of OUR requests.
  console.log(`[${Date.now() - baseEpoch}ms] <- response id=${message.id} ${JSON.stringify(message.result ?? message.error ?? {}).slice(0, 240)}`)
  if (message.id === 1) {
    send('session/new', { cwd: workspace, mcpServers: [] })
  } else if (message.id === 2) {
    send('session/prompt', { sessionId: message.result?.sessionId, prompt: [{ type: 'text', text: TASK }] })
  } else if (message.id === 3) {
    promptAnswered = true
    promptStop = message.result?.stopReason ?? undefined
    promptError = message.error === undefined ? undefined : JSON.stringify(message.error)
    // Quiesce the child like the host's EOF ladder.
    worker.stdin.end()
  }
})

// Kick off like runtime-test and the bisect did: FIRST byte is initialize;
// every later request answers the previous response (id 1 -> newSession,
// id 2 -> prompt, id 3 -> answered).
send('initialize', { protocolVersion: 1, clientCapabilities: {} })

const CAP_MS = 60_000
const timer = setTimeout(() => {
  console.log(`CAP REACHED (${CAP_MS}ms) — killing worker`)
  worker.kill('SIGKILL')
}, CAP_MS)

const [code, signal] = await new Promise<[number | null, string | null]>(resolve => {
  worker.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
})
clearTimeout(timer)
lines.close()
server.close()

let fileText: string | undefined
try {
  fileText = await readFile(join(workspace, 'probe-test.txt'), 'utf8')
} catch {
  fileText = undefined
}

console.log('')
console.log(`worker exit=${code} signal=${signal ?? '-'}`)
console.log(`prompt answered=${promptAnswered} stop=${promptStop ?? '-'}${promptError ? ` error=${promptError.slice(0, 160)}` : ''}`)
console.log(`model calls=${calls.length}`)
console.log(`probe-test.txt: ${fileText === undefined ? 'MISSING' : `written (${JSON.stringify(fileText.slice(0, 60))})`}`)
const stderrTail = stderr.trim().split('\n').slice(-6).join('\n')
if (stderrTail) {
  console.log('--- worker stderr (tail) ---')
  console.log(redactSecrets(stderrTail))
}
const offlineTurn = promptAnswered && promptStop === 'end_turn' && calls.length >= 3 && fileText?.includes('PROBE_OK')
console.log(offlineTurn ? 'ACP PROBE: FULL LOOP PASS (model called, tools executed, answer returned — offline)' : 'ACP PROBE: FAIL (details above)')
process.exit(0)

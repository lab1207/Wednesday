import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runtimeRoot } from '../paths'
import { redactSecrets } from './secret-redaction'

/**
 * SDK driver probe (2026-10-30): uses the @agentclientprotocol/sdk
 * ClientSideConnection (exactly like dsh-subagent-acp's startAcpRun) to drive
 * the ACP worker, instead of the raw-JSON client that acp-probe.ts uses.
 *
 * If THIS hangs (while acp-probe's raw client passes), the SDK client driver
 * is the coder-stage culprit. Run: npx tsx factory/dsh-worker/sdk-probe.ts
 */

const runtime = runtimeRoot()
if (!runtime) {
  console.error('SDK PROBE: FAIL — no runtime root')
  process.exit(1)
}
const workerBin = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')
if (!existsSync(workerBin)) {
  console.error(`SDK PROBE: FAIL — no worker bin (${workerBin})`)
  process.exit(1)
}
const configPath = join(process.cwd(), 'factory', 'dsh-worker', 'cordis.yml')
if (!existsSync(configPath)) {
  console.error(`SDK PROBE: FAIL — no config (${configPath})`)
  process.exit(1)
}

// Import the SDK from the installed runtime's node_modules.
const sdkRequire = createRequire(join(runtime, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'))
const {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} = sdkRequire('@agentclientprotocol/sdk')

const workspace = await mkdtemp(join(process.env.LOCALAPPDATA ?? tmpdir(), 'sdk-probe-'))
await mkdir(workspace, { recursive: true })

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += String(chunk) })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'cmpl-sdk', object: 'chat.completion.chunk', created: 1, model: 'sdk-fake', choices: [] as unknown[] }
    // Scripted: write -> read -> answer
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'sdk-test.txt', content: 'SDK_OK' }) } }] }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
server.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { server.once('listening', resolve) })
const baseURL = `http://127.0.0.1:${(server.address() as { port?: number }).port}/v1`

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_LLM_PROVIDER: 'local',
  DSH_LLM_MODEL: 'sdk-fake',
  LOCAL_LLM_BASE_URL: baseURL,
  LOCAL_LLM_API_KEY: 'local',
  WEDNESDAY_WORKER_CONFIG: configPath,
}

const { Readable, Writable } = await import('node:stream')
const child = spawn(process.execPath, [workerBin, '--config', configPath], {
  cwd: workspace,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.setEncoding('utf8').on('data', data => { stderr += data })

// Use the SDK's ClientSideConnection exactly like startAcpRun.
const fold: string[] = []
const makeClient = () => ({
  sessionUpdate: (params: { update: { sessionUpdate: string; content?: { type: string; text?: string } } }) => {
    if (params.update.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') {
      fold.push(params.update.content.text ?? '')
    }
    return Promise.resolve()
  },
  requestPermission: (params: { options: Array<{ optionId: string; kind: string }> }) => {
    const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    return Promise.resolve(allow !== undefined
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  },
})

const conn = new ClientSideConnection(
  makeClient,
  ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
)

const t0 = Date.now()
console.log(`[${Date.now() - t0}ms] SDK PROBE: spawning worker...`)

try {
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  console.log(`[${Date.now() - t0}ms] SDK PROBE: initialized`)
  const session = await conn.newSession({ cwd: workspace, mcpServers: [] })
  const sessionId = (session as { sessionId: string }).sessionId
  console.log(`[${Date.now() - t0}ms] SDK PROBE: session ${sessionId}`)
  const result = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'Create sdk-test.txt containing exactly SDK_OK. Then read it back and reply with exactly: SDK_OK' }] })
  console.log(`[${Date.now() - t0}ms] SDK PROBE: prompt done stopReason=${(result as { stopReason: string }).stopReason} output=${JSON.stringify(fold.join(''))}`)
} catch (err) {
  console.log(`[${Date.now() - t0}ms] SDK PROBE: ERROR ${redactSecrets(err instanceof Error ? err.message : String(err))}`)
}

child.stdin.end()
const [code] = await new Promise<[number | null]>((resolve) => {
  child.once('exit', (c) => resolve([c]))
})
console.log(`[${Date.now() - t0}ms] SDK PROBE: worker exit=${code}`)
if (stderr.trim()) console.log(`worker stderr: ${redactSecrets(stderr.trim().split('\n').slice(-3).join(' | '))}`)
server.close()
await rm(workspace, { recursive: true, force: true })
process.exit(0)

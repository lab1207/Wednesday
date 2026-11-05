import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WORKER_DIRECTORY } from '../paths'

/**
 * Coder-loop proof (2026-10-30): the REAL host path
 * (factory/dsh-worker/host.ts -> dsh ACP worker -> model) must complete a
 * write -> read -> answer turn against a scripted OpenAI-compatible server,
 * offline.
 *
 * Why this file exists (the bugs it locks down):
 *  - the host drives the ACP worker with raw JSON-RPC; the SDK client
 *    (`@agentclientprotocol/sdk`) hangs at `conn.prompt()` (see sdk-probe.ts),
 *    so this test only passes with the raw driver.
 *  - the dsh fs tools take `file_path` (+ `content`), NOT `path`; a scripted
 *    `write` with `path` silently writes nothing.
 *  - the harness must NOT use `spawnSync` around the host: the scripted model
 *    server lives in THIS process, and a blocking spawn stops its event loop,
 *    so the child never gets a model answer (the original "hang").
 *
 * Run: npx tsx factory/dsh-worker/coder-loop-test.ts
 */

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const HOST = join(WORKER_DIRECTORY, 'host.ts')
const TARGET_FILE = 'factory-test.txt'
const TARGET_CONTENT = 'CREW_OK'

interface ModelCall {
  model?: string
  messages: unknown[]
  toolNames: string[]
}

interface Turn {
  /** Tool to call; matched against the tools the worker advertised. */
  tool?: 'write' | 'read'
  args?: Record<string, unknown>
  /** Final answer text (no tool call). */
  content?: string
}

/** Scripted agent behavior: write the file, read it back, then answer. */
const script: Turn[] = [
  { tool: 'write', args: { file_path: TARGET_FILE, content: TARGET_CONTENT } },
  { tool: 'read', args: { file_path: TARGET_FILE } },
  { content: TARGET_CONTENT },
]

/** Pick the advertised tool whose name matches the wanted role. */
function pickTool(
  advertised: string[],
  wanted: 'write' | 'read',
): string {
  const exact = advertised.find(name => name === wanted)
  if (exact !== undefined) return exact
  const loose = advertised.find(name => name.includes(wanted))
  assert.ok(
    loose !== undefined,
    `worker advertised no '${wanted}' tool (saw: ${advertised.join(', ') || 'none'})`,
  )
  return loose
}

function startModelServer(
  calls: ModelCall[],
): { server: Server; baseURL(): string } {
  let turn = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      let body: {
        model?: string
        messages?: unknown[]
        tools?: Array<{ function?: { name?: string } }>
      } = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const toolNames = (body.tools ?? [])
        .map(tool => tool.function?.name)
        .filter((name): name is string => typeof name === 'string')
      const messages = body.messages ?? []
      calls.push({ model: body.model, messages, toolNames })
      console.log(
        `  model call #${calls.length} model=${body.model ?? '-'} msgs=${messages.length} tools=${toolNames.length}`,
      )

      const planned = script[Math.min(turn, script.length - 1)]!
      turn += 1

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: `cmpl-${turn}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model ?? 'coder-fake',
        choices: [] as unknown[],
      }

      if (planned.tool !== undefined) {
        const name = pickTool(toolNames, planned.tool)
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `call-${turn}`,
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify(planned.args ?? {}),
                },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`)
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: planned.content ?? '' },
            finish_reason: null,
          }],
        })}\n\n`)
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    })
  })
  return {
    server,
    baseURL(): string {
      const address = server.address() as AddressInfo
      return `http://127.0.0.1:${address.port}/v1`
    },
  }
}

interface HostRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Run the host asynchronously — the model server must keep serving. */
function runHost(
  workspace: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<HostRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, HOST],
      {
        cwd: workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk) })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`host did not exit within ${timeoutMs} ms`))
    }, timeoutMs)

    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function main(): Promise<void> {
  const calls: ModelCall[] = []
  const model = startModelServer(calls)
  model.server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => { model.server.once('listening', resolve) })

  const staging = await mkdtemp(join(tmpdir(), 'wednesday-coder-loop-'))
  const workspace = join(staging, 'workspace')
  await mkdir(workspace, { recursive: true })

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_LLM_PROVIDER: 'local',
      DSH_LLM_MODEL: 'coder-fake',
      LOCAL_LLM_BASE_URL: model.baseURL(),
      LOCAL_LLM_API_KEY: 'local',
      DSH_FACTORY_TASK_PROMPT:
        `Create ${TARGET_FILE} containing exactly ${TARGET_CONTENT}. Then read it back and reply with exactly: ${TARGET_CONTENT}`,
      DSH_FACTORY_TASK_WORKSPACE: workspace,
    }

    const run = await runHost(workspace, env, 90_000)

    let fileText: string | undefined
    try {
      fileText = await readFile(join(workspace, TARGET_FILE), 'utf8')
    } catch {
      fileText = undefined
    }

    const answer = calls.at(-1)?.messages ?? []

    console.log('')
    console.log(`host exit=${run.code ?? 'null'} signal=${run.signal ?? '-'}`)
    console.log(`model calls=${calls.length}`)
    console.log(`${TARGET_FILE}: ${fileText === undefined ? 'MISSING' : JSON.stringify(fileText)}`)
    console.log(`host stdout: ${JSON.stringify(run.stdout.slice(0, 400))}`)
    console.log(`host stderr tail: ${JSON.stringify(run.stderr.split('\n').slice(-12).join('\n'))}`)

    // 1. The host must finish cleanly.
    assert.equal(run.code, 0, `host exited with ${run.code} (signal ${run.signal ?? '-'})`)

    // 2. The turn must have reached the model three times (write, read, answer).
    assert.ok(calls.length >= 3, `expected >= 3 model calls, saw ${calls.length}`)

    // 3. The model must have advertised the fs tools.
    assert.ok(
      (calls[0]?.toolNames ?? []).length > 0,
      'the worker advertised no tools to the model',
    )

    // 4. The write tool must have created the file with the exact content.
    assert.equal(
      fileText,
      TARGET_CONTENT,
      `${TARGET_FILE} was not written with the expected content`,
    )

    // 5. The read tool must have handed the content back to the model.
    const sawContent = JSON.stringify(answer).includes(TARGET_CONTENT)
    assert.ok(sawContent, 'the model never saw the file content (read-back missing)')

    // 6. The answer must reach stdout (the executor's operator-visible output).
    assert.match(
      run.stdout,
      new RegExp(TARGET_CONTENT),
      'the host did not write the answer to stdout',
    )

    console.log('')
    console.log('CODER LOOP: PASS (write -> read -> answer through the real host path)')
  } finally {
    model.server.close()
    await rm(staging, { recursive: true, force: true }).catch()
  }
}

main().catch(error => {
  console.error('')
  console.error('CODER LOOP: FAIL')
  console.error(error)
  process.exit(1)
})

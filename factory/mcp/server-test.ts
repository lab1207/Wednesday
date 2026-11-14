/**
 * Proves the MCP surface end to end, offline.
 *
 * This is not a unit test of the handlers. It spawns the real server the way
 * a harness would, speaks JSON-RPC over its stdin/stdout, and runs a real
 * (deterministic) Factory run through Hermes. If this passes, a client can
 * connect and get work done; if stdout ever carries a log line, the parse
 * check fails and the server is unusable in practice.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface JsonRpcReply {
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

class Client {
  private buffer = ''
  private nextId = 1
  private readonly waiting = new Map<
    number,
    { resolve: (value: JsonRpcReply) => void; reject: (error: Error) => void }
  >()
  readonly notifications: Record<string, unknown>[] = []
  readonly unparsed: string[] = []

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.push(chunk)
    })
  }

  private push(chunk: string): void {
    this.buffer += chunk

    let newline = this.buffer.indexOf('\n')

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)

      if (line) {
        this.handle(line)
      }

      newline = this.buffer.indexOf('\n')
    }
  }

  private handle(line: string): void {
    let message: JsonRpcReply & { method?: string }

    try {
      message = JSON.parse(line) as JsonRpcReply & { method?: string }
    } catch {
      // A single non-JSON line on stdout means every real client would drop
      // the connection. Record it so the test can name the actual bytes.
      this.unparsed.push(line)

      return
    }

    if (message.method && message.id === undefined) {
      this.notifications.push(message as Record<string, unknown>)

      return
    }

    const id = Number(message.id)
    const waiter = this.waiting.get(id)

    if (!waiter) {
      return
    }

    this.waiting.delete(id)
    waiter.resolve(message)
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 90_000,
  ): Promise<JsonRpcReply> {
    const id = this.nextId

    this.nextId += 1

    const reply = new Promise<JsonRpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)

      this.waiting.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })

    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    )

    return reply
  }

  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ payload: any; isError: boolean }> {
    const reply = await this.request('tools/call', {
      name,
      arguments: args,
    })

    assert.equal(reply.error, undefined, `tool ${name} failed: ${JSON.stringify(reply.error)}`)

    const result = reply.result as {
      content: { type: string; text: string }[]
      isError?: boolean
    }

    assert.ok(Array.isArray(result.content), `tool ${name} returned no content`)
    assert.equal(result.content[0].type, 'text')

    const text = result.content[0].text

    let payload: unknown

    try {
      payload = JSON.parse(text)
    } catch {
      // Errors are deliberately human sentences, not JSON: an agent reads
      // them the same way it reads a tool failure.
      payload = text
    }

    return {
      payload,
      isError: result.isError === true,
    }
  }
}

const SEATS = [
  'architect',
  'planner',
  'coder',
  'implementer',
  'reviewer',
  'verifier',
]

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wednesday-mcp-'))
  const workspace = join(directory, 'workspace')

  // The run needs a real directory to work in, and an empty one is the
  // honest fixture: no repo, no build system, just the plumbing.
  await mkdir(workspace, { recursive: true })

  // A staffed team, written exactly the way the terminal harness writes it,
  // in the state home this server is pointed at. The operator picks the team
  // once; every harness that connects must get that team, not its own idea of
  // one. `deterministic-v1` is the only model id deterministic mode can
  // resolve, so the crew does not silently change the run's outcome.
  const crewId = 'crew_test_twoseat'

  await mkdir(join(directory, 'state'), { recursive: true })

  await writeFile(
    join(directory, 'state', 'crews.json'),
    JSON.stringify({
      crews: [
        {
          id: crewId,
          name: 'Two-seat test crew',
          seats: [
            { role: 'coder', model: 'deterministic-v1' },
            { role: 'reviewer', model: 'deterministic-v1' },
          ],
          policy: { shape: 'solo' },
        },
      ],
      active: crewId,
    }),
    'utf8',
  )

  const server = fileURLToPath(new URL('./server.ts', import.meta.url))

  const child = spawn(
    process.execPath,
    [...process.execArgv, server],
    {
      env: {
        ...process.env,
        HERMES_TASKS_PATH: join(directory, 'tasks.json'),
        FACTORY_EVENTS_PATH: join(directory, 'events.jsonl'),
        FACTORY_EXECUTION_MODE: 'deterministic',
        WEDNESDAY_STATE_HOME: join(directory, 'state'),
        WEDNESDAY_SKILLS_HOME: join(directory, 'skills'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams

  let stderr = ''

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const client = new Client(child)

  try {
    // --- handshake ------------------------------------------------------
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'wednesday-mcp-test', version: '0.0.0' },
    })

    assert.equal(init.error, undefined, JSON.stringify(init.error))

    const initResult = init.result as {
      protocolVersion: string
      serverInfo: { name: string; version: string }
      capabilities: Record<string, unknown>
    }

    assert.equal(initResult.protocolVersion, '2025-06-18')
    assert.equal(initResult.serverInfo.name, 'wednesday')
    assert.ok(initResult.serverInfo.version.length > 0)
    assert.ok(initResult.capabilities.tools)
    assert.ok(initResult.capabilities.prompts)

    // An unknown protocol is downgraded, never echoed blindly.
    const older = await client.request('initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
    })

    assert.equal(
      (older.result as { protocolVersion: string }).protocolVersion,
      '2025-06-18',
    )

    // A client notification gets no reply.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )

    const ping = await client.request('ping')

    assert.deepEqual(ping.result, {})

    // --- the surface is coarse on purpose -------------------------------
    const tools = await client.request('tools/list')

    const names = (
      tools.result as { tools: { name: string }[] }
    ).tools.map(tool => tool.name).sort()

    assert.deepEqual(names, [
      'wednesday_cancel',
      'wednesday_jobs',
      'wednesday_result',
      'wednesday_run',
      'wednesday_status',
      'wednesday_team',
      'wednesday_wait',
    ])

    for (const seat of SEATS) {
      assert.ok(
        !names.includes(seat) &&
          !names.includes(`wednesday_${seat}`),
        `the seat "${seat}" must never be callable from outside`,
      )
    }

    // --- the operator's team, not the client's idea of one ---------------
    const team = await client.call('wednesday_team', {})

    assert.equal(team.isError, false)
    assert.equal(team.payload.adopted, crewId)
    assert.equal(team.payload.selected.id, crewId)
    assert.equal(team.payload.in_sync, true)
    assert.equal(team.payload.selected.seats.length, 2)
    assert.equal(team.payload.selected.policy.shape, 'solo')

    // --- the prompt turns any harness into a messenger -------------------
    const prompts = await client.request('prompts/list')

    assert.deepEqual(
      (prompts.result as { prompts: { name: string }[] })
        .prompts.map(prompt => prompt.name),
      ['run'],
    )

    const prompt = await client.request('prompts/get', {
      name: 'run',
      arguments: { request: 'add a README section' },
    })

    const promptText = JSON.stringify(prompt.result)

    assert.ok(promptText.includes('Do not do the work yourself'))
    assert.ok(promptText.includes('add a README section'))

    // --- a bad request fails in the same call ---------------------------
    const bad = await client.call('wednesday_run', {
      request: 'build something',
      workspace: join(directory, 'does-not-exist'),
    })

    assert.equal(bad.isError, true)
    assert.ok(
      String(bad.payload).includes('does not exist'),
      String(bad.payload),
    )

    const empty = await client.call('wednesday_run', { request: '   ' })

    assert.equal(empty.isError, true)

    // --- a real run, end to end ----------------------------------------
    const started = await client.call('wednesday_run', {
      request: 'create hello.txt containing hello',
      workspace,
    })

    assert.equal(started.isError, false)

    const jobId = String(started.payload.job_id)

    assert.ok(jobId.startsWith('run-'), jobId)
    assert.ok(
      ['queued', 'running'].includes(started.payload.state),
      started.payload.state,
    )
    assert.equal(started.payload.workspace, workspace)

    // Polling must be cheap, idempotent and safe mid-run.
    const status = await client.call('wednesday_status', {
      job_id: jobId,
    })

    assert.equal(status.isError, false)
    assert.ok(
      ['queued', 'running', 'completed', 'failed'].includes(
        status.payload.state,
      ),
      status.payload.state,
    )
    assert.ok(Array.isArray(status.payload.progress))

    // Wait until terminal, the way a client would: repeat while !done.
    let waited = await client.call('wednesday_wait', {
      job_id: jobId,
      timeout_seconds: 30,
    })

    for (
      let attempt = 0;
      attempt < 6 && waited.payload.done === false;
      attempt += 1
    ) {
      waited = await client.call('wednesday_wait', {
        job_id: jobId,
        timeout_seconds: 30,
      })
    }

    assert.equal(waited.payload.done, true, 'the run never finished')
    assert.ok(
      ['completed', 'failed'].includes(waited.payload.state),
      waited.payload.state,
    )

    // --- the result is a verdict, not a transcript ----------------------
    const result = await client.call('wednesday_result', {
      job_id: jobId,
    })

    assert.equal(result.isError, false)
    assert.equal(result.payload.done, true)
    assert.equal(typeof result.payload.elapsed_ms, 'number')
    assert.ok(result.payload.elapsed_ms >= 0)
    assert.ok(result.payload.result, 'a finished run must carry its result')
    assert.equal(typeof result.payload.result.taskId, 'string')
    assert.ok(Array.isArray(result.payload.result.filesChanged))
    assert.ok(Array.isArray(result.payload.result.tests))

    // Deterministic mode cannot write a real change, so the run is allowed
    // to fail - but it must fail as an ENGINEERING verdict with a reason,
    // not as a broken pipe. That distinction is the whole point of the test.
    assert.ok(
      ['completed', 'failed'].includes(result.payload.result.status),
      String(result.payload.result.status),
    )

    assert.equal(
      typeof result.payload.result.summary,
      'string',
    )

    assert.ok(
      result.payload.result.summary.length > 0,
      'a failed run must say why',
    )

    // --- cancel is harmless once the job is terminal --------------------
    const cancelled = await client.call('wednesday_cancel', {
      job_id: jobId,
    })

    assert.equal(cancelled.isError, false)
    assert.ok(
      ['completed', 'failed', 'cancelled'].includes(
        cancelled.payload.state,
      ),
    )

    // --- a client restart can still find the run ------------------------
    const jobs = await client.call('wednesday_jobs', {})

    assert.ok(
      (jobs.payload.jobs as { job_id: string }[]).some(
        job => job.job_id === jobId,
      ),
    )

    // --- unknown things fail loudly, not silently -----------------------
    const unknownTool = await client.request('tools/call', {
      name: 'wednesday_architect',
      arguments: {},
    })

    assert.ok(unknownTool.error, 'an unknown tool must be an error')
    assert.ok(
      unknownTool.error!.message.includes('Unknown tool'),
      unknownTool.error!.message,
    )

    const unknownMethod = await client.request('no/such/method')

    assert.equal(unknownMethod.error?.code, -32601)

    // --- the transport stayed clean ------------------------------------
    assert.deepEqual(
      client.unparsed,
      [],
      `stdout carried non-protocol output: ${client.unparsed.join(' | ')}`,
    )
    assert.equal(
      client.notifications.length,
      0,
      'nothing should be notified without a progress token',
    )

    console.log(
      `wednesday mcp: PASS (run ${result.payload.state}, ${result.payload.elapsed_ms}ms)`,
    )
  } finally {
    child.stdin.end()

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5000)

      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    if (stderr.trim()) {
      process.stderr.write(stderr)
    }

    await rm(directory, { recursive: true, force: true })
  }
}

await main()

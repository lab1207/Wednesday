import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FactoryExecutor } from './index'
import type { EngineeringTask } from '../contracts'

/**
 * Executor end-to-end proof (2026-10-30): the whole live task path —
 * executor -> host child -> dsh ACP worker -> model -> verification ->
 * acceptance -> result receipt — must complete offline against a scripted
 * OpenAI-compatible server.
 *
 * This is the seam that was hanging: the coder stage never produced a result.
 * Run: npx tsx factory/executor/executor-e2e-test.ts
 */

const ARTIFACT = 'artifact.txt'
const CONTENT = 'E2E_OK'

interface Turn {
  tool?: 'write' | 'read'
  args?: Record<string, unknown>
  content?: string
}

const script: Turn[] = [
  { tool: 'write', args: { file_path: ARTIFACT, content: CONTENT } },
  { tool: 'read', args: { file_path: ARTIFACT } },
  { content: CONTENT },
]

function startServer(calls: string[]): { server: ReturnType<typeof createServer>; baseURL(): string } {
  let turn = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      let body: { model?: string; tools?: Array<{ function?: { name?: string } }> } = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const names = (body.tools ?? [])
        .map(tool => tool.function?.name)
        .filter((name): name is string => typeof name === 'string')
      calls.push(`model=${body.model ?? '-'} tools=${names.join('|')}`)

      const planned = script[Math.min(turn, script.length - 1)]!
      turn += 1

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: `cmpl-${turn}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model ?? 'executor-fake',
        choices: [] as unknown[],
      }
      if (planned.tool !== undefined) {
        const name = names.find(candidate => candidate === planned.tool)
          ?? names.find(candidate => candidate.includes(planned.tool))
        assert.ok(name !== undefined, `no '${planned.tool}' tool advertised (${names.join(', ')})`)
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
                function: { name, arguments: JSON.stringify(planned.args ?? {}) },
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
          usage: { prompt_tokens: 9, completion_tokens: 2 },
        })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    })
  })
  return {
    server,
    baseURL(): string {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    },
  }
}

const calls: string[] = []
const fake = startServer(calls)
fake.server.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { fake.server.once('listening', resolve) })

// The executor hands the host child the ambient environment plus the route;
// the local provider reads the base URL from here.
process.env.LOCAL_LLM_BASE_URL = fake.baseURL()
process.env.LOCAL_LLM_MODEL = 'executor-fake'
process.env.LOCAL_LLM_API_KEY = 'local'

const workspace = await mkdtemp(join(tmpdir(), 'wednesday-executor-e2e-'))

const task: EngineeringTask = {
  id: 'executor-e2e-001',
  workspace,
  objective: `Create ${ARTIFACT} containing exactly ${CONTENT}. Then read it back and report it.`,
  role: 'backend',
  stack: 'node',
  constraints: ['Write only the requested file'],
  acceptanceCriteria: [`${ARTIFACT} exists`],
  acceptance: { requiredFiles: [ARTIFACT] },
  modelRequirements: { capability: 'coding' },
  verification: { setupCommands: [], testCommands: ['node -e "process.exit(0)"'] },
}

try {
  const executor = new FactoryExecutor()
  const result = await executor.execute(task)

  console.log(`status=${result.status}`)
  console.log(`summary=${result.summary}`)
  console.log(`output=${JSON.stringify(result.output.slice(0, 200))}`)
  console.log(`filesChanged=${JSON.stringify(result.filesChanged)}`)
  console.log(`tests=${JSON.stringify(result.tests)}`)
  console.log(`acceptance=${JSON.stringify(result.acceptanceChecks)}`)
  console.log(`model calls=${calls.length}`)
  console.log(`diagnostics=${JSON.stringify(result.diagnostics ?? '').slice(0, 1500)}`)
  console.log(`workspace files=${JSON.stringify(await readdir(workspace))}`)

  assert.equal(result.status, 'completed', `executor status: ${result.status}`)
  assert.ok(result.output.includes(CONTENT), 'the answer did not reach the result receipt')
  assert.ok(
    result.filesChanged.some(file => file.includes(ARTIFACT)),
    `filesChanged did not list ${ARTIFACT}: ${JSON.stringify(result.filesChanged)}`,
  )
  assert.ok(
    result.acceptanceChecks.every(check => check.passed),
    'an acceptance check failed',
  )
  const text = await readFile(join(workspace, ARTIFACT), 'utf8')
  assert.equal(text, CONTENT, 'the artifact content is wrong')

  console.log('')
  console.log('EXECUTOR E2E: PASS (task -> host -> dsh worker -> model -> verification -> receipt)')
} finally {
  fake.server.close()
  await rm(workspace, { recursive: true, force: true }).catch()
}

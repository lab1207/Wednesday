import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/**
 * TUI chat smoke (2026-10-30): the operator surface must answer a plain
 * message through the real chat route (model router -> provider), not only
 * through unit tests.
 *
 * A scripted OpenAI-compatible server answers on a loopback port; the
 * harness is started as a real child process with piped stdin (the classic
 * path), the operator types one message and leaves with /exit.
 *
 * Run: npx tsx factory/harness/chat-tui-test.ts
 */

const ANSWER = 'TUI_CHAT_OK'

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += String(chunk) })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = {
      id: 'chat-tui',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-chat',
      choices: [] as unknown[],
    }
    for (const piece of ANSWER.split(' ')) {
      res.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: `${piece} ` }, finish_reason: null }],
      })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
server.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { server.once('listening', resolve) })
const port = (server.address() as AddressInfo).port

const entry = join(process.cwd(), 'bin', 'wednesday.js')

const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FACTORY_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LOCAL_LLM_MODEL: 'fake-chat',
    LOCAL_LLM_API_KEY: 'local',
    WEDNESDAY_NO_STARTUP_HEALTH: '1',
    WEDNESDAY_NO_UPDATE_CHECK: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk) })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk) })

child.stdin.write('what is the weather today\n')
await new Promise(resolve => setTimeout(resolve, 1500))
child.stdin.write('/exit\n')
child.stdin.end()

const timer = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
const code = await new Promise<number | null>(resolve => {
  child.once('close', value => resolve(value))
})
clearTimeout(timer)
server.close()

const output = `${stdout}\n${stderr}`
if (!output.includes(ANSWER)) {
  console.log('--- stdout ---')
  console.log(stdout.slice(-4000))
  console.log('--- stderr ---')
  console.log(stderr.slice(-4000))
}
assert.ok(output.includes(ANSWER), 'the harness did not show the model answer')
assert.equal(code, 0, `the harness exited with ${code}`)
console.log('TUI CHAT TEST: PASS (operator message -> model route -> streamed answer)')

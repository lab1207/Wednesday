import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { WORKER_DIRECTORY } from '../paths'

const staging = join(WORKER_DIRECTORY, 'deploy', 'runtime')
async function assertNoLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry)
    const metadata = await lstat(path)
    assert.equal(metadata.isSymbolicLink(), false, `runtime link: ${path}`)
    if (metadata.isDirectory()) await assertNoLinks(path)
  }
}
await assertNoLinks(staging)
const temporaryRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir()
await mkdir(temporaryRoot, { recursive: true })
const directory = await mkdtemp(join(temporaryRoot, 'wednesday-runtime-'))
try {
  const relocated = join(directory, 'moved runtime with spaces')
  const workspace = join(directory, 'unrelated workspace')
  const home = join(directory, 'empty profile')
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })
  await cp(staging, relocated, { recursive: true })
  for (const file of ['host.cordis.yml', 'cordis.yml']) {
    await cp(join(WORKER_DIRECTORY, file), join(relocated, file))
  }
  // Plain Node, no tsx, NODE_PATH or source imports. The probe and all plugin
  // imports live within the relocated artifact. No prompt/model call is sent.
  await writeFile(join(relocated, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
const root = import.meta.dirname
const workerBin = join(root, 'node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')
process.env.WEDNESDAY_ACP_WORKER = workerBin
process.env.WEDNESDAY_WORKER_CONFIG = join(root, 'cordis.yml')
process.env.DSH_FACTORY_TASK_WORKSPACE = process.cwd()
const ctx = await boot('wednesday-host-smoke', join(root, 'host.cordis.yml'), undefined, undefined, import.meta.url)
try {
  assert.ok(ctx.subagents.list().includes('acp'))
  console.log('HOST_BOOT_OK')
} finally {
  await ctx.fiber.dispose()
}
console.log('HOST_DISPOSED')
const worker = spawn(process.execPath, [workerBin, '--config', join(root, 'cordis.yml')], {
  cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
worker.stderr.setEncoding('utf8').on('data', data => { stderr += data })
const exit = once(worker, 'exit')
const lines = createInterface({ input: worker.stdout })
let initialized = false
let session = false
const timer = setTimeout(() => { worker.kill(); console.error('ACP timeout'); process.exitCode = 1 }, 30000)
const send = (id, method, params) => worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
lines.on('line', line => {
  try {
    const message = JSON.parse(line)
    if (message.id === 1) {
      assert.equal(message.error, undefined, JSON.stringify(message))
      assert.equal(message.result.protocolVersion, 1)
      initialized = true
      send(2, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    } else if (message.id === 2) {
      assert.equal(message.error, undefined, JSON.stringify(message))
      assert.equal(typeof message.result.sessionId, 'string')
      assert.ok(message.result.sessionId.length > 0)
      session = true
      worker.stdin.end()
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
    worker.kill()
  }
})
send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
const [code, signal] = await exit
clearTimeout(timer)
lines.close()
assert.equal(code, 0, stderr + ' signal=' + signal)
assert.ok(initialized, 'initialize response missing: ' + stderr)
assert.ok(session, 'session/new response missing: ' + stderr)
assert.equal(process.exitCode ?? 0, 0)
console.log('ACP_INITIALIZE_SESSION_EOF_OK')
`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'),
    OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: '' }
  for (const name of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|NODE_OPTIONS|NODE_PATH|DSH_|WEDNESDAY_/i.test(name)) delete env[name]
  }
  env.DSH_HOME = join(home, '.dsh')
  const result = spawnSync(process.execPath, [join(relocated, 'smoke.mjs')], {
    cwd: workspace, env, encoding: 'utf8', timeout: 60000,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout)
  assert.match(result.stdout, /HOST_BOOT_OK/)
  assert.match(result.stdout, /HOST_DISPOSED/)
  assert.match(result.stdout, /ACP_INITIALIZE_SESSION_EOF_OK/)
  console.log('RELOCATED DSH RUNTIME: PASS (zero links, plain Node, host boot/disposal, ACP initialize/session/new/EOF, no model call)')
} finally {
  await rm(directory, { recursive: true, force: true })
}

/**
 * Offline test for `/connect`: URL normalisation, env merging, the probe
 * contract, and the whole flow against a loopback OpenAI-shaped server.
 *
 * No real tunnel, no key, no spend. The flow's process-env mutation is
 * snapshotted and restored, and every write goes to a temp file — never the
 * operator's real profile.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  connectFlow,
  mergeEnv,
  normalizeBaseURL,
  probeModels,
  writeEnv,
  type ConnectUi,
} from './connect'

const TOUCHED = [
  'FACTORY_LLM_PROVIDER',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_MODEL',
  'DSH_LLM_MODEL',
  'LOCAL_TOOL_PROXY_UPSTREAM',
  'OPENROUTER_API_KEY',
  'FACTORY_CREW_PLANNER_MODEL',
  'FACTORY_CREW_PLANNER_BASE_URL',
  'FACTORY_CREW_CODER_MODEL',
  'FACTORY_CREW_CODER_BASE_URL',
  'FACTORY_CREW_VISION_MODEL',
  'FACTORY_CREW_VISION_BASE_URL',
]

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(TOUCHED.map(name => [name, process.env[name]]))
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
}

/** A UI that answers from a script and records what the operator would see. */
function scriptedUi(answers: Array<string | undefined>, transport: string): ConnectUi & { notes: string[]; errors: string[] } {
  const notes: string[] = []
  const errors: string[] = []
  let index = 0
  return {
    notes,
    errors,
    select: async () => transport,
    ask: async () => answers[index++],
    askPrivate: async () => answers[index++],
    note: text => notes.push(text),
    error: text => errors.push(text),
    progress: () => {},
    routeLabel: () => {},
  }
}

async function main(): Promise<void> {
  // 1. URL normalisation: the two shapes people actually paste, and refusal.
  assert.equal(normalizeBaseURL('https://a.ngrok-free.dev/v1'), 'https://a.ngrok-free.dev/v1')
  assert.equal(normalizeBaseURL('a.ngrok-free.dev'), 'https://a.ngrok-free.dev/v1')
  assert.equal(normalizeBaseURL('127.0.0.1:18090'), 'http://127.0.0.1:18090/v1')
  assert.equal(normalizeBaseURL('https://host/v1/chat/completions'), 'https://host/v1')
  assert.equal(normalizeBaseURL('https://host/v1/'), 'https://host/v1')
  assert.throws(() => normalizeBaseURL('ftp://host/v1'), /http and https/i)
  assert.throws(() => normalizeBaseURL('   '), /base URL/i)

  // 2. Env merge preserves comments and unrelated keys, updates in place once.
  const merged = mergeEnv(
    '# keep me\nOPENROUTER_API_KEY=old\nLOCAL_LLM_MODEL=before\n',
    { LOCAL_LLM_MODEL: 'after', FACTORY_LLM_PROVIDER: 'local' },
  )
  assert.match(merged, /# keep me/)
  assert.match(merged, /OPENROUTER_API_KEY=old/)
  assert.match(merged, /LOCAL_LLM_MODEL=after/)
  assert.match(merged, /FACTORY_LLM_PROVIDER=local/)
  assert.equal(merged.match(/LOCAL_LLM_MODEL=/g)?.length, 1)

  const dir = mkdtempSync(join(tmpdir(), 'wed-connect-'))
  const saved = snapshotEnv()
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder-3b-instruct' }] }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const baseURL = `http://127.0.0.1:${port}/v1`
  try {
    // 3. writeEnv roundtrip: a second connect updates, never duplicates.
    const file = join(dir, '.env')
    writeFileSync(file, 'OPENROUTER_API_KEY=keep\n')
    await writeEnv({ LOCAL_LLM_BASE_URL: baseURL, LOCAL_LLM_MODEL: 'one' }, file)
    await writeEnv({ LOCAL_LLM_MODEL: 'two' }, file)
    const written = readFileSync(file, 'utf8')
    assert.match(written, /OPENROUTER_API_KEY=keep/)
    assert.match(written, /LOCAL_LLM_MODEL=two/)
    assert.equal(written.match(/LOCAL_LLM_MODEL=/g)?.length, 1)

    // 4. Probe: list parsed; HTTP failure and dead port are named, not thrown.
    const okProbe = await probeModels(baseURL, undefined, 2000)
    assert.equal(okProbe.ok, true)
    assert.deepEqual(okProbe.models, ['qwen2.5-coder-3b-instruct'])
    const missing = await probeModels(`http://127.0.0.1:${port}/nope`, undefined, 2000)
    assert.equal(missing.ok, false)
    assert.equal(missing.status, 404)
    const dead = await probeModels('http://127.0.0.1:1/v1', undefined, 1000)
    assert.equal(dead.ok, false)
    assert.ok((dead.error ?? '').length > 0)

    // 5. The full local flow: one listed model needs no model prompt, the
    //    receipt names host + model, and the route applies to this process.
    const ui = scriptedUi([baseURL, 'n'], 'ngrok')
    const result = await connectFlow(ui, { path: file, timeoutMs: 2000 })
    assert.equal(result.ok, true, JSON.stringify(ui.errors))
    assert.match(result.receipt ?? '', /qwen2\.5-coder-3b-instruct/)
    assert.match(result.receipt ?? '', new RegExp(`127\\.0\\.0\\.1:${port}`))
    assert.equal(process.env.FACTORY_LLM_PROVIDER, 'local')
    assert.equal(process.env.LOCAL_LLM_BASE_URL, baseURL)
    assert.equal(process.env.DSH_LLM_MODEL, 'qwen2.5-coder-3b-instruct')
    assert.equal(process.env.FACTORY_CREW_CODER_MODEL, undefined)
    const localFile = readFileSync(file, 'utf8')
    assert.match(localFile, new RegExp(`LOCAL_LLM_BASE_URL=${baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // A loopback route is already direct: do not invent a proxy upstream.
    assert.doesNotMatch(localFile, /LOCAL_TOOL_PROXY_UPSTREAM=/)

    // 6. All seats: the default answer (Enter) fills every crew slot.
    const seatsFile = join(dir, 'seats.env')
    const seatsUi = scriptedUi([baseURL, ''], 'cloudflare')
    const seats = await connectFlow(seatsUi, { path: seatsFile, timeoutMs: 2000 })
    assert.equal(seats.ok, true, JSON.stringify(seatsUi.errors))
    const seatsWritten = readFileSync(seatsFile, 'utf8')
    for (const slot of ['PLANNER', 'CODER', 'VISION']) {
      assert.match(seatsWritten, new RegExp(`FACTORY_CREW_${slot}_MODEL=qwen2\\.5-coder-3b-instruct`))
      assert.match(seatsWritten, new RegExp(`FACTORY_CREW_${slot}_BASE_URL=`))
    }

    // 7. A failed probe does not write unless the operator insists.
    const failFile = join(dir, 'fail.env')
    const failUi = scriptedUi(['http://127.0.0.1:1/v1', 'n'], 'ngrok')
    const failed = await connectFlow(failUi, { path: failFile, timeoutMs: 500 })
    assert.equal(failed.ok, false)
    assert.ok(failUi.errors.some(text => /could not reach/.test(text)))
    assert.throws(() => readFileSync(failFile, 'utf8'))

    // 8. OpenRouter: the key is written, never echoed in any receipt.
    const fakeFetch = (async () => new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-chat' }] }), { status: 200 })) as typeof fetch
    const orFile = join(dir, 'openrouter.env')
    const orUi = scriptedUi(['TESTKEY_123', 'deepseek/deepseek-chat'], 'openrouter')
    const orResult = await connectFlow(orUi, { path: orFile, fetchImpl: fakeFetch, timeoutMs: 2000 })
    assert.equal(orResult.ok, true, JSON.stringify(orUi.errors))
    assert.ok(!orUi.notes.some(text => text.includes('TESTKEY_123')))
    assert.match(readFileSync(orFile, 'utf8'), /OPENROUTER_API_KEY=TESTKEY_123/)
    assert.match(readFileSync(orFile, 'utf8'), /FACTORY_LLM_PROVIDER=openrouter/)

    // 9. REMOTE tunnel via /connect routes through the local proxy, never
    //    direct (2026-10-31 live-run fix): baseURL is the proxy, the tunnel
    //    URL is only the upstream. Injected fetch answers the proxy's
    //    /models and /chat/completions, so no real listener is started.
    const tunnelFetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder-3b-instruct' }] }), { status: 200 })
      }
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 })
      }
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    const tunFile = join(dir, 'tunnel.env')
    const tunUi = scriptedUi(['https://tunnel.example/v1', 'y'], 'ngrok')
    const tun = await connectFlow(tunUi, { path: tunFile, fetchImpl: tunnelFetch, timeoutMs: 2000 })
    assert.equal(tun.ok, true, JSON.stringify(tunUi.errors))
    const tunWritten = readFileSync(tunFile, 'utf8')
    assert.match(tunWritten, /LOCAL_LLM_BASE_URL=http:\/\/127\.0\.0\.1:18090\/v1/)
    assert.match(tunWritten, /LOCAL_TOOL_PROXY_UPSTREAM=https:\/\/tunnel\.example\/v1/)
    assert.doesNotMatch(tunWritten, /LOCAL_LLM_BASE_URL=https:\/\/tunnel\.example/)
    assert.equal(process.env.LOCAL_LLM_BASE_URL, 'http://127.0.0.1:18090/v1')
    assert.equal(process.env.LOCAL_TOOL_PROXY_UPSTREAM, 'https://tunnel.example/v1')

    // 10. Dead upstream behind a live tunnel edge: /models answers but the
    //     chat probe fails -> refuse, name the reason, save nothing (answer n).
    const deadChatFetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder-3b-instruct' }] }), { status: 200 })
      }
      return new Response('upstream gone', { status: 503 })
    }) as typeof fetch
    const deadChatFile = join(dir, 'dead.env')
    const deadChatUi = scriptedUi(['https://tunnel.example/v1', 'n', 'n'], 'cloudflare')
    const deadChat = await connectFlow(deadChatUi, { path: deadChatFile, fetchImpl: deadChatFetch, timeoutMs: 2000 })
    assert.equal(deadChat.ok, false)
    assert.ok(deadChatUi.errors.some(text => /chat turn failed/.test(text)), JSON.stringify(deadChatUi.errors))
    assert.throws(() => readFileSync(deadChatFile, 'utf8'))
  } finally {
    restoreEnv(saved)
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('CONNECT TEST: PASS')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

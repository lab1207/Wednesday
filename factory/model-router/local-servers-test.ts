/**
 * Offline test for local server discovery: the candidate list (vLLM
 * included), model listing against a loopback stub, and the dead-port path
 * (no answer, no hang). No external network.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  discoverLocalServers,
  listLocalModels,
  localServerCandidates,
  probeLocalServer,
  type LocalServerCandidate,
} from './local-servers'

/** A port that is guaranteed closed: bind one, then let it go. */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function main(): Promise<void> {
  // 1. The candidate list: the five pre-existing ports PLUS vLLM, which
  //    the README and the website claim is auto-detected.
  const candidates = localServerCandidates()
  const bases = candidates.map(candidate => candidate.baseURL)
  assert.ok(bases.includes('http://127.0.0.1:11434/v1'), 'Ollama candidate')
  assert.ok(bases.includes('http://127.0.0.1:1234/v1'), 'LM Studio candidate')
  assert.ok(bases.includes('http://127.0.0.1:8080/v1'), 'llama.cpp candidate')
  assert.ok(bases.includes('http://127.0.0.1:1337/v1'), 'generic candidate')
  assert.ok(bases.includes('http://127.0.0.1:18090/v1'), 'wednesday proxy candidate')
  assert.ok(bases.includes('http://127.0.0.1:8000/v1'), 'vLLM candidate')
  const vllm = candidates.find(candidate => candidate.runtime === 'vllm')
  assert.equal(vllm?.baseURL, 'http://127.0.0.1:8000/v1')
  const ollama = candidates.find(candidate => candidate.runtime === 'ollama')
  assert.deepEqual(ollama?.extraPaths, ['/api/tags'])

  // 2. A loopback stub server that speaks both list shapes.
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.endsWith('/api/tags')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'ollama-native:7b' }] }))
      return
    }
    if (url.endsWith('/models')) {
      const empty = url.includes('/empty/')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          data: empty ? [] : [{ id: 'stub-model-a' }, { id: 'stub-model-b' }],
        }),
      )
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${String(port)}/full/v1`

  try {
    // 3. The model list comes from GET {base}/models -> data[].id.
    const models = await listLocalModels(base)
    assert.deepEqual(models, ['stub-model-a', 'stub-model-b'])

    // 4. Empty /models falls back to Ollama's native /api/tags -> models[].name.
    const native = await listLocalModels(`http://127.0.0.1:${String(port)}/empty/v1`)
    assert.deepEqual(native, ['ollama-native:7b'])

    // 5. A live server probes ok and reports its models.
    const stubCandidate: LocalServerCandidate = {
      baseURL: base,
      label: 'stub',
      runtime: 'generic',
    }
    const probed = await probeLocalServer(stubCandidate, 2000)
    assert.equal(probed.ok, true)
    assert.deepEqual(probed.models, ['stub-model-a', 'stub-model-b'])

    // 6. A dead port answers nothing, does not throw, and does not hang.
    const deadBase = `http://127.0.0.1:${String(await deadPort())}/v1`
    const started = Date.now()
    const deadModels = await listLocalModels(deadBase, 1000)
    assert.deepEqual(deadModels, [])
    const deadProbe = await probeLocalServer(
      { baseURL: deadBase, label: 'dead', runtime: 'generic' },
      1000,
    )
    const elapsed = Date.now() - started
    assert.equal(deadProbe.ok, false)
    assert.ok(deadProbe.error && deadProbe.error.length > 0, 'a dead port must say why')
    assert.deepEqual(deadProbe.models, [])
    assert.ok(elapsed < 3000, `the dead-port probe must not hang (took ${String(elapsed)}ms)`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  // 7. Discovery returns every candidate (live and dead), ok ones first.
  const discovered = await discoverLocalServers(400)
  assert.equal(discovered.length, candidates.length)
  const lastOk = discovered.map(server => server.ok).lastIndexOf(true)
  const firstNotOk = discovered.findIndex(server => !server.ok)
  assert.ok(
    firstNotOk === -1 || lastOk < firstNotOk,
    'the servers that answered must come first',
  )
  for (const server of discovered) {
    assert.ok(Array.isArray(server.models))
    assert.ok(typeof server.ok === 'boolean')
    assert.ok(typeof server.runtime === 'string')
  }

  console.log('local-servers: PASS')
}
main().catch((err) => { console.error(err); process.exit(1) })

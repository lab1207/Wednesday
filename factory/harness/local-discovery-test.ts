/**
 * Offline tests for local model discovery: a loopback OpenAI-shaped server
 * stands in for Ollama/LM Studio, and dead ports must cost one timeout, not
 * hang the scan. No real model call, no spend.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { detectLocalServers, defaultLocalCandidates, type LocalCandidate } from './local-discovery'

async function withModelsServer(
  handler: (path: string) => [number, string] | null,
): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((req, res) => {
    const found = handler(req.url ?? '/')
    if (!found) {
      res.writeHead(404).end('nope')
      return
    }
    const [status, body] = found
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${port}/v1` }
}

async function main(): Promise<void> {
  // 1. OpenAI shape: data[].id
  {
    const { server, baseURL } = await withModelsServer(path =>
      path === '/v1/models' ? [200, JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'llama3.1:8b' }] })] : null)
    try {
      const candidates: LocalCandidate[] = [{ baseURL, label: 'test server' }]
      const found = await detectLocalServers(1500, fetch, candidates)
      assert.equal(found.length, 1)
      assert.deepEqual(found[0]!.models.sort(), ['llama3.1:8b', 'qwen3-8b'])
      assert.equal(found[0]!.baseURL, baseURL)
    } finally {
      server.close()
    }
  }

  // 2. Ollama shape: /api/tags with models[].name, reached via the extra path
  {
    const { server, baseURL } = await withModelsServer(path =>
      path === '/v1/api/tags' ? [200, JSON.stringify({ models: [{ name: 'mistral:7b' }] })] : null)
    try {
      const candidates: LocalCandidate[] = [{ baseURL, label: 'ollama-shaped', extraPaths: ['/api/tags'] }]
      const found = await detectLocalServers(1500, fetch, candidates)
      assert.equal(found.length, 1)
      assert.deepEqual(found[0]!.models, ['mistral:7b'])
    } finally {
      server.close()
    }
  }

  // 3. Dead port + 404-only server are excluded; the scan stays ~timeout, not N x timeout
  {
    const started = Date.now()
    const dead: LocalCandidate[] = [
      { baseURL: 'http://127.0.0.1:1/v1', label: 'dead' }, // nothing listens here
      { baseURL: 'http://127.0.0.1:2/v1', label: 'dead too' },
    ]
    const found = await detectLocalServers(400, fetch, dead)
    assert.deepEqual(found, [])
    assert.ok(Date.now() - started < 2000, 'parallel scan, not serial timeouts')
  }

  // 4. Default candidates are the known loopback ports.
  //
  //    vLLM (:8000) was added on 2026-11-05 because the README and the site
  //    CLAIMED vLLM auto-detection while the harness scan did not probe it —
  //    the model layer knew the port, the harness did not. The claim is now
  //    true in the code, and this test is what keeps it true: if the port
  //    is ever dropped again, the published copy is a lie and this fails.
  {
    const candidates = defaultLocalCandidates()
    assert.equal(candidates.length, 6)
    assert.ok(candidates.some(c => c.baseURL.includes('11434')), 'ollama port included')
    assert.ok(candidates.some(c => c.baseURL.includes('1234')), 'lm studio port included')
    assert.ok(candidates.some(c => c.baseURL.includes('8080')), 'llama.cpp port included')
    assert.ok(candidates.some(c => c.baseURL.includes('8000')), 'vLLM port included')
    assert.ok(candidates.some(c => c.baseURL.includes('1337')), 'generic local port included')
    assert.ok(candidates.some(c => c.baseURL.includes('18090')), 'wednesday proxy port included')
  }

  console.log('LOCAL DISCOVERY TEST: PASS (openai shape, ollama shape, dead ports excluded in parallel, default candidates incl. vLLM :8000)')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

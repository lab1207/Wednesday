import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createModelRouter } from './create-router'
import { ZenProvider } from './providers/zen'
import { estimateCostUsd, usageSnapshot } from './usage'

/**
 * Offline proof of the OpenCode Zen route: `FACTORY_LLM_PROVIDER=zen`
 * selects the Zen provider speaking OpenAI chat-completions to the
 * configured endpoint, recording tokens with unknown (null) USD cost.
 * No key ever enters the repo - the test uses a placeholder.
 */

function sseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

async function main(): Promise<void> {
  const captured: Array<{ url: string; authorization: string | undefined }> = []

  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => {
      raw += String(chunk)
    })
    request.on('end', () => {
      captured.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
      })
      const body = JSON.parse(raw || '{}') as { model?: string }
      assert.equal(body.model, 'test-zen-model')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        sseLine({
          choices: [{ index: 0, delta: { content: 'ZEN_' }, finish_reason: null }],
        }),
      )
      response.write(
        sseLine({
          choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
        }),
      )
      response.write(
        sseLine({
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      )
      response.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port

  process.env.FACTORY_LLM_PROVIDER = 'zen'
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.ZEN_MODEL = 'test-zen-model'
  process.env.ZEN_API_KEY = 'test-zen-key'

  try {
    const provider = new ZenProvider()
    assert.deepEqual(await provider.listModels(), ['test-zen-model'])
    assert.equal(await provider.complete('test-zen-model', 'hello'), 'ZEN_OK')
    assert.equal(captured[0]?.url, '/v1/chat/completions')
    assert.equal(captured[0]?.authorization, 'Bearer test-zen-key')

    const router = createModelRouter({
      FACTORY_LLM_PROVIDER: 'zen',
    } as NodeJS.ProcessEnv)
    const route = await router.select({ capability: 'coding' })
    assert.deepEqual(route, { provider: 'zen', model: 'test-zen-model' })

    const recorded = usageSnapshot().find(
      record => record.provider === 'zen' && record.model === 'test-zen-model',
    )
    assert.ok(recorded, 'zen usage must be recorded')
    assert.equal(recorded.promptTokens, 5)
    assert.equal(
      estimateCostUsd(recorded),
      null,
      'zen cost stays unknown until pricing is pinned',
    )

    // Missing key must fail loud, never silent.
    delete process.env.ZEN_API_KEY
    await assert.rejects(provider.complete('test-zen-model', 'hi'), /ZEN_API_KEY/)

    console.log('ZEN ROUTE TEST: PASS')
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
    delete process.env.FACTORY_LLM_PROVIDER
    delete process.env.ZEN_BASE_URL
    delete process.env.ZEN_MODEL
    delete process.env.ZEN_API_KEY
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

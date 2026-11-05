import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createModelRouter } from './create-router'
import { checkLocalUpstream, LocalProvider } from './providers/local'
import { estimateCostUsd, usageSnapshot } from './usage'

/**
 * Offline proof of the opt-in local route: `FACTORY_LLM_PROVIDER=local` must
 * select the local provider and speak OpenAI chat-completions to the
 * configured endpoint, recording tokens with zero USD cost.
 */

interface CapturedRequest {
  url: string
  authorization: string | undefined
  body: {
    model?: string
    messages?: Array<{ role?: string; content?: string }>
    stream?: boolean
  }
}

function sseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

async function main(): Promise<void> {
  const captured: CapturedRequest[] = []

  const server = createServer((request, response) => {
    let raw = ''

    request.on('data', chunk => {
      raw += String(chunk)
    })

    request.on('end', () => {
      captured.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(raw || '{}') as CapturedRequest['body'],
      })

      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const id = 'cmpl-local-test'
      response.write(
        sseLine({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-local-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'LOCAL_' },
              finish_reason: null,
            },
          ],
        }),
      )
      response.write(
        sseLine({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-local-model',
          choices: [
            { index: 0, delta: { content: 'OK' }, finish_reason: null },
          ],
        }),
      )
      response.write(
        sseLine({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-local-model',
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      )
      response.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const port = (server.address() as AddressInfo).port

  process.env.FACTORY_LLM_PROVIDER = 'local'
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.LOCAL_LLM_MODEL = 'test-local-model'
  process.env.LOCAL_LLM_API_KEY = 'test-local-key'

  try {
    const provider = new LocalProvider()
    assert.deepEqual(await provider.listModels(), ['test-local-model'])
    assert.equal(await provider.complete('test-local-model', 'hello'), 'LOCAL_OK')

    assert.equal(captured[0]?.url, '/v1/chat/completions')
    assert.equal(captured[0]?.authorization, 'Bearer test-local-key')
    assert.equal(captured[0]?.body.model, 'test-local-model')
    assert.equal(captured[0]?.body.messages?.[0]?.content, 'hello')
    assert.equal(captured[0]?.body.stream, true)

    const router = createModelRouter({
      FACTORY_LLM_PROVIDER: 'local',
      LOCAL_LLM_MODEL: 'test-local-model',
    } as NodeJS.ProcessEnv)

    const route = await router.select({ capability: 'coding' })
    assert.deepEqual(route, { provider: 'local', model: 'test-local-model' })

    const completion = await router.complete({}, 'hello again')
    assert.equal(completion.text, 'LOCAL_OK')

    const recorded = usageSnapshot().find(
      record => record.provider === 'local' && record.model === 'test-local-model',
    )
    assert.ok(recorded, 'local usage must be recorded')
    // Two calls: the direct provider call and the router call.
    assert.equal(recorded.calls, 2)
    assert.equal(recorded.promptTokens, 14)
    assert.equal(recorded.completionTokens, 6)
    assert.equal(estimateCostUsd(recorded), 0)

    console.log('LOCAL MODEL ROUTE TEST: PASS')

    // Non-streaming servers (Colab FastAPI trio 2026-09-27 answers plain
    // JSON despite `stream: true`) must complete identically: message
    // content returned, usage recorded, zero cost.
    {
      const jsonServer = createServer((request, response) => {
        let raw = ''
        request.on('data', chunk => {
          raw += String(chunk)
        })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              id: 'cmpl-json-test',
              object: 'chat.completion',
              model: 'test-json-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'JSON_OK' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
          )
        })
      })

      await new Promise<void>(resolve => {
        jsonServer.listen(0, '127.0.0.1', resolve)
      })

      const jsonPort = (jsonServer.address() as AddressInfo).port
      process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${jsonPort}/v1`
      process.env.LOCAL_LLM_MODEL = 'test-json-model'

      try {
        const jsonProvider = new LocalProvider()
        assert.equal(
          await jsonProvider.complete('test-json-model', 'hello'),
          'JSON_OK',
        )
        const recordedJson = usageSnapshot().find(
          record =>
            record.provider === 'local' && record.model === 'test-json-model',
        )
        assert.ok(recordedJson, 'non-streaming usage must be recorded')
        assert.equal(recordedJson.calls, 1)
        assert.equal(recordedJson.promptTokens, 5)
        assert.equal(recordedJson.completionTokens, 2)
        assert.equal(estimateCostUsd(recordedJson), 0)
        console.log('LOCAL NON-STREAMING RESPONSE TEST: PASS')
      } finally {
        await new Promise<void>(resolve => {
          jsonServer.close(() => resolve())
        })
      }
    }

    // Layer audit 2026-09-21: TCP preflight fails fast on dead routes and
    // passes on live ones (proves nothing about the model itself).
    {
      const live = await checkLocalUpstream(`http://127.0.0.1:${port}/v1`, 5000)
      assert.equal(live.ok, true, 'loopback test server must be reachable')
      assert.ok((live.latencyMs ?? 9999) < 5000, 'handshake must be fast')
      const dead = await checkLocalUpstream('http://127.0.0.1:1/v1', 2000)
      assert.equal(dead.ok, false, 'closed port must fail fast')
      assert.ok((dead.error ?? '').length > 0, 'failure must say where')
      const broken = await checkLocalUpstream('::::not-a-url', 2000)
      assert.equal(broken.ok, false, 'unparseable base URL must fail')
      console.log('LOCAL UPSTREAM PREFLIGHT TEST: PASS')
    }
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })

    delete process.env.FACTORY_LLM_PROVIDER
    delete process.env.LOCAL_LLM_BASE_URL
    delete process.env.LOCAL_LLM_MODEL
    delete process.env.LOCAL_LLM_API_KEY
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

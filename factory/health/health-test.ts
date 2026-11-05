/**
 * Offline test for the health meter. Loopback servers and closed ports
 * prove tunnel verdicts; fake probes prove aggregation, timeouts, and
 * never-throw; temp files prove history roundtrip + trim. Config/spend
 * probes assert shape only. No keys, no spend, no model calls.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configProbe,
  eventBusProbe,
  floorProbe,
  knowledgeProbe,
  layaProbe,
  proxyProbe,
  readHealthHistory,
  recordHealthReport,
  renderHealthReport,
  routeProbe,
  runHealthChecks,
  spendProbe,
  tcpReachable,
  tunnelProbe,
} from './health'
import type { HealthReport } from './health'

async function main(): Promise<void> {
  // 1. TCP: loopback ok with latency, closed port down fast.
  const server = createServer((_, res) => {
    res.writeHead(200)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const live = await tcpReachable('127.0.0.1', port, 2000)
  assert.equal(live.ok, true)
  assert.ok((live.latencyMs ?? 9999) < 2000)
  const dead = await tcpReachable('127.0.0.1', 1, 1000)
  assert.equal(dead.ok, false)
  assert.ok((dead.error ?? '').length > 0)

  // 2. Route: local needs no key; keyed routes degrade without one.
  assert.deepEqual(routeProbe({ FACTORY_LLM_PROVIDER: 'local' }), {
    status: 'ok',
    detail: 'route=local · no key needed',
  })
  assert.equal(routeProbe({ FACTORY_LLM_PROVIDER: 'nvidia' }).status, 'degraded')
  assert.equal(
    routeProbe({ FACTORY_LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'x' }).status,
    'ok',
  )

  // 3. Tunnels: live loopback ok; dead port down; non-local routes skip.
  assert.equal(
    (
      await tunnelProbe({
        FACTORY_LLM_PROVIDER: 'local',
        LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      })
    ).status,
    'ok',
  )
  assert.equal(
    (await tunnelProbe({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1/v1' })).status,
    'down',
  )
  assert.equal((await tunnelProbe({})).status, 'ok')
  await new Promise<void>(resolve => server.close(() => resolve()))

  // 4. Laya: disabled reads ok; enabled + dead reads down (fail-open noted).
  assert.equal((await layaProbe({})).status, 'ok')
  assert.equal(
    (await layaProbe({ FACTORY_LAYA_ENABLED: '1', FACTORY_LAYA_BASE_URL: 'http://127.0.0.1:1' })).status,
    'down',
  )

  // 4b. Proxy: non-local routes skip; local + loopback ok; local + dead down.
  assert.equal((await proxyProbe({})).status, 'ok')
  const proxyServer = createServer((_, res) => {
    res.writeHead(200)
    res.end()
  })
  await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxyServer.address() as AddressInfo).port
  assert.equal(
    (
      await proxyProbe({
        FACTORY_LLM_PROVIDER: 'local',
        LOCAL_TOOL_PROXY_PORT: String(proxyPort),
      })
    ).status,
    'ok',
  )
  await new Promise<void>(resolve => proxyServer.close(() => resolve()))
  assert.equal(
    (await proxyProbe({ FACTORY_LLM_PROVIDER: 'local', LOCAL_TOOL_PROXY_PORT: '1' })).status,
    'down',
  )

  // 4c. Knowledge: every adapter lists, every card loads.
  const knowledge = await knowledgeProbe()
  assert.equal(knowledge.status, 'ok')
  assert.ok(knowledge.detail.includes('cards load across 13 adapters'), knowledge.detail)

  // 5. Local-only probes return shape (ok/down depends on this machine).
  for (const probe of [floorProbe(), eventBusProbe(), configProbe({}), spendProbe()]) {
    assert.ok(probe.status === 'ok' || probe.status === 'degraded' || probe.status === 'down')
    assert.ok(probe.detail.length > 0)
  }

  // 6. Aggregate: worst wins; crashers and hangers become down, never throw.
  const report = await runHealthChecks(
    [
      { id: 'a', label: 'A', run: async () => ({ status: 'ok' as const, detail: 'fine' }) },
      { id: 'b', label: 'B', run: async () => ({ status: 'degraded' as const, detail: 'shaky' }) },
      {
        id: 'c',
        label: 'C',
        run: async () => {
          throw new Error('boom')
        },
      },
      { id: 'd', label: 'D', run: () => new Promise(() => {}) },
    ],
    50,
  )
  assert.equal(report.overall, 'down')
  assert.deepEqual(
    report.checks.map(check => check.status),
    ['ok', 'degraded', 'down', 'down'],
  )

  // 7. Render: lamps + labels, ASCII only.
  const text = renderHealthReport(report)
  assert.ok(text.includes('factory health: DOWN'))
  assert.ok(text.includes('[OK] A: fine'))
  assert.ok(text.includes('[DOWN] C: probe crashed: boom'))

  // 8. History: roundtrip, order, trim.
  const dir = mkdtempSync(join(tmpdir(), 'wed-health-'))
  try {
    const file = join(dir, 'health.jsonl')
    for (let index = 0; index < 7; index += 1) {
      recordHealthReport(
        { at: `2026-09-24T00:00:0${index}Z`, overall: index % 2 === 0 ? 'ok' : 'down', checks: [] },
        file,
        5,
      )
    }
    const back = readHealthHistory(file, 5)
    assert.equal(back.length, 5)
    assert.equal(back[0].at, '2026-09-24T00:00:02Z')
    assert.equal(back[4].overall, 'ok')
    assert.deepEqual(readHealthHistory(join(dir, 'missing.jsonl')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 9. Full default run completes offline (overall varies by machine).
  const full: HealthReport = await runHealthChecks()
  assert.equal(full.checks.length, 11)
  assert.ok(['ok', 'degraded', 'down'].includes(full.overall))

  console.log('HEALTH METER TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

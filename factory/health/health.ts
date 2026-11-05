/**
 * Factory health meter (2026-09-24) — "is every piece connected?".
 *
 * One cheap probe per subsystem, aggregated to per-piece ok/degraded/down
 * plus one overall lamp, with JSONL history so trends (not just moments)
 * show what is degrading. Advisory ONLY: health never fails a run, every
 * probe fails open with a reason, secrets never enter output (key
 * presence is a boolean, never a value).
 *
 * Auto-wiring rule: every new slice ships its probe next to its code and
 * registers it in defaultProbes() below — the meter grows with the
 * factory instead of rotting. All probes stay offline-safe (tight
 * timeouts, no spend, no model calls).
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DSH_ROOT, EVENTS_PATH, INSTALL_ROOT, STATE_HOME } from '../paths'
import { GstackSkillAdapter } from '../knowledge/gstack-skills'
import { OdesignSkillAdapter } from '../knowledge/odesign-skills'
import { PocockSkillAdapter } from '../knowledge/pocock-skills'
import { RepowiseSkillAdapter } from '../knowledge/repowise-skills'
import { SkillSafetyAdapter } from '../knowledge/skill-safety'
import { OutputDisciplineAdapter } from '../knowledge/output-discipline'
import { UiVerifyAdapter } from '../knowledge/ui-verification'
import { DesignReviewAdapter } from '../knowledge/design-review'
import { SkillEvolutionAdapter } from '../knowledge/skill-evolution'
import { AddyQualityAdapter } from '../knowledge/addy-quality'
import { ImpeccableAdapter } from '../knowledge/impeccable-context'
import { SkillAuthoringAdapter } from '../knowledge/skill-authoring'
import { ArchifyAdapter } from '../knowledge/archify-diagrams'
import { estimateCostUsd, usageSnapshot } from '../model-router/usage'
import { resolveMaxRepairAttempts } from '../orchestrator/orchestrator'
import { resolveExpansionOverride } from '../orchestrator/expansion'
import { resolveRecoveryRounds } from '../orchestrator/recovery'
import { OPENROUTER_MODELS_URL, isFreePoolEnabled } from '../model-router/free-pool'
import { isCrewPoolConfigured, resolveCrewBaseURL, resolveLocalBaseURL } from '../model-router/crew-routing'
import { resolveLayaConfig } from '../agents/laya-decider'

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthCheck {
  id: string
  label: string
  status: HealthStatus
  detail: string
  ms: number
}

export interface HealthReport {
  at: string
  overall: HealthStatus
  checks: HealthCheck[]
}

export interface ProbeResult {
  status: HealthStatus
  detail: string
}

export interface HealthProbe {
  id: string
  label: string
  run: () => Promise<ProbeResult>
}

function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  if (a === 'down' || b === 'down') return 'down'
  if (a === 'degraded' || b === 'degraded') return 'degraded'
  return 'ok'
}

/** TCP handshake with a tight timeout (pure fs-free network, no spend). */
export function tcpReachable(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    const socket = connect({ host, port })
    const finish = (result: { ok: boolean; latencyMs?: number; error?: string }): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - started }))
    socket.once('timeout', () => finish({ ok: false, error: `no handshake in ${timeoutMs}ms` }))
    socket.once('error', (error: Error) => finish({ ok: false, error: error.message }))
  })
}

function splitBaseURL(baseURL: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(baseURL)
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    }
  } catch {
    return null
  }
}

function keyPresent(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[name] ?? '').trim().length > 0
}

/** Selected route + credential presence (booleans only, never values). */
export function routeProbe(env: NodeJS.ProcessEnv = process.env): ProbeResult {
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || 'openrouter'
  if (provider === 'local') {
    // "local" is the generic OpenAI-compatible route: a loopback box needs no
    // key, but a HOSTED endpoint (DeepSeek/Groq/Together/vLLM behind a tunnel)
    // does, and reporting "no key needed" for those was a green light for a
    // route that answers 401 (2026-11-01, operator: any provider must work).
    const base = (env.LOCAL_LLM_BASE_URL ?? '').trim()
    const loopback = base === '' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base)
    if (loopback) return { status: 'ok', detail: 'route=local · no key needed' }
    const key = (env.LOCAL_LLM_API_KEY ?? '').trim()
    // The placeholder 'local' is what the loopback route sends; a hosted
    // endpoint would reject it, so it does not count as a key.
    if (key && key !== 'local') return { status: 'ok', detail: `route=local (${base}) · key present` }
    return { status: 'degraded', detail: `route=local (${base}) · key MISSING (LOCAL_LLM_API_KEY unset — hosted endpoints reject the placeholder)` }
  }
  const keyName =
    provider === 'nvidia' ? 'NVIDIA_API_KEY' : provider === 'zen' ? 'ZEN_API_KEY' : 'OPENROUTER_API_KEY'
  if (keyPresent(keyName, env)) {
    return { status: 'ok', detail: `route=${provider} · key present` }
  }
  return { status: 'degraded', detail: `route=${provider} · key MISSING (${keyName} unset — live calls fail, offline still works)` }
}

/**
 * `GET <base>/models` with a tight bound.
 *
 * TCP-only checks lied: a tunnel process can accept a socket and still have a
 * dead upstream, and the local proxy accepts a connection while its Colab
 * target is gone. Asking for the model list is the smallest request that
 * proves the route an actual task will use. No model call, no spend.
 */
export async function httpModelsReachable(
  baseURL: string,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; models: number; latencyMs: number; error?: string }> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/models`, { signal: controller.signal })
    const body = await response.text()
    let models = 0
    try {
      const data = JSON.parse(body) as { data?: unknown[] }
      models = Array.isArray(data.data) ? data.data.length : 0
    } catch {
      // A proxy error page is still an HTTP answer; the status decides.
    }
    const latencyMs = Date.now() - started
    if (!response.ok) return { ok: false, status: response.status, models, latencyMs, error: `HTTP ${response.status}` }
    return { ok: true, status: response.status, models, latencyMs }
  } catch (error) {
    return {
      ok: false,
      models: 0,
      latencyMs: Date.now() - started,
      error: controller.signal.aborted ? `no answer in ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Tunnel reachability for the local route (skipped honestly elsewhere).
 *
 * When the route points at the local proxy, the REAL endpoint is the proxy's
 * upstream — probing `127.0.0.1:18090` only proves the proxy is listening, not
 * that Colab is alive. Crew slots are probed in PARALLEL: the old sequential
 * walk cost up to 8s for four tunnels, which is the dead wait that made
 * `/health` feel frozen.
 */
export async function tunnelProbe(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || 'openrouter'
  if (provider !== 'local') {
    return { status: 'ok', detail: `route=${provider} · no tunnels on this route` }
  }
  const defaultBase = resolveLocalBaseURL(env)
  const upstream = (env.LOCAL_TOOL_PROXY_UPSTREAM ?? '').trim()
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(defaultBase)
  const targets = new Map<string, string>([
    // A proxy route names the tunnel in LOCAL_TOOL_PROXY_UPSTREAM; prefer it
    // so the lamp reflects the endpoint tasks actually reach.
    ['default', loopback && upstream ? upstream : defaultBase],
  ])
  if (isCrewPoolConfigured(env)) {
    targets.set('planner', resolveCrewBaseURL('planner', env))
    targets.set('coder', resolveCrewBaseURL('coder', env))
    targets.set('vision', resolveCrewBaseURL('vision', env))
  }
  const unique = [...new Set(targets.values())]
  const probed = new Map<string, Awaited<ReturnType<typeof httpModelsReachable>>>()
  await Promise.all(unique.map(async base => {
    probed.set(base, await httpModelsReachable(base, 3000))
  }))
  const parts: string[] = []
  let overall: HealthStatus = 'ok'
  for (const [slot, base] of targets) {
    const result = probed.get(base)
    if (!result) { parts.push(`${slot}: bad URL`); overall = worse(overall, 'degraded'); continue }
    if (result.ok) {
      parts.push(`${slot}: HTTP ${result.status} · ${result.models} model${result.models === 1 ? '' : 's'} · ${result.latencyMs}ms`)
    } else {
      parts.push(`${slot}: DOWN (${result.error})`)
      overall = worse(overall, 'down')
    }
  }
  return { status: overall, detail: parts.join(' · ') || 'no tunnels configured' }
}

/** Laya guard service (disabled default reads as ok, not missing). */
export async function layaProbe(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const config = resolveLayaConfig(env)
  if (!config.enabled) {
    return { status: 'ok', detail: 'disabled by default (no server needed)' }
  }
  const target = splitBaseURL(config.baseURL)
  if (!target) {
    return { status: 'degraded', detail: `enabled but bad base URL: ${config.baseURL}` }
  }
  const result = await tcpReachable(target.host, target.port, 2000)
  return result.ok
    ? { status: 'ok', detail: `enabled · server answering in ${result.latencyMs}ms` }
    : { status: 'down', detail: `enabled but server DOWN (${result.error}) — runs continue fail-open` }
}

/** Free-pool catalog (fail-open fallback keeps this advisory). */
export async function freePoolProbe(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  if (!isFreePoolEnabled(env)) {
    return { status: 'ok', detail: 'pool off — configured model serves' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, { signal: controller.signal })
    if (!response.ok) {
      return { status: 'degraded', detail: `catalog HTTP ${response.status} — falls back to configured model` }
    }
    const data = (await response.json()) as { data?: unknown[] }
    const free = Array.isArray(data.data)
      ? data.data.filter(entry => typeof entry === 'object' && entry !== null && String((entry as { id?: unknown }).id ?? '').endsWith(':free')).length
      : 0
    return { status: 'ok', detail: `catalog live · ${free} free models` }
  } catch (error) {
    return {
      status: 'degraded',
      detail: `catalog unreachable (${error instanceof Error ? error.message : String(error)}) — falls back to configured model`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** DSH execution floor present on disk. */
export function floorProbe(): ProbeResult {
  if (!existsSync(DSH_ROOT)) {
    return { status: 'down', detail: `checkout missing at ${DSH_ROOT} — no task can execute` }
  }
  const runtime = join(INSTALL_ROOT, 'factory', 'dsh-worker', 'deploy', 'runtime')
  return {
    status: 'ok',
    detail: `checkout present · provisioned runtime ${existsSync(runtime) ? 'present' : 'absent (provision before live runs)'}`,
  }
}

/** Disk writable (temp probe file, removed immediately). */
export function diskProbe(): ProbeResult {
  const probe = join(tmpdir(), `wed-health-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`)
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return { status: 'ok', detail: 'temp write + delete ok' }
  } catch (error) {
    return { status: 'down', detail: `disk not writable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Event log writable (permission check only — never mutates the log). */
export function eventBusProbe(): ProbeResult {
  try {
    accessSync(dirname(EVENTS_PATH), constants.W_OK)
    return { status: 'ok', detail: `log dir writable (${EVENTS_PATH})` }
  } catch {
    return { status: 'down', detail: `log dir NOT writable (${dirname(EVENTS_PATH)}) — history is blind` }
  }
}

/** Effective configuration readout (informational — always ok). */
export function configProbe(env: NodeJS.ProcessEnv = process.env): ProbeResult {
  const ceiling = resolveMaxRepairAttempts()
  const parts = [
    `repair ceiling ${Number.isFinite(ceiling) ? ceiling : 'unlimited'}`,
    `expansion ${resolveExpansionOverride(env)}`,
    `duel ≤${env.FACTORY_DUEL_WIDTH?.trim() || 'band default 2-3'}`,
    `vote ${env.FACTORY_VOTE_WIDTH?.trim() || '3'}`,
    `recovery ${resolveRecoveryRounds(undefined, env)} rounds`,
    `security scan ${env.FACTORY_SECURITY_SCAN?.trim() || 'on'}`,
    `dep audit ${env.FACTORY_DEP_AUDIT?.trim() || 'off'}`,
    `free pool ${env.FACTORY_FREE_POOL?.trim() || 'on'}`,
    `laya ${env.FACTORY_LAYA_ENABLED?.trim() || 'off'}`,
  ]
  return { status: 'ok', detail: parts.join(' · ') }
}

/** Spend so far (informational — always ok). */
export function spendProbe(): ProbeResult {
  const records = usageSnapshot()
  if (records.length === 0) {
    return { status: 'ok', detail: 'no model usage recorded this session' }
  }
  let tokens = 0
  let cost = 0
  let unknown = false
  for (const record of records) {
    tokens += record.promptTokens + record.completionTokens
    const estimate = estimateCostUsd(record)
    if (estimate === null) unknown = true
    else cost += estimate
  }
  return {
    status: 'ok',
    detail: `${records.length} route(s) · ${tokens} tokens · $${cost.toFixed(4)}${unknown ? ' + unpriced usage' : ''}`,
  }
}

/** Local tool proxy (only the local route needs it listening). */
export async function proxyProbe(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || 'openrouter'
  const port = Number(env.LOCAL_TOOL_PROXY_PORT) || 18090
  if (provider !== 'local') {
    return { status: 'ok', detail: `route=${provider} · proxy only serves the local route` }
  }
  const result = await tcpReachable('127.0.0.1', port, 2000)
  const upstream = (env.LOCAL_TOOL_PROXY_UPSTREAM ?? '').trim()
  const via = upstream ? ` → ${upstream.replace(/\/+$/, '')}` : ''
  return result.ok
    ? { status: 'ok', detail: `listening on 127.0.0.1:${port} (${result.latencyMs}ms)${via}` }
    : { status: 'down', detail: `nothing on 127.0.0.1:${port} (${result.error}) — run /connect to point the route at the tunnel directly, or start the proxy` }
}

/** Knowledge composite material: every ctx-free doctrine adapter lists and every card loads. */
export async function knowledgeProbe(): Promise<ProbeResult> {
  const adapters = [
    new GstackSkillAdapter(),
    new OdesignSkillAdapter(),
    new PocockSkillAdapter(),
    new RepowiseSkillAdapter(),
    new SkillSafetyAdapter(),
    new OutputDisciplineAdapter(),
    new UiVerifyAdapter(),
    new DesignReviewAdapter(),
    new SkillEvolutionAdapter(),
    new AddyQualityAdapter(),
    new ImpeccableAdapter(),
    new SkillAuthoringAdapter(),
    new ArchifyAdapter(),
  ]
  let cards = 0
  const problems: string[] = []
  for (const adapter of adapters) {
    const id = adapter.constructor.name
    try {
      const listed = await adapter.list()
      if (listed.length === 0) {
        problems.push(`${id}: empty catalog`)
        continue
      }
      for (const skill of listed) {
        const loaded = await adapter.load(skill.name)
        if (loaded && loaded.content.length > 0) cards += 1
        else problems.push(`${skill.name}: unloadable`)
      }
    } catch (error) {
      problems.push(`${id}: threw (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (problems.length > 0) {
    return { status: 'degraded', detail: `${cards} cards ok · ${problems.join('; ')}` }
  }
  return { status: 'ok', detail: `${cards} cards load across ${adapters.length} adapters` }
}

/** Every slice registers here — the meter grows with the factory. */
export function defaultProbes(): HealthProbe[] {
  return [
    { id: 'route', label: 'Model route', run: async () => routeProbe() },
    { id: 'tunnels', label: 'Colab tunnels', run: () => tunnelProbe() },
    { id: 'proxy', label: 'Tool proxy', run: () => proxyProbe() },
    { id: 'knowledge', label: 'Knowledge cards', run: () => knowledgeProbe() },
    { id: 'laya', label: 'Laya guard', run: () => layaProbe() },
    { id: 'free-pool', label: 'Free pool', run: () => freePoolProbe() },
    { id: 'floor', label: 'DSH floor', run: async () => floorProbe() },
    { id: 'disk', label: 'Disk', run: async () => diskProbe() },
    { id: 'event-bus', label: 'Event bus', run: async () => eventBusProbe() },
    { id: 'config', label: 'Config', run: async () => configProbe() },
    { id: 'spend', label: 'Spend', run: async () => spendProbe() },
  ]
}

async function runProbe(probe: HealthProbe, timeoutMs: number): Promise<HealthCheck> {
  const started = Date.now()
  const verdict = await Promise.race([
    probe.run().catch((error: unknown) => ({
      status: 'down' as HealthStatus,
      detail: `probe crashed: ${error instanceof Error ? error.message : String(error)}`,
    })),
    new Promise<ProbeResult>((resolve) =>
      setTimeout(() => resolve({ status: 'down', detail: `probe timed out after ${timeoutMs}ms` }), timeoutMs),
    ),
  ])
  return { id: probe.id, label: probe.label, status: verdict.status, detail: verdict.detail, ms: Date.now() - started }
}

/** Run every probe (parallel, bounded, never throws). */
export async function runHealthChecks(
  probes: HealthProbe[] = defaultProbes(),
  perProbeTimeoutMs = 6000,
): Promise<HealthReport> {
  const checks = await Promise.all(probes.map(probe => runProbe(probe, perProbeTimeoutMs)))
  return {
    at: new Date().toISOString(),
    overall: checks.reduce<HealthStatus>((acc, check) => worse(acc, check.status), 'ok'),
    checks,
  }
}

const LAMP: Record<HealthStatus, string> = { ok: 'OK', degraded: 'WARN', down: 'DOWN' }

/** Terminal rendering (ASCII lamps — no glyph assumptions). */
export function renderHealthReport(report: HealthReport): string {
  // Probes run in parallel, so the report's elapsed time is the SLOWEST one.
  // Summing them claimed 1952ms for a 0.7s run, which reads as a stuck app.
  const totalMs = Math.max(0, ...report.checks.map(check => check.ms))
  return [
    `factory health: ${LAMP[report.overall]} (${report.checks.length} checks, ${totalMs}ms)`,
    ...report.checks.map(check => `[${LAMP[check.status]}] ${check.label}: ${check.detail}`),
  ].join('\n')
}

export function healthHistoryPath(): string {
  return join(STATE_HOME, 'health.jsonl')
}

/** Append to history, keeping the last entries (trends, not bloat). */
export function recordHealthReport(report: HealthReport, file = healthHistoryPath(), keep = 200): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let lines: string[] = []
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
    } catch {
      lines = []
    }
    lines.push(JSON.stringify({ at: report.at, overall: report.overall }))
    writeFileSync(file, `${lines.slice(-keep).join('\n')}\n`)
  } catch {
    // History is advisory — a failed write never fails the run.
  }
}

/** Last N overall states, newest last. */
export function readHealthHistory(file = healthHistoryPath(), limit = 5): Array<{ at: string; overall: HealthStatus }> {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(-limit)
      .map(line => JSON.parse(line) as { at: string; overall: HealthStatus })
  } catch {
    return []
  }
}

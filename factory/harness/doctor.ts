/**
 * `wednesday doctor` (2026-10-13): read-only readiness check — is
 * everything a run needs actually here? Never prints key values,
 * never spends, never calls a model. The local reachability probe is
 * injected so tests stay offline (default: real TCP preflight).
 */
import { liveConfigBlocker } from './config'
import { parseModelPool } from '../model-router/model-capabilities'
import { parseModelRegistry, resolveActiveModel } from '../model-router/model-switch'
import { parseModelWeights } from '../model-router/model-weights'
import { checkLocalUpstream } from '../model-router/providers/local'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  probeLocal: (baseURL: string) => Promise<{ ok: boolean; error?: string }> = base =>
    checkLocalUpstream(base || 'http://127.0.0.1:1337/v1'),
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  const blocker = liveConfigBlocker(env)
  checks.push({
    name: 'route gate',
    ok: blocker === null,
    detail: blocker === null ? 'ready — no blocker' : `${blocker.message}. ${blocker.remedy}`,
  })

  const provider = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
  if (provider === 'local') {
    try {
      const base = (env.LOCAL_LLM_BASE_URL ?? '').trim()
      const health = await probeLocal(base)
      checks.push({
        name: 'local endpoint',
        ok: health.ok,
        detail: health.ok ? `reachable (${base || 'default'})` : (health.error ?? 'unreachable'),
      })
    } catch (error) {
      checks.push({
        name: 'local endpoint',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  } else {
    checks.push({ name: 'local endpoint', ok: true, detail: `skipped (route is ${provider || 'openrouter'})` })
  }

  const registry = parseModelRegistry(env)
  const activeName = (env.FACTORY_ACTIVE_MODEL ?? '').trim()
  checks.push({
    name: 'model registry',
    ok: activeName === '' || resolveActiveModel(env, registry) !== null,
    detail:
      activeName === ''
        ? `${registry.length} saved, none active (route defaults apply)`
        : resolveActiveModel(env, registry) !== null
          ? `"${activeName}" resolves (${registry.length} saved)`
          : `"${activeName}" matches nothing saved (${registry.length} saved) — switch or unset`,
  })

  const pool = parseModelPool(env)
  parseModelWeights(env, pool.map(model => model.id))
  checks.push({
    name: 'pool + mixer',
    ok: true,
    detail: pool.length > 0 ? `${pool.length} pooled (weights parsed)` : 'solo (no pool configured)',
  })

  return checks
}

/**
 * Render + overall (pure). Hermes grammar: a heading, a blank line, then one
 * row per check with the verdict in a fixed four-column gutter — `ok  ` and
 * `FAIL` line up, so a failing check is found by scanning one column.
 */
export function renderDoctor(checks: DoctorCheck[]): { text: string; ok: boolean } {
  const ok = checks.every(check => check.ok)
  const lines = ['Wednesday Doctor', '']
  for (const check of checks) {
    lines.push(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}`)
  }
  lines.push('', ok ? 'Doctor: ready' : 'Doctor: fix the FAIL lines above, then re-run')
  return { text: lines.join('\n'), ok }
}

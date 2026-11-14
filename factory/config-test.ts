import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { loadConfig, saveConfig, validateModel, requireLiveConfig, safeError, liveConfigBlocker, configBlockerIn } from './config'

// Synthetic credentials only; no HTTP calls or real profile file writes.
const directory = await mkdtemp(join(tmpdir(), 'factory-config-'))
const original = { ...process.env }
try {
  const path = join(directory, '.env')
  const key = 'synthetic-test-key-not-valid'
  await saveConfig(key, 'example/model', path)
  assert.match(await readFile(path, 'utf8'), /DSH_LLM_MODEL=example\/model/)
  await assert.rejects(saveConfig('another-synthetic-key', 'example/other', path), { code: 'EEXIST' })
  await assert.rejects(saveConfig('invalid\nkey', 'example/model', join(directory, 'invalid.env')))
  assert.throws(() => validateModel('invalid model'))
  // A local route's ids have no provider slash. The old single pattern made
  // `/model qwen2.5-coder-3b-instruct` impossible on the route the palette
  // was displaying.
  assert.doesNotThrow(() => validateModel('qwen2.5-coder-3b-instruct', 'local'))
  assert.doesNotThrow(() => validateModel('org/model', 'local'))
  assert.throws(() => validateModel('qwen2.5-coder-3b-instruct', 'openrouter'))
  assert.throws(() => validateModel('bad model', 'local'))
  // 2026-10-31 provider pins: any route accepts openrouter/ nvidia/ zen/ local/
  assert.doesNotThrow(() => validateModel('nvidia/meta/llama-3.1-8b-instruct', 'local'))
  assert.doesNotThrow(() => validateModel('openrouter/deepseek/deepseek-chat', 'openrouter'))
  assert.doesNotThrow(() => validateModel('local/qwen2.5-coder-3b-instruct'))
  assert.doesNotThrow(() => validateModel('zen/z-model'))
  assert.throws(() => validateModel('openrouter/', 'local'))
  assert.throws(() => validateModel('nvidia/bad model', 'local'))
  await writeFile(path, '\nNODE_OPTIONS=unsafe\nFACTORY_EXECUTION_MODE=deterministic\nFACTORY_EXPANSION=vote\nFACTORY_CREW_CODER_MODEL=test-rig-coder\nNVIDIA_API_KEY=synthetic-nvidia-key\nNVIDIA_LLM_MODEL=nvidia/test-lightning\nNVIDIA_BASE_URL=https://integrate.example/v1\n', { flag: 'a' })
  const env: NodeJS.ProcessEnv = { DSH_LLM_MODEL: 'override/model' }
  await loadConfig(path, env)
  assert.equal(env.OPENROUTER_API_KEY, key)
  assert.equal(env.DSH_LLM_MODEL, 'override/model')
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.FACTORY_EXECUTION_MODE, undefined)
  assert.equal(env.FACTORY_EXPANSION, 'vote')
  assert.equal(env.FACTORY_CREW_CODER_MODEL, 'test-rig-coder')
  // The bug behind the operator's report: ZEN_* was whitelisted and NVIDIA_*
  // was not, so a key saved correctly in the profile was silently DISCARDED and
  // the run said "is not set" with the key sitting unread in the same file.
  assert.equal(env.NVIDIA_API_KEY, 'synthetic-nvidia-key')
  assert.equal(env.NVIDIA_LLM_MODEL, 'nvidia/test-lightning')
  assert.equal(env.NVIDIA_BASE_URL, 'https://integrate.example/v1')
  await loadConfig(join(directory, 'missing.env'), env)
  const legacyEnv: NodeJS.ProcessEnv = {}
  await loadConfig(join(directory, 'new-missing.env'), legacyEnv, path)
  assert.equal(legacyEnv.OPENROUTER_API_KEY, key)
  const newPath = join(directory, 'wednesday.env')
  await saveConfig('new-synthetic-test-key', 'example/new', newPath)
  const preferred: NodeJS.ProcessEnv = {}
  await loadConfig(newPath, preferred, path)
  assert.equal(preferred.DSH_LLM_MODEL, 'example/new')
  assert.equal(preferred.OPENROUTER_API_KEY, 'new-synthetic-test-key')
  process.env.FACTORY_EXECUTION_MODE = 'live'
  delete process.env.OPENROUTER_API_KEY
  assert.throws(requireLiveConfig, /key missing/)
  process.env.OPENROUTER_API_KEY = key
  delete process.env.DSH_LLM_MODEL
  assert.throws(requireLiveConfig, /Choose a model/)
  process.env.DSH_LLM_MODEL = 'example/model'
  requireLiveConfig()
  assert.equal(safeError(new Error(`failure ${key}`)), 'failure [REDACTED]')
  // any secret-shaped env var is scrubbed by value, not just the hardcoded four
  process.env.ACME_API_KEY = 'acme-secret-value-xyz-789'
  process.env.LOCAL_TOOL_PROXY_UPSTREAM = 'https://tunnel-xyz.invalid/v1'
  assert.equal(safeError(new Error('boom acme-secret-value-xyz-789 and https://tunnel-xyz.invalid/v1/x')), 'boom [REDACTED] and [REDACTED]/x')
  process.env.WEDNESDAY_NO_UPDATE_CHECK = '1'
  assert.equal(safeError(new Error('flag=1 stays')), 'flag=1 stays', 'short non-secret values are not mangled')
  delete process.env.ACME_API_KEY
  delete process.env.LOCAL_TOOL_PROXY_UPSTREAM
  delete process.env.WEDNESDAY_NO_UPDATE_CHECK
  process.env.FACTORY_EXECUTION_MODE = 'deterministic'
  delete process.env.OPENROUTER_API_KEY
  requireLiveConfig()

  // ── the gate is ROUTE-AWARE ───────────────────────────────────────────────
  // The reported symptom: `FACTORY_LLM_PROVIDER=nvidia`, no NVIDIA key. The old
  // gate fell through to the OpenRouter branch — it asked for a key the chosen
  // route does not use, and when an unrelated OpenRouter key happened to be set
  // it waved the doomed run straight through the approval card.
  {
    const nvidiaNoKey = { FACTORY_LLM_PROVIDER: 'nvidia' }
    const blocker = liveConfigBlocker(nvidiaNoKey)
    assert.equal(blocker?.kind, 'credential')
    assert.match(blocker!.message, /NVIDIA key missing/)
    assert.ok(!/OpenRouter/.test(blocker!.message), 'it must not ask for the wrong provider')
    assert.match(blocker!.remedy, /NVIDIA_API_KEY/)
    // NVIDIA serves its own proven default model, so demanding DSH_LLM_MODEL
    // here would invent a blocker the operator cannot clear with /model.
    assert.match(blocker!.remedy, /FACTORY_LLM_PROVIDER=local/, 'and offers a way out')
    assert.equal(liveConfigBlocker({ ...nvidiaNoKey, NVIDIA_API_KEY: key }), null, 'with the key the route is ready')
    assert.equal(liveConfigBlocker({ FACTORY_LLM_PROVIDER: 'local' }), null, 'a local route needs no credential')
    assert.match(liveConfigBlocker({ FACTORY_LLM_PROVIDER: 'zen' })!.message, /Zen key missing/)
    assert.match(liveConfigBlocker({})!.message, /OpenRouter key missing/)
    assert.match(liveConfigBlocker({ OPENROUTER_API_KEY: key })!.message, /Choose a model/)
    assert.equal(liveConfigBlocker({ OPENROUTER_API_KEY: key, DSH_LLM_MODEL: 'not a model id' })?.kind, 'model', 'a malformed id is a blocker, not a crash')
    assert.equal(liveConfigBlocker({ FACTORY_EXECUTION_MODE: 'deterministic' }), null, 'deterministic mode never blocks')
  }

  // ── classify a failure that already happened ─────────────────────────────
  {
    // The exact string the operator saw, mid-run, on the screen path.
    const b = configBlockerIn('architect failed: NVIDIA_API_KEY is not set', { FACTORY_LLM_PROVIDER: 'nvidia' })
    assert.equal(b?.kind, 'credential')
    assert.match(b!.message, /NVIDIA key missing/)
    assert.ok(b!.remedy.includes(key) === false, 'the remedy never carries a key value')
    assert.equal(configBlockerIn('NVIDIA request failed: 401 invalid api key', { FACTORY_LLM_PROVIDER: 'nvidia' })?.kind, 'credential')
    assert.match(configBlockerIn('NVIDIA request failed: 401 invalid api key', { FACTORY_LLM_PROVIDER: 'nvidia' })!.message, /NVIDIA rejected the key/)
    assert.equal(configBlockerIn('Local model request failed: fetch failed ECONNREFUSED', { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1337/v1' })?.kind, 'route')
    // The label must come from the FAILURE, not from the environment it ran in:
    // an earlier version re-derived the provider from env and answered "NVIDIA
    // key missing" with an OpenRouter blocker, which is precisely the class of
    // wrong-credential message that sent the operator hunting in the first place.
    assert.match(configBlockerIn('NVIDIA key missing', {})!.message, /NVIDIA key missing/)
    assert.match(configBlockerIn('Zen key missing', { FACTORY_LLM_PROVIDER: 'nvidia' })!.message, /Zen key missing/)
    assert.equal(configBlockerIn('NVIDIA_API_KEY is not set', {})?.kind, 'credential')
    // pi-ai names the key inside a longer sentence (operator's 2026-11-04 run:
    // `its profile resolves LOCAL_LLM_API_KEY, which is not set`). Unclassified,
    // that failure was reported as a failed task and guessed at the tunnel.
    const resolved = configBlockerIn('llm-pi-ai: no credential for provider route "local"; its profile resolves LOCAL_LLM_API_KEY, which is not set', {})
    assert.equal(resolved?.kind, 'credential', 'the ", which is not set" wording is a blocker')
    assert.match(resolved!.message, /LOCAL_LLM_API_KEY|local/, 'and it names the key or provider')
    assert.equal(configBlockerIn('startup refused: ZEN_API_KEY missing', {})?.kind, 'credential', 'the "missing" wording is a blocker too')
    // Fail-safe direction: a genuine code failure must NOT be told to fix a key.
    // A false BLOCKED card is worse than an unclassified one.
    for (const real of [
      'test FAIL: npm test',
      'acceptance FAIL: required file src/index.ts',
      'coder produced invalid JSON',
      'reviewer requested changes: simplify the loop',
      'Blocked by policy: rm -rf refused',
      'upstream 403 policy refusal',
      undefined,
    ]) assert.equal(configBlockerIn(real), null, `must not classify: ${real}`)
  }

  console.log('HARNESS CONFIG TEST: PASS (synthetic key, exclusive save, env precedence, whitelist incl. NVIDIA, rig knobs, route-aware preflight, blocker classification)')
} finally {
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]
  Object.assign(process.env, original)
  await rm(directory, { recursive: true, force: true })
}

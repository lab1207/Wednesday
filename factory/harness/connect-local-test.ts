/**
 * Offline tests for the /connect "local models (auto-detect)" transport and
 * the first-run onboarding flag logic. A loopback server stands in for a
 * local model box; every env write goes to a temp profile.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectFlow, type ConnectUi } from './connect'
import { onboardingNeeded, runOnboarding, markOnboarded, onboardedFlagPath, type OnboardUi } from './onboarding'
import type { LocalCandidate } from './local-discovery'

const TOUCHED = [
  'FACTORY_LLM_PROVIDER', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'DSH_LLM_MODEL',
  'LOCAL_TOOL_PROXY_UPSTREAM',
  'FACTORY_CREW_PLANNER_MODEL', 'FACTORY_CREW_PLANNER_BASE_URL',
  'FACTORY_CREW_CODER_MODEL', 'FACTORY_CREW_CODER_BASE_URL',
  'FACTORY_CREW_VISION_MODEL', 'FACTORY_CREW_VISION_BASE_URL',
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

async function main(): Promise<void> {
  const saved = snapshotEnv()
  const dir = mkdtempSync(join(tmpdir(), 'wed-connect-local-'))
  let server: Server | undefined
  try {
    // Loopback "local model server" with two models so the flow must PICK one.
    server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: [{ id: 'qwen3-4b-local' }, { id: 'mistral-7b-local' }] }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseURL = `http://127.0.0.1:${port}/v1`
    const candidates: LocalCandidate[] = [{ baseURL, label: 'test box' }]
    const profilePath = join(dir, '.env')

    // Scripted UI: transport select → 'local', server select → the test baseURL,
    // model select → 'mistral-7b-local', then the seats answer 'y'.
    const selects: string[] = []
    const asks: string[] = []
    const ui: ConnectUi & { notes: string[]; errors: string[] } = {
      notes: [], errors: [],
      select: async (_title, options) => {
        const pick = options[0]?.value // transport first; server second; model third — see queue below
        return queue.shift() ?? pick
      },
      ask: async prompt => { asks.push(prompt); return 'y' },
      note: text => { ui.notes.push(text) },
      error: text => { ui.errors.push(text) },
      progress: () => {},
    }
    const queue = ['local', baseURL, 'mistral-7b-local']

    const result = await connectFlow(ui, { path: profilePath, candidates, timeoutMs: 3000 })
    assert.equal(result.ok, true, `flow ok (errors: ${ui.errors.join(' | ')})`)
    assert.match(result.receipt ?? '', /mistral-7b-local/)
    assert.equal(process.env.FACTORY_LLM_PROVIDER, 'local')
    assert.equal(process.env.LOCAL_LLM_BASE_URL, baseURL)
    assert.equal(process.env.LOCAL_LLM_MODEL, 'mistral-7b-local')
    assert.equal(process.env.DSH_LLM_MODEL, 'mistral-7b-local')
    assert.equal(process.env.FACTORY_CREW_CODER_MODEL, 'mistral-7b-local', 'all seats got the model')
    const written = readFileSync(profilePath, 'utf8')
    assert.match(written, /LOCAL_LLM_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1/)
    assert.match(written, /LOCAL_LLM_MODEL=mistral-7b-local/)
    assert.ok(selects.length === 0)

    // No server answering → honest failure, nothing written
    const emptyProfile = join(dir, '.env-empty')
    const failUi: ConnectUi & { notes: string[]; errors: string[] } = {
      notes: [], errors: [],
      select: async () => 'local',
      ask: async () => undefined,
      note: t => { failUi.notes.push(t) },
      error: t => { failUi.errors.push(t) },
    }
    const failed = await connectFlow(failUi, {
      path: emptyProfile,
      candidates: [{ baseURL: 'http://127.0.0.1:1/v1', label: 'dead' }],
      timeoutMs: 400,
    })
    assert.equal(failed.ok, false)
    assert.ok(failUi.errors.some(e => /no local model server answered/.test(e)))
    assert.ok(!existsSync(emptyProfile), 'a failed detect writes nothing')
  } finally {
    server?.close()
    restoreEnv(saved)
    rmSync(dir, { recursive: true, force: true })
  }

  // Onboarding flag logic — temp dirs only
  const obDir = mkdtempSync(join(tmpdir(), 'wed-onboard-'))
  try {
    const configPath = join(obDir, '.env')
    const stateDir = join(obDir, 'state')
    const prevNo = process.env.WEDNESDAY_NO_ONBOARDING
    try {
      delete process.env.WEDNESDAY_NO_ONBOARDING
      // fresh machine → needed
      assert.equal(onboardingNeeded({ configPath, stateDir }), true)
      // flag written → not needed
      markOnboarded(stateDir)
      assert.equal(onboardingNeeded({ configPath, stateDir }), false)
      assert.ok(existsSync(onboardedFlagPath(stateDir)))
      // config exists but no flag → marked silently, not needed
      const obDir2 = mkdtempSync(join(tmpdir(), 'wed-onboard2-'))
      try {
        writeFileSync(join(obDir2, '.env'), 'X=1\n')
        assert.equal(onboardingNeeded({ configPath: join(obDir2, '.env'), stateDir: join(obDir2, 'state') }), false)
        assert.ok(existsSync(join(obDir2, 'state', 'onboarded.json')), 'existing config is marked, not re-taught')
      } finally {
        rmSync(obDir2, { recursive: true, force: true })
      }
      // opt-out env → never needed
      process.env.WEDNESDAY_NO_ONBOARDING = '1'
      assert.equal(onboardingNeeded({ configPath, stateDir }), false)
    } finally {
      if (prevNo === undefined) delete process.env.WEDNESDAY_NO_ONBOARDING
      else process.env.WEDNESDAY_NO_ONBOARDING = prevNo
    }

    // runOnboarding with stubbed steps: skip path writes the flag
    const runDir = mkdtempSync(join(tmpdir(), 'wed-onboard3-'))
    try {
      let connected = false
      let teamCreated = false
      const ui: OnboardUi & { notes: string[] } = {
        notes: [],
        note: t => { ui.notes.push(t) },
        error: () => {},
        ask: async () => undefined,
        select: async () => 'skip',
      }
      await runOnboarding(ui, {
        configPath: join(runDir, '.env'),
        stateDir: join(runDir, 'state'),
        connectFlowImpl: async () => { connected = true; return { ok: true, receipt: 'connected · stub' } },
        createTeamImpl: async () => { teamCreated = true },
      })
      assert.ok(connected, 'onboarding runs the real connect step')
      assert.equal(teamCreated, false, 'skip does not create a team')
      assert.ok(existsSync(join(runDir, 'state', 'onboarded.json')), 'flag written after the flow')
      assert.ok(ui.notes.some(n => /onboarding done/.test(n)))
      assert.ok(ui.notes.some(n => /proof skipped/.test(n)), 'a skipped proof is said out loud')

      // proof path: the operator chooses it, and the receipt reaches the UI.
      const runDir5 = mkdtempSync(join(tmpdir(), 'wed-onboard5-'))
      const savedRoute = {
        FACTORY_LLM_PROVIDER: process.env.FACTORY_LLM_PROVIDER,
        DSH_LLM_MODEL: process.env.DSH_LLM_MODEL,
        LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
      }
      try {
        // A route must exist for the proof to be offered; the proof itself is
        // injected, so the base URL is never dialed.
        process.env.FACTORY_LLM_PROVIDER = 'local'
        process.env.DSH_LLM_MODEL = 'stub-model'
        process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:1/v1'
        let proved = false
        const ui5: OnboardUi & { notes: string[] } = {
          notes: [],
          note: t => { ui5.notes.push(t) },
          error: () => {},
          ask: async () => undefined,
          select: async title => title === 'Prove it now?' ? 'run' : 'skip',
        }
        await runOnboarding(ui5, {
          configPath: join(runDir5, '.env'),
          stateDir: join(runDir5, 'state'),
          connectFlowImpl: async () => ({ ok: true, receipt: 'connected · stub' }),
          proveItImpl: async () => {
            proved = true
            return {
              ok: true,
              detail: 'wrote proof.txt and read it back',
              seconds: 0.1,
              provider: 'local',
              model: 'stub-model',
              workspace: runDir5,
              answer: 'WEDNESDAY_PROOF_OK',
            }
          },
        })
        assert.ok(proved, 'choosing the proof runs the injected proof')
        assert.ok(ui5.notes.some(n => /proof PASS/.test(n)), 'the pass receipt reaches the operator')
        assert.ok(ui5.notes.some(n => /artifact:/.test(n)), 'and names the artifact')
      } finally {
        for (const [name, value] of Object.entries(savedRoute)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        rmSync(runDir5, { recursive: true, force: true })
      }

      // team path calls the createTeam impl
      const runDir2 = mkdtempSync(join(tmpdir(), 'wed-onboard4-'))
      try {
        let team = false
        const ui2: OnboardUi = {
          note: () => {}, error: () => {}, ask: async () => undefined,
          select: async () => 'team',
        }
        await runOnboarding(ui2, {
          configPath: join(runDir2, '.env'),
          stateDir: join(runDir2, 'state'),
          connectFlowImpl: async () => ({ ok: false, cancelled: true }),
          createTeamImpl: async () => { team = true },
        })
        assert.ok(team, 'team choice runs the team-creation flow')
      } finally {
        rmSync(runDir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(obDir, { recursive: true, force: true })
  }

  console.log('CONNECT-LOCAL + ONBOARDING TEST: PASS (auto-detect pick→save→apply, dead scan writes nothing, flag logic, solo/team/skip paths, proof receipt)')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

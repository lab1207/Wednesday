/**
 * Offline test for the `/team` COMMAND end to end (not just the parser).
 *
 * The pure grammar is proven in `team-policy-test.ts`; this proves the
 * COMMAND: that the setting is stored with the crew, that it is applied to
 * the env the orchestrator reads, and that `/team reset` really CLEARS it
 * (it could not before — `updateCrew` could not tell "not mentioned" from
 * "explicitly cleared", so the reset wrote the same policy straight back).
 *
 * No network, no model, no spend: the approval gate is never reached.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STATE_HOME is captured at import time, so the env var comes FIRST and the
// modules under test are loaded dynamically.
const stateHome = mkdtempSync(join(tmpdir(), 'wednesday-team-command-'))
process.env.WEDNESDAY_STATE_HOME = join(stateHome, '.wednesday', 'state')

interface Recorded {
  notes: string[]
  errors: string[]
}

async function drive(script: string[]): Promise<Recorded> {
  const { replLoop, parseFlags } = await import('./harness')
  const { PersistentFactoryEventBus } = await import('../events')

  const notes: string[] = []
  const errors: string[] = []
  const queue = [...script]
  const ui = {
    ask: async () => queue.shift(),
    approve: async () => false,
    note: (text: string) => { notes.push(text) },
    error: (text: string) => { errors.push(text) },
    progress: () => {},
    running: () => {},
    block: () => {},
    help: async () => {},
  }
  const bus = new PersistentFactoryEventBus({ filePath: join(stateHome, 'events.jsonl') })
  const defaults = parseFlags(['--workspace', stateHome])
  await replLoop(defaults, bus, ui as never, undefined, undefined)
  return { notes, errors }
}

async function main(): Promise<void> {
  try {
    // 1. A team to configure. The seats are the SIX real roles, and the
    //    models are per-seat.
    const { addCrew, loadCrews, updateCrew } = await import('./crew-store')
    const crew = addCrew(
      'demo-team',
      [
        { role: 'architect', model: 'm-arch' },
        { role: 'planner', model: 'm-plan' },
        { role: 'coder', model: 'm-code' },
        { role: 'tester', model: 'm-test' },
        { role: 'reviewer', model: 'm-review' },
        { role: 'vision', model: 'm-vision' },
      ],
    )
    assert.equal(loadCrews().active, crew.id, 'the new team is the active one')

    // 2. SHOW: the policy, in words, with the seats.
    {
      const rec = await drive(['/team', '/exit'])
      assert.deepEqual(rec.errors, [], 'showing a policy raises nothing')
      assert.ok(
        rec.notes.some(n => /team: demo-team · 6 seats/.test(n)),
        `the team and its seat count are named: ${JSON.stringify(rec.notes)}`,
      )
      assert.ok(
        rec.notes.some(n => /shape: auto/.test(n)),
        'the shape is named',
      )
    }

    // 3. SET: the shape, the caps, the budgets and the verification.
    {
      const rec = await drive([
        '/team shape duel',
        '/team repairs 2',
        '/team tokens 50000',
        '/team usd 0.25',
        '/team test "npm test"',
        '/team files src/a.ts,src/b.ts',
        '/exit',
      ])
      assert.deepEqual(rec.errors, [], 'a valid setting raises nothing')
      const stored = loadCrews().crews.find(c => c.id === crew.id)
      assert.equal(stored?.policy?.shape, 'duel')
      assert.equal(stored?.policy?.maxRepairAttempts, 2)
      assert.equal(stored?.policy?.budgetTokens, 50000)
      assert.equal(stored?.policy?.budgetUsd, 0.25)
      assert.equal(stored?.policy?.testCommand, 'npm test')
      assert.deepEqual(stored?.policy?.requiredFiles, ['src/a.ts', 'src/b.ts'])
    }

    // 4. The policy DRIVES the env the orchestrator reads, so the receipt
    //    and the run agree.
    {
      const rec = await drive(['/team shape duel', '/exit'])
      assert.equal(process.env.FACTORY_EXPANSION, 'duel')
      assert.equal(process.env.FACTORY_RELAY, '0')
      assert.ok(rec.notes.some(n => /shape: duel/.test(n)), 'the receipt says what changed')
    }

    // 5. A REFUSAL never half-applies and never reaches the store.
    {
      const before = loadCrews().crews.find(c => c.id === crew.id)?.policy
      const rec = await drive(['/team shape shpae', '/team repairs -1', '/team tokens 0', '/exit'])
      assert.ok(
        rec.errors.some(e => /Unknown shape/.test(e)),
        'the bad shape is refused by name',
      )
      assert.ok(rec.errors.some(e => /Repairs must be/.test(e)))
      assert.ok(rec.errors.some(e => /Token budget must be/.test(e)))
      const after = loadCrews().crews.find(c => c.id === crew.id)?.policy
      assert.deepEqual(after, before, 'nothing was written')
    }

    // 6. RESET really clears it. This is the case that could not work
    //    before the `updateCrew` fix.
    {
      const rec = await drive(['/team reset', '/exit'])
      assert.deepEqual(rec.errors, [])
      const cleared = loadCrews().crews.find(c => c.id === crew.id)
      assert.equal(cleared?.policy, undefined, 'the policy is gone')
      assert.ok(
        rec.notes.some(n => /policy cleared/.test(n)),
        'the receipt says the policy was cleared',
      )
    }

    // 7. A patch that does not mention the policy leaves it alone.
    {
      updateCrew(crew.id, { policy: { shape: 'vote' } })
      const { updateCrew: patch } = await import('./crew-store')
      const patched = patch(crew.id, { name: 'renamed-team' })
      assert.equal(patched?.name, 'renamed-team')
      assert.equal(patched?.policy?.shape, 'vote', 'the policy survived an unrelated patch')
    }

    // 8. A TEMPLATE is the request AND its verification. Saving only the
    //    prose would replay a request that no longer has the test it was
    //    written for - and a replay that fails for a different reason is a
    //    confusing replay.
    {
      const { loadTemplates } = await import('./task-templates')
      // A ready route, so the request reaches the approval card (the gate
      // REJECTS it - `approve` returns false - so no model is ever called).
      const savedKey = process.env.OPENROUTER_API_KEY
      const savedModel = process.env.DSH_LLM_MODEL
      process.env.OPENROUTER_API_KEY = 'synthetic-team-command-key'
      process.env.DSH_LLM_MODEL = 'example/model'
      try {
        const rec = await drive([
          'add a health check --test "npm test" --required-file src/health.ts',
          '/templates save health',
          '/templates show health',
          '/exit',
        ])
        assert.deepEqual(rec.errors, [], 'saving a template raises nothing')
        const saved = loadTemplates().find(t => t.name === 'health')
        assert.ok(saved, 'the template was stored')
        assert.equal(saved!.request, 'add a health check')
        assert.deepEqual(saved!.flags?.test, ['npm test'], 'the verification travels with the template')
        assert.deepEqual(saved!.flags?.['required-file'], ['src/health.ts'])
        assert.ok(
          rec.notes.some(n => /--test "npm test"/.test(n)),
          'the receipt shows the flags it kept',
        )
      } finally {
        if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY
        else process.env.OPENROUTER_API_KEY = savedKey
        if (savedModel === undefined) delete process.env.DSH_LLM_MODEL
        else process.env.DSH_LLM_MODEL = savedModel
      }
    }

    console.log('team-command: PASS')
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

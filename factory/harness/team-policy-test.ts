/**
 * Offline test for the team's POLICY and the template command helpers:
 * what they accept, what they refuse, and what they write. No network.
 *
 * The policy is the half of "staffing a team" that was missing: the seats
 * said WHO works, and nothing said HOW. Every setting here used to be an
 * env var with no UI, so the operator could staff a team and never tell it
 * how to work.
 */
import assert from 'node:assert/strict'

import {
  CREW_SHAPES,
  applyCrewPolicy,
  crewPolicyLines,
  parseTeamSetting,
  type CrewPolicy,
} from './crew-store'
import { templateFlags, templateSummary } from './templates-command'
import type { TaskTemplate } from './task-templates'

function template(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: 'tpl-1',
    name: 'demo',
    request: 'build the thing',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

async function main(): Promise<void> {
  // 1. The shapes the factory can actually run.
  assert.deepEqual([...CREW_SHAPES], ['auto', 'solo', 'duel', 'vote', 'relay'])

  // 2. A shape parses; a shape that is not a shape is refused BY NAME, with
  //    the accepted values, and never half-applies.
  {
    const good = parseTeamSetting('shape', 'DUEL')
    assert.ok(good.ok)
    assert.equal(good.ok && good.patch.shape, 'duel')
    const bad = parseTeamSetting('shape', 'shpae')
    assert.equal(bad.ok, false)
    assert.ok(!bad.ok && bad.error.includes('Unknown shape'))
    assert.ok(!bad.ok && bad.error.includes('duel'), 'the refusal names the accepted values')
  }

  // 3. The numbers: a repair count, a token budget, a dollar budget.
  {
    const repairs = parseTeamSetting('repairs', '3')
    assert.ok(repairs.ok && repairs.patch.maxRepairAttempts === 3)
    const negative = parseTeamSetting('repairs', '-1')
    assert.equal(negative.ok, false)
    const tokens = parseTeamSetting('tokens', '50000')
    assert.ok(tokens.ok && tokens.patch.budgetTokens === 50000)
    const zeroTokens = parseTeamSetting('tokens', '0')
    assert.equal(zeroTokens.ok, false, 'a zero token budget is a refusal, not a free run')
    const usd = parseTeamSetting('usd', '0.25')
    assert.ok(usd.ok && usd.patch.budgetUsd === 0.25)
    const zeroUsd = parseTeamSetting('usd', '0')
    assert.equal(zeroUsd.ok, false)
  }

  // 4. The verification command and the required files.
  {
    const test = parseTeamSetting('test', 'npm test')
    assert.ok(test.ok && test.patch.testCommand === 'npm test')
    const emptyTest = parseTeamSetting('test', '')
    assert.equal(emptyTest.ok, false)
    const files = parseTeamSetting('files', 'src/a.ts, src/b.ts')
    assert.ok(files.ok)
    assert.deepEqual(files.ok ? files.patch.requiredFiles : [], ['src/a.ts', 'src/b.ts'])
  }

  // 5. An unknown setting is refused by name.
  {
    const unknown = parseTeamSetting('colour', 'blue')
    assert.equal(unknown.ok, false)
    assert.ok(!unknown.ok && unknown.error.includes('Unknown /team setting'))
  }

  // 6. The policy lines say what each value MEANS.
  {
    const policy: CrewPolicy = {
      shape: 'duel',
      maxRepairAttempts: 2,
      budgetTokens: 200000,
      budgetUsd: 0.5,
      testCommand: 'npm test',
      requiredFiles: ['src/a.ts'],
    }
    const lines = crewPolicyLines(policy)
    assert.ok(lines.some(line => line.startsWith('shape: duel')))
    assert.ok(lines.some(line => /repairs: up to 2 rounds/.test(line)))
    assert.ok(lines.some(line => /200,000 tokens/.test(line)))
    assert.ok(lines.some(line => /\$0\.5000/.test(line)))
    assert.ok(lines.some(line => /test: npm test/.test(line)))
    assert.ok(lines.some(line => /required: src\/a\.ts/.test(line)))
  }

  // 7. A policy with nothing set still says one honest line.
  {
    const lines = crewPolicyLines(undefined)
    assert.equal(lines.length, 1)
    assert.ok(/shape: auto/.test(lines[0]!))
  }

  // 8. The policy DRIVES the env the orchestrator reads.
  {
    const saved = { ...process.env }
    try {
      applyCrewPolicy({ shape: 'duel' })
      assert.equal(process.env.FACTORY_EXPANSION, 'duel')
      assert.equal(process.env.FACTORY_RELAY, '0')
      applyCrewPolicy({ shape: 'relay' })
      assert.equal(process.env.FACTORY_RELAY, '1')
      applyCrewPolicy({ shape: 'auto' })
      assert.equal(process.env.FACTORY_EXPANSION, 'auto')
      applyCrewPolicy({ maxRepairAttempts: 4, budgetTokens: 1000, budgetUsd: 0.1 })
      assert.equal(process.env.FACTORY_MAX_REPAIR_ATTEMPTS, '4')
      assert.equal(process.env.FACTORY_BUDGET_TOKENS, '1000')
      assert.equal(process.env.FACTORY_BUDGET_USD, '0.1')
      // A team with NO policy leaves the operator's profile alone.
      const before = process.env.FACTORY_EXPANSION
      applyCrewPolicy(undefined)
      assert.equal(process.env.FACTORY_EXPANSION, before)
    } finally {
      process.env = saved
    }
  }

  // 9. A template's summary is ONE line, trimmed.
  {
    assert.equal(templateSummary(template()), 'build the thing')
    const long = templateSummary(template({ request: 'x'.repeat(200) }))
    assert.equal(long.length, 80)
    assert.ok(long.endsWith('...'))
    const multiline = templateSummary(template({ request: 'one\ntwo   three' }))
    assert.equal(multiline, 'one two three')
  }

  // 10. A template carries its verification, so a replay is the same run.
  {
    const flags = templateFlags(template({ flags: { test: 'npm test', 'required-file': 'a.ts,b.ts' } }))
    assert.deepEqual(flags.tests, ['npm test'])
    assert.deepEqual(flags.requiredFiles, ['a.ts', 'b.ts'])
    const bare = templateFlags(template())
    assert.deepEqual(bare.tests, [])
    assert.deepEqual(bare.requiredFiles, [])
  }

  console.log('team-policy: PASS')
}

main().catch((err) => { console.error(err); process.exit(1) })

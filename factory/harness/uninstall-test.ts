/**
 * Offline tests for /uninstall: the plan is read-only, a declined confirm
 * deletes nothing, an accepted confirm removes exactly the listed paths, and
 * deterministic mode refuses to touch real paths without explicit overrides.
 * All runs use temp dirs — never the operator's real profile.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planUninstall, runUninstall, PACKAGE_REMOVE_CMD, type UninstallUi } from './uninstall'

function makeUi(confirmAnswer: boolean | undefined): UninstallUi & { notes: string[] } {
  const notes: string[] = []
  return {
    notes,
    note: text => { notes.push(text) },
    error: text => { notes.push(`ERR ${text}`) },
    confirm: async () => confirmAnswer ?? false,
    ask: async () => undefined,
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wed-uninstall-'))
  try {
    const configPath = join(dir, '.env')
    const stateHome = join(dir, 'state')
    writeFileSync(configPath, 'OPENROUTER_API_KEY=sk-test-test-test-test\n')
    mkdirSync(join(stateHome, 'sessions'), { recursive: true })
    writeFileSync(join(stateHome, 'sessions', 'x.json'), '{}')

    // 1. Plan is read-only and lists exactly the two paths
    const plan = planUninstall(configPath, stateHome)
    assert.deepEqual(plan.targets.sort(), [configPath, stateHome].sort())

    // 2. Declined confirm deletes nothing
    const declined = await runUninstall(makeUi(false), { configPath, stateHome })
    assert.equal(declined.confirmed, false)
    assert.ok(existsSync(configPath) && existsSync(stateHome), 'declined confirm keeps everything')

    // 3. Accepted confirm removes both, and the receipt names the package command
    const ui = makeUi(true)
    const accepted = await runUninstall(ui, { configPath, stateHome })
    assert.equal(accepted.confirmed, true)
    assert.deepEqual(accepted.removed.sort(), [configPath, stateHome].sort())
    assert.ok(!existsSync(configPath) && !existsSync(stateHome), 'both targets removed')
    assert.ok(ui.notes.some(n => n.includes(PACKAGE_REMOVE_CMD)), 'receipt prints the package removal command')
    assert.ok(ui.notes.some(n => /projects were not touched/.test(n)), 'receipt states projects are untouched')

    // 4. Nothing to remove → friendly no-op
    const empty = await runUninstall(makeUi(true), { configPath, stateHome })
    assert.deepEqual(empty.removed, [])

    // 5. Deterministic mode refuses to touch real paths without explicit overrides
    const prev = process.env.FACTORY_EXECUTION_MODE
    process.env.FACTORY_EXECUTION_MODE = 'deterministic'
    try {
      const guardUi = makeUi(true) // even "yes" must not delete in deterministic mode without paths
      const guarded = await runUninstall(guardUi, {})
      assert.equal(guarded.confirmed, false)
      assert.ok(guardUi.notes.some(n => /deterministic mode/.test(n)))
    } finally {
      if (prev === undefined) delete process.env.FACTORY_EXECUTION_MODE
      else process.env.FACTORY_EXECUTION_MODE = prev
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('UNINSTALL TEST: PASS (plan read-only, decline keeps, accept removes exactly the plan, no-op, deterministic guard)')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

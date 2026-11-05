import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Point state home at a temp dir before importing the module.
const tmp = join(tmpdir(), `display-store-test-${Date.now()}`)
mkdirSync(tmp, { recursive: true })
process.env.WEDNESDAY_STATE_HOME = join(tmp, '.wednesday', 'state')

const { loadDisplay, saveDisplay, isDisplayMode, DISPLAY_MODES } = await import('./display-store')
const stateDir = join(tmp, '.wednesday', 'state')

test('default is normal', () => {
  assert.equal(loadDisplay(), 'normal')
})

test('save then load round-trips', () => {
  saveDisplay('quiet')
  assert.equal(loadDisplay(), 'quiet')
  saveDisplay('verbose')
  assert.equal(loadDisplay(), 'verbose')
})

test('normal is a real mode, not just the fallback', () => {
  saveDisplay('normal')
  assert.equal(loadDisplay(), 'normal')
})

test('unknown mode is rejected by the guard', () => {
  assert.equal(isDisplayMode('quiet'), true)
  assert.equal(isDisplayMode('normal'), true)
  assert.equal(isDisplayMode('verbose'), true)
  assert.equal(isDisplayMode('loud'), false)
  assert.equal(isDisplayMode(''), false)
  assert.deepEqual(DISPLAY_MODES, ['quiet', 'normal', 'verbose'])
})

test('corrupt file falls back to normal', () => {
  writeFileSync(join(stateDir, 'display.json'), '{ not json', 'utf8')
  assert.equal(loadDisplay(), 'normal')
})

test('unknown saved mode falls back to normal', () => {
  writeFileSync(join(stateDir, 'display.json'), JSON.stringify({ mode: 'shout' }), 'utf8')
  assert.equal(loadDisplay(), 'normal')
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})

console.log('DISPLAY STORE TEST: PASS')

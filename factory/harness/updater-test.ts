import assert from 'node:assert/strict'
import { installUpdate, isInstallableVersion, shouldAutoRestart, updateCommandLine, type RunFn } from './updater.js'

// version shape gate
assert.ok(isInstallableVersion('0.2.0'))
assert.ok(isInstallableVersion('0.1.0-dev.9'))
assert.ok(isInstallableVersion('1.0.0-rc.1'))
for (const bad of ['', 'latest', '0.2.0; rm -rf /', '0.2.0 || curl x', '0.2.0\n', 'v0.2.0', '0.2', '0.2.0 ', '`0.2.0`', '@evil/pkg']) {
  assert.equal(isInstallableVersion(bad), false, `must reject ${JSON.stringify(bad)}`)
}
assert.equal(updateCommandLine('0.2.0'), 'npm i -g @lab1207/wednesday@0.2.0')

// auto-restart guard: once per update, never a loop
assert.equal(shouldAutoRestart({}), true)
assert.equal(shouldAutoRestart({ WEDNESDAY_JUST_UPDATED: '1' }), false)

// happy path: pinned spec in the arg array, verify confirms
{
  const calls: Array<{ command: string; args: string[] }> = []
  const run: RunFn = (command, args) => {
    calls.push({ command, args })
    if (args[0] === 'view') return { status: 0, stdout: '0.2.0\n', stderr: '' }
    return { status: 0, stdout: 'added 1 package', stderr: '' }
  }
  const outcome = installUpdate({ version: '0.2.0', run })
  assert.deepEqual(outcome, { ok: true, installed: '0.2.0' })
  assert.deepEqual(calls[0], { command: 'npm', args: ['install', '-g', '@lab1207/wednesday@0.2.0', '--no-fund', '--no-audit'] })
  assert.deepEqual(calls[1], { command: 'npm', args: ['view', '@lab1207/wednesday@0.2.0', 'version'] })
}

// malformed version: run is never invoked
{
  let called = 0
  const run: RunFn = () => { called += 1; return { status: 0, stdout: '', stderr: '' } }
  const outcome = installUpdate({ version: '0.2.0; rm -rf /', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'version')
  assert.equal(called, 0)
}

// npm install fails -> install stage failure with npm's stderr, no throw
{
  const run: RunFn = (command, args) =>
    args[0] === 'view'
      ? { status: 0, stdout: '0.2.0', stderr: '' }
      : { status: 1, stdout: '', stderr: 'EACCES permission denied' }
  const outcome = installUpdate({ version: '0.2.0', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'install')
  assert.match((outcome as { detail: string }).detail, /EACCES/)
}

// install "succeeds" but registry no longer serves the pinned version -> verify fails
{
  const run: RunFn = (command, args) =>
    args[0] === 'view'
      ? { status: 0, stdout: '0.3.0\n', stderr: '' }
      : { status: 0, stdout: 'ok', stderr: '' }
  const outcome = installUpdate({ version: '0.2.0', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'verify')
}

// prerelease pin works end to end
{
  const run: RunFn = (command, args) =>
    args[0] === 'view'
      ? { status: 0, stdout: '0.1.0-dev.9\n', stderr: '' }
      : { status: 0, stdout: 'ok', stderr: '' }
  assert.deepEqual(installUpdate({ version: '0.1.0-dev.9', run }), { ok: true, installed: '0.1.0-dev.9' })
}

console.log('UPDATER TEST: PASS (version gate, pinned spec arg array, install/verify failures, prerelease)')

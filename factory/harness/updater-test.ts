import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findNpmCli,
  npmCommandLine,
  resolveNpm,
  describeNpmFailure,
  type NpmRunResult,
} from './npm-command.js'
import {
  installUpdate,
  isInstallableVersion,
  npmAvailability,
  shouldAutoRestart,
  updateCommandLine,
  type RunFn,
} from './updater.js'

// ---------------------------------------------------------------------------
// The npm invocation: the root of the operator's dead /update (2026-11-09).
//
// "update installed failed: npm exited with signal" -- on Windows, `npm` is
// npm.cmd (a BATCH file) and Node cannot run one without a shell, so the
// spawn died with ENOENT and the old updater printed the literal word
// "signal" instead of the real reason.
// ---------------------------------------------------------------------------

// On THIS machine npm must resolve to something Node can execute without a
// shell. On Windows that means node + npm-cli.js, never `npm` / `npm.cmd`.
{
  const invocation = resolveNpm()
  assert.ok(invocation, 'npm must be resolvable on a machine that has npm')
  assert.notEqual(invocation.command, 'npm.cmd', 'npm.cmd cannot be run without a shell')
  assert.equal(invocation.command, process.execPath, 'npm runs as node + npm-cli.js')
  assert.ok(
    invocation.prefix[0]?.endsWith('npm-cli.js'),
    'the npm CLI entry point is what runs, not the shim',
  )
  assert.ok(existsSync(invocation.prefix[0]!), 'the npm CLI entry point exists')
}

// A Windows host with NO npm-cli.js anywhere must NOT fall back to a bare
// `npm`: that is the call that fails with ENOENT. It must say so instead.
{
  const missing = resolveNpm({ PATH: '' } as NodeJS.ProcessEnv, 'win32', join('C:', 'no-such-node', 'node.exe'))
  assert.equal(missing, null, 'windows without npm-cli.js resolves to nothing, never to a bare npm')
}

// On POSIX a bare `npm` IS an executable, so the fallback is correct there.
{
  const posix = resolveNpm({ PATH: '' } as NodeJS.ProcessEnv, 'linux', join('C:', 'no-such-node', 'node.exe'))
  assert.ok(posix, 'posix keeps the bare npm fallback')
  assert.equal(posix?.command, 'npm')
}

// findNpmCli honours npm_execpath when npm is the one running us.
{
  const real = resolveNpm()?.prefix[0]
  assert.ok(real, 'npm-cli.js was located')
  assert.equal(
    findNpmCli({ npm_execpath: real, PATH: '' } as NodeJS.ProcessEnv, 'linux', 'C:\\nope\\node.exe'),
    real,
    'npm_execpath wins when it points at the CLI entry',
  )
}

// The failure reason must name what ACTUALLY happened.
{
  const neverStarted: NpmRunResult = {
    status: null,
    signal: null,
    failure: { code: 'ENOENT', message: 'spawnSync npm ENOENT' },
    stdout: '',
    stderr: '',
    ok: false,
  }
  const detail = describeNpmFailure(neverStarted)
  assert.match(detail, /ENOENT/, 'a spawn that never started names the OS error')
  assert.doesNotMatch(detail, /exited with signal/, 'the old placeholder word is gone')

  const killed: NpmRunResult = {
    status: null,
    signal: 'SIGTERM',
    failure: undefined,
    stdout: '',
    stderr: '',
    ok: false,
  }
  assert.match(describeNpmFailure(killed), /SIGTERM/, 'a killed process names the signal')

  const npmSaid: NpmRunResult = {
    status: 1,
    signal: null,
    failure: undefined,
    stdout: '',
    stderr: 'EACCES permission denied',
    ok: false,
  }
  assert.match(describeNpmFailure(npmSaid), /EACCES/, "npm's own message is what the operator sees")
}

// ---------------------------------------------------------------------------
// version shape gate
// ---------------------------------------------------------------------------
assert.ok(isInstallableVersion('0.2.0'))
assert.ok(isInstallableVersion('0.1.0-dev.9'))
assert.ok(isInstallableVersion('1.0.0-rc.1'))
for (const bad of ['', 'latest', '0.2.0; rm -rf /', '0.2.0 || curl x', '0.2.0\n', 'v0.2.0', '0.2', '0.2.0 ', '`0.2.0`', '@evil/pkg']) {
  assert.equal(isInstallableVersion(bad), false, `must reject ${JSON.stringify(bad)}`)
}
assert.equal(
  updateCommandLine('0.2.0'),
  'npm i -g @lab1207/wednesday@0.2.0 --foreground-scripts',
  'the manual command pins the exact version and makes the install visible',
)

// auto-restart guard: once per update, never a loop
assert.equal(shouldAutoRestart({}), true)
assert.equal(shouldAutoRestart({ WEDNESDAY_JUST_UPDATED: '1' }), false)

// ---------------------------------------------------------------------------
// installUpdate: the arg array, the progress, and the honest failure
// ---------------------------------------------------------------------------

// happy path: pinned spec in the arg array, verify confirms
{
  const calls: string[][] = []
  const run: RunFn = async (args, hooks) => {
    calls.push(args)
    if (args[0] === 'view') return { status: 0, signal: null, stdout: '0.2.0\n', stderr: '', ok: true }
    // The real runner forwards every line npm prints; the fake does the same
    // so the wiring is what the test is actually about.
    hooks?.onOutput?.('added 1 package')
    return { status: 0, signal: null, stdout: 'added 1 package', stderr: '', ok: true }
  }
  const steps: string[] = []
  const output: string[] = []
  const outcome = await installUpdate({
    version: '0.2.0',
    run,
    progress: { step: text => steps.push(text), output: line => output.push(line) },
  })
  assert.deepEqual(outcome, { ok: true, installed: '0.2.0' })
  assert.deepEqual(calls[0], [
    'install',
    '-g',
    '@lab1207/wednesday@0.2.0',
    '--no-fund',
    '--no-audit',
    '--foreground-scripts',
  ])
  assert.deepEqual(calls[1], ['view', '@lab1207/wednesday@0.2.0', 'version'])
  assert.ok(
    steps.some(s => s.includes('installing @lab1207/wednesday@0.2.0')),
    'the operator is told what is installing BEFORE it starts',
  )
  assert.ok(
    steps.some(s => s.includes('verifying')),
    'the operator is told what happens next',
  )
  assert.deepEqual(output, ['added 1 package'], 'npm\'s own output reaches the operator')
}

// malformed version: run is never invoked
{
  let called = 0
  const run: RunFn = async () => {
    called += 1
    return { status: 0, signal: null, stdout: '', stderr: '', ok: true }
  }
  const outcome = await installUpdate({ version: '0.2.0; rm -rf /', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'version')
  assert.equal(called, 0)
}

// npm install fails -> install stage failure with npm's stderr, no throw
{
  const run: RunFn = async args =>
    args[0] === 'view'
      ? { status: 0, signal: null, stdout: '0.2.0', stderr: '', ok: true }
      : { status: 1, signal: null, stdout: '', stderr: 'EACCES permission denied', ok: false }
  const outcome = await installUpdate({ version: '0.2.0', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'install')
  assert.match((outcome as { detail: string }).detail, /EACCES/)
}

// THE OPERATOR'S EXACT FAILURE (Windows, 2026-11-09): the spawn never
// started. The detail must name that, not a placeholder.
{
  const run: RunFn = async () => ({
    status: null,
    signal: null,
    failure: { code: 'ENOENT', message: 'spawnSync npm ENOENT' },
    stdout: '',
    stderr: '',
    ok: false,
  })
  const outcome = await installUpdate({ version: '0.2.0-beta.5', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'install')
  const detail = (outcome as { detail: string }).detail
  assert.match(detail, /could not be started/, 'the detail says the process never began')
  assert.match(detail, /ENOENT/, 'the detail names the OS error')
  assert.doesNotMatch(detail, /exited with signal/, 'the old placeholder is gone for good')
}

// install "succeeds" but registry no longer serves the pinned version -> verify fails
{
  const run: RunFn = async args =>
    args[0] === 'view'
      ? { status: 0, signal: null, stdout: '0.3.0\n', stderr: '', ok: true }
      : { status: 0, signal: null, stdout: 'ok', stderr: '', ok: true }
  const outcome = await installUpdate({ version: '0.2.0', run })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as { stage: string }).stage, 'verify')
}

// prerelease pin works end to end
{
  const run: RunFn = async args =>
    args[0] === 'view'
      ? { status: 0, signal: null, stdout: '0.1.0-dev.9\n', stderr: '', ok: true }
      : { status: 0, signal: null, stdout: 'ok', stderr: '', ok: true }
  assert.deepEqual(await installUpdate({ version: '0.1.0-dev.9', run }), { ok: true, installed: '0.1.0-dev.9' })
}

// npm availability is answerable BEFORE an install is attempted
{
  const availability = npmAvailability()
  assert.equal(availability.available, true, 'this machine has npm')
  assert.ok(availability.detail.length > 0, 'the operator is told HOW npm was found')
}

// The displayed command line is the real one, not a shell string.
{
  const invocation = resolveNpm()
  const line = npmCommandLine(['install', '-g', '@lab1207/wednesday@0.2.0-beta.5'], invocation)
  assert.match(line, /npm-cli\.js/, 'the displayed command names the real entry point')
}

console.log(
  'UPDATER TEST: PASS (version gate, pinned spec arg array, install/verify failures, real failure reasons, npm resolution, progress)',
)

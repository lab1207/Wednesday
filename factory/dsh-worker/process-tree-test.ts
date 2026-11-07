/**
 * The process-tree kill (2026-11-07).
 *
 * WHY THIS TEST EXISTS (operator report: "the /proof command when run it
 * hangs all wednesday -- the project stops").
 *
 * The proof spawns the DSH host; the host spawns the worker as a CHILD and
 * the worker inherits the host's stderr. Killing the host alone left the
 * worker running and holding the pipe open, so Node's `close` event never
 * fired and the code awaiting it waited forever.
 *
 * The unit fakes used everywhere else were COOPERATIVE: their `kill()`
 * emitted `close` immediately, exactly like a well-behaved process tree. So
 * the suite was green while the real thing hung. This test uses REAL
 * processes and a REAL grandchild, because the defect lived exactly in the
 * gap between the fake and the truth.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point state home at a temp dir before importing the module.
const tmp = join(tmpdir(), `process-tree-test-${Date.now()}`)
const stateHome = mkdtempSync(join(tmpdir(), 'wed-tree-state-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const { groupSpawnOptions, killProcessTree, KILL_GRACE_MS } = await import('./process-tree')

/** Is this pid still running? (signal 0 = existence check, no delivery) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !alive(pid)
}

async function main(): Promise<void> {
  // 1. Group options: POSIX makes the child a group leader; Windows has no
  //    process groups, so the tree is killed with taskkill instead.
  const options = groupSpawnOptions()
  assert.equal(
    options.detached,
    process.platform !== 'win32',
    'the child is a group leader only where groups exist',
  )
  assert.ok(KILL_GRACE_MS >= 500 && KILL_GRACE_MS <= 10_000, 'the grace window is bounded')

  // 2. A child that is already gone must not throw into the caller: the
  //    caller's job is to stop WAITING, not to report a kill failure.
  killProcessTree({ pid: undefined, kill: () => { throw new Error('already gone') } })
  console.log('PROCESS TREE TEST: PASS (group options, dead child tolerated)')

  // 3. THE REAL CASE: a parent that spawns a grandchild. Killing only the
  //    parent leaves the grandchild alive -- which is the bug. The tree kill
  //    must take both.
  const parent = spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
        'console.log(String(child.pid))',
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      ...groupSpawnOptions(),
    },
  )
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('the parent never reported a grandchild pid')), 10_000)
    parent.stdout.setEncoding('utf8')
    parent.stdout.on('data', chunk => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      resolve(Number(buffer.slice(0, newline)))
    })
    parent.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the grandchild pid was reported')
  assert.ok(alive(grandchildPid), 'the grandchild is running before the kill')

  killProcessTree(parent)

  assert.ok(await waitGone(parent.pid ?? 0), 'the host process is gone')
  assert.ok(
    await waitGone(grandchildPid),
    'the GRANDCHILD is gone too -- killing only the host is what froze the app',
  )

  rmSync(tmp, { recursive: true, force: true })
  rmSync(stateHome, { recursive: true, force: true })
  console.log('PROCESS TREE TEST: PASS (real host + real grandchild both die)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

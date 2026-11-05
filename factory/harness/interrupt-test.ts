/**
 * Ctrl+C policy and the fatal guard — the decisions, tested directly.
 *
 * Windows cannot deliver a real SIGINT to a child process (`process.kill` is a
 * hard terminate there), so the DELIVERY of Ctrl+C cannot be tested here. What
 * can be — and what actually broke — is the decision the handler makes once a
 * signal arrives: abort a live run, or leave an idle session. That is this file.
 *
 * The fatal guard is the same shape of policy one level down: a crash that
 * escapes the awaited chain (a timer callback, a floating promise) must restore
 * the terminal before it exits, or it reads as "everything is frozen, not even
 * Ctrl+C" — the 2026-10-16 report.
 *
 *   npx tsx factory/harness/interrupt-test.ts
 */
import assert from 'node:assert/strict'

import { installFatalGuard, installInterrupt } from './interrupt.js'

/** Minimal stand-in for `process` that records listeners and fires them. */
function fakeProcess(): {
  target: Pick<NodeJS.Process, 'on' | 'off'>
  fire: (event?: string, arg?: unknown) => void
  count: (event?: string) => number
} {
  const handlers = new Map<string, Set<(arg?: unknown) => void>>()
  const target = {
    on(event: string, handler: (arg?: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return target as never
    },
    off(event: string, handler: (arg?: unknown) => void) {
      handlers.get(event)?.delete(handler)
      return target as never
    },
  } as unknown as Pick<NodeJS.Process, 'on' | 'off'>
  return {
    target,
    fire: (event = 'SIGINT', arg?: unknown) => { for (const handler of [...(handlers.get(event) ?? [])]) handler(arg) },
    count: (event = 'SIGINT') => handlers.get(event)?.size ?? 0,
  }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  // 1. Idle session: leave with the shell's interrupt code. Installing a handler
  //    turns off Node's default exit, so this branch MUST exit or Ctrl+C at an
  //    idle prompt would silently do nothing. Ctrl+C only reaches SIGINT with
  //    raw mode OFF — precisely the window where nobody is reading keys — so
  //    the exit must hand the terminal back first: the frozen-frame report of
  //    2026-10-16 was this exit path running with the alternate screen up.
  {
    const proc = fakeProcess()
    const order: string[] = []
    installInterrupt({ isRunning: () => false, abort: () => { throw new Error('must not abort when idle') }, restore: () => order.push('restore'), exit: code => { order.push(`exit:${code}`); return undefined as never }, target: proc.target })
    proc.fire()
    assert.deepEqual(order, ['restore', 'exit:130'], 'idle Ctrl+C restores the terminal, then exits 130')
  }

  // 2. Live run: abort it, and do NOT exit — a graceful stop, not process death.
  {
    const proc = fakeProcess()
    const exits: number[] = []
    let restored = 0
    let aborted = 0
    installInterrupt({ isRunning: () => true, abort: () => { aborted += 1 }, restore: () => { restored += 1 }, exit: code => { exits.push(code); return undefined as never }, target: proc.target })
    proc.fire()
    assert.equal(aborted, 1, 'a live run is aborted')
    assert.equal(restored, 0, 'and the terminal stays with the session — the abort is not an exit')
    assert.deepEqual(exits, [], 'and the process is left standing')
  }

  // 3. Repeated Ctrl+C during a run keeps aborting (a second press must not turn
  //    a graceful interrupt into a hard kill), and the run flag is re-read each
  //    time rather than captured.
  {
    const proc = fakeProcess()
    let running = true
    let aborted = 0
    installInterrupt({ isRunning: () => running, abort: () => { aborted += 1 }, exit: () => undefined as never, target: proc.target })
    proc.fire()
    proc.fire()
    assert.equal(aborted, 2, 'each press aborts again')
    running = false // the run finished between presses
    const exits: number[] = []
    installInterrupt({ isRunning: () => running, abort: () => { throw new Error('no abort after the run ended') }, exit: code => { exits.push(code); return undefined as never }, target: proc.target })
    proc.fire()
    assert.deepEqual(exits, [130], 'once the run is over the next press leaves')
  }

  // 4. Unsubscribing really removes the handler: a session that has finished
  //    must not keep a SIGINT listener alive on the process object.
  {
    const proc = fakeProcess()
    const stop = installInterrupt({ isRunning: () => false, abort: () => {}, exit: () => undefined as never, target: proc.target })
    assert.equal(proc.count(), 1, 'installed')
    stop()
    assert.equal(proc.count(), 0, 'stop() removes it, so no listener outlives the session')
  }

  // 5. A custom idle code is honoured (a wrapper embedding the CLI may want a
  //    different convention) and defaults to 130 when omitted.
  {
    const proc = fakeProcess()
    const exits: number[] = []
    installInterrupt({ isRunning: () => false, abort: () => {}, idleExitCode: 7, exit: code => { exits.push(code); return undefined as never }, target: proc.target })
    proc.fire()
    assert.deepEqual(exits, [7], 'the idle exit code is configurable')
  }

  // 6. Fatal guard: order matters. The painting stops, the terminal comes BACK,
  //    the cause is reported, and only THEN does the process leave — because
  //    the operator has to be able to read all of that from a working shell.
  {
    const proc = fakeProcess()
    const order: string[] = []
    const traced: string[] = []
    const exits: number[] = []
    const stop = installFatalGuard({
      quiet: () => order.push('quiet'),
      restore: () => order.push('restore'),
      report: error => order.push(`report:${(error as Error).message}`),
      trace: line => traced.push(line),
      exit: code => { exits.push(code); return undefined as never },
      target: proc.target,
    })
    assert.deepEqual([proc.count('uncaughtException'), proc.count('unhandledRejection')], [1, 1], 'both halves of the guard are installed')
    proc.fire('uncaughtException', new Error('kaboom'))
    assert.deepEqual(order, ['quiet', 'restore', 'report:kaboom'], 'quiet, restore, report — in that order')
    assert.equal(traced.length, 1, 'the fatal is traced when tracing is on')
    assert.ok(traced[0]!.startsWith('fatal ') && traced[0]!.includes('kaboom'), 'trace line names the cause')
    assert.deepEqual(exits, [], 'no immediate exit: the writes must land first')
    // The bail timer is the house pattern from run(): force the exit shortly
    // after, in case a handle is still holding the loop open.
    await wait(550)
    assert.deepEqual(exits, [1], 'the bail timer force-exits with 1')
    stop()
    assert.deepEqual([proc.count('uncaughtException'), proc.count('unhandledRejection')], [0, 0], 'stop() removes both')
  }

  // 7. Unhandled rejections take the same path — a floating promise is the
  //    likeliest crash that bypasses the repl's try/finally.
  {
    const proc = fakeProcess()
    let restored = 0
    let reported: unknown
    installFatalGuard({ restore: () => { restored += 1 }, report: error => { reported = error }, exit: () => undefined as never, target: proc.target })
    proc.fire('unhandledRejection', new Error('floating'))
    assert.equal(restored, 1, 'a floating rejection restores the terminal too')
    assert.equal((reported as Error).message, 'floating', 'and is reported as the cause')
  }

  // 8. A throwing clean-up stage must not mask the crash: restore is best
  //    effort, the report and the exit still happen.
  {
    const proc = fakeProcess()
    let reported = 0
    const exits: number[] = []
    installFatalGuard({
      quiet: () => { throw new Error('quiet blew up') },
      restore: () => { throw new Error('restore blew up') },
      report: () => { reported += 1 },
      exit: code => { exits.push(code); return undefined as never },
      target: proc.target,
    })
    proc.fire('uncaughtException', new Error('x'))
    assert.equal(reported, 1, 'the report survives a throwing quiet/restore')
    await wait(550)
    assert.deepEqual(exits, [1], 'and the exit is still forced')
  }

  console.log('INTERRUPT TEST: PASS (idle restores then exits 130, live run aborts without restoring, stop() unsubscribes, fatal guard restores-before-exit, code is configurable)')
}

void main().catch(error => {
  console.error('FAIL', error)
  process.exit(1)
})

/**
 * Ctrl+C policy, in one testable place.
 *
 * The screen path is in raw mode and interrupts with Esc, so this is the CLASSIC
 * / piped path's whole interrupt story, and it used to have none: Ctrl+C during
 * a live run was SIGINT death while the screen path aborted cleanly — the same
 * product with two different failure modes.
 *
 * The subtlety worth naming: installing a SIGINT handler DISABLES Node's default
 * exit-on-SIGINT. So the idle case has to exit explicitly, or Ctrl+C at an idle
 * prompt would do nothing at all — a worse bug than the one being fixed. 130 is
 * the shell convention for "interrupted" (128 + SIGINT).
 *
 * Extracted from `replLoop` so the policy can be tested directly: Windows cannot
 * deliver a real SIGINT to a child process, so an end-to-end test of the
 * delivery is impossible there — but the DECISION given a signal is pure, and
 * that is what this covers.
 */

export interface InterruptDeps {
  /** True while a task run is live. */
  isRunning: () => boolean
  /** Abort the live run. Must be safe to call when nothing is running. */
  abort: () => void
  /** Exit code used when nothing is running (default 130). */
  idleExitCode?: number
  /**
   * Run before the idle exit. On the screen path this hands the terminal
   * back (raw mode off, alternate screen left) — Ctrl+C only reaches SIGINT
   * with raw mode OFF, which is exactly the window where nobody is reading
   * keys, and exiting from there without restoring left a frozen frame with
   * a hidden shell behind it (the 2026-10-16 "so freez").
   */
  restore?: () => void
  /** Overridable for tests; defaults to `process.exit`. */
  exit?: (code: number) => never | void
  /** Overridable for tests; defaults to the real process. */
  target?: Pick<NodeJS.Process, 'on' | 'off'>
}

/** Installs the handler; call the returned function to remove it. */
export function installInterrupt(deps: InterruptDeps): () => void {
  const target = deps.target ?? process
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const idleExitCode = deps.idleExitCode ?? 130
  const onSignal = (): void => {
    if (deps.isRunning()) {
      deps.abort()
      return
    }
    try { deps.restore?.() } catch { /* best effort — never block the exit */ }
    exit(idleExitCode)
  }
  target.on('SIGINT', onSignal)
  return () => { target.off('SIGINT', onSignal) }
}

export interface FatalGuardDeps {
  /** Stop anything that keeps painting (the spinner), so the report stays readable. */
  quiet?: () => void
  /** Put the terminal back — raw mode off, mouse disarmed, alternate screen left. */
  restore: () => void
  /** Where the error goes; the real caller prints the stack to stderr. */
  report: (error: unknown) => void
  /** Optional trace hook (WEDNESDAY_TRACE); one compact line per fatal. */
  trace?: (line: string) => void
  /** Exit code; defaults to 1. */
  exitCode?: number
  /** Overridable for tests; defaults to `process.exit`. */
  exit?: (code: number) => never | void
  /** Overridable for tests; defaults to the real process. */
  target?: Pick<NodeJS.Process, 'on' | 'off'>
}

/**
 * Last line of defence for the alternate screen.
 *
 * `screenRepl`'s try/finally restores the terminal for every failure that
 * travels through the awaited chain. A throw that does NOT — a timer
 * callback, a floating promise — reaches Node's default handler with the
 * terminal still in the alternate screen and raw mode on: the frame stays
 * frozen on the glass, keys echo nowhere, and Ctrl+C is one more byte
 * nobody reads. That is the 2026-10-16 "so freez" report, and whatever the
 * underlying crash turns out to be, it must never be allowed to read as a
 * dead terminal again: stop the painting, restore, say what died, leave
 * loudly.
 *
 * Exit mirrors `run()`'s drain-then-force pattern: `process.exit()` at the
 * moment of the crash can cut the restore and the report off mid-write on a
 * Windows console, and being SEEN is the entire point of this path.
 */
export function installFatalGuard(deps: FatalGuardDeps): () => void {
  const target = deps.target ?? process
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const onFatal = (reason: unknown): void => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    deps.trace?.(`fatal ${detail.split('\n')[0]}`)
    try { deps.quiet?.() } catch { /* best effort — never mask the crash */ }
    try { deps.restore() } catch { /* best effort — never mask the crash */ }
    deps.report(reason)
    const code = deps.exitCode ?? 1
    if (target === process) process.exitCode = code
    const bail = setTimeout(() => exit(code), 500)
    if (typeof bail.unref === 'function') bail.unref()
  }
  target.on('uncaughtException', onFatal)
  target.on('unhandledRejection', onFatal)
  return () => {
    target.off('uncaughtException', onFatal)
    target.off('unhandledRejection', onFatal)
  }
}

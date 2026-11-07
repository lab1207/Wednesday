/**
 * Kill a host process AND everything it started.
 *
 * WHY THIS EXISTS (2026-11-07, operator report: "the /proof command when run
 * it hangs all wednesday — the project stops").
 *
 * The DSH host spawns the worker as a CHILD, and the worker INHERITS the
 * host's stderr. The tree is therefore:
 *
 *   wednesday -> node tsx host.ts -> node worker.js
 *
 * `child.kill()` ends the MIDDLE node only. The worker keeps running, and
 * because it holds the inherited pipe, the parent's stdout/stderr streams
 * never end: Node's `close` event never fires, so any code waiting for it
 * waits FOREVER. That is the freeze the operator saw — not a slow model, a
 * process that was never reaped.
 *
 * The same shape exists in two places (the harness proof and the build
 * executor), so the fix lives in ONE place and both call it.
 *
 * Windows has no process group to signal, so the tree is killed with
 * `taskkill /T /F` — the OS's own tree killer, which reaches the worker.
 * On POSIX the child is spawned as its own group leader (`detached`) and the
 * whole group is signalled, so the worker dies with the host.
 */
import { spawnSync } from 'node:child_process'

/** The part of a child process this module needs. */
export interface KillableChild {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Spawn options that make the child killable as a GROUP on POSIX.
 *
 * `detached: true` puts the child in a new process group, which is what
 * `process.kill(-pid)` needs. It is a no-op on Windows (the flag is ignored
 * there and the tree is killed with taskkill instead).
 */
export function groupSpawnOptions(): { detached: boolean } {
  return {
    detached:
      process.platform !== 'win32',
  }
}

/**
 * Kill the child and every descendant it started.
 *
 * Best effort by design: a process that is already gone is not an error, and
 * a kill that cannot be delivered must never throw into the caller — the
 * caller's job is to stop WAITING, which the grace timers handle.
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  const pid = child.pid

  if (
    typeof pid === 'number' &&
    pid > 0
  ) {
    if (process.platform === 'win32') {
      try {
        spawnSync(
          'taskkill',
          [
            '/pid',
            String(pid),
            '/T',
            '/F',
          ],
          {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 15_000,
          },
        )
        return
      } catch {
        // taskkill is unavailable: fall through to the plain kill.
      }
    } else {
      try {
        // The negative pid is the process GROUP: the host and the worker.
        process.kill(-pid, signal)
        return
      } catch {
        // Not a group leader (or already gone): fall through.
      }
    }
  }

  try {
    child.kill(signal)
  } catch {
    // Already gone.
  }
}

/**
 * How long to wait for a killed child's pipes to close before settling anyway.
 *
 * The pipes belong to the PROCESS TREE, so a kill that missed a grandchild
 * leaves them open forever. Two seconds is long enough for a clean tree to
 * flush its last line and short enough that the operator is not left staring
 * at a frozen app.
 */
export const KILL_GRACE_MS = 2000

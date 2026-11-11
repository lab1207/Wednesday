import { describeNpmFailure, resolveNpm, runNpm, type NpmRunResult } from './npm-command.js'

// Consent-gated self-update for `/update` (2026-11-01, operator request:
// "user said yes then it updates, like opencode").
//
// Security contract:
//  - the ONLY source is the official npm registry over HTTPS, via npm itself
//    (npm verifies the tarball against the registry's shasum);
//  - the install spec pins the EXACT version the registry just reported —
//    never the moving tag — so the release cannot change between check and
//    install (TOCTOU);
//  - the version string is shape-validated before it is ever passed as an
//    argument, and npm is spawned with an ARG ARRAY (no shell), so no
//    command injection is possible through the version or package name;
//  - nothing here runs without the operator's explicit yes at the call site;
//  - the post-install verify re-asks the registry for the pinned version and
//    compares, so a half-written install is reported as failed.
//
// WHY THIS FILE CHANGED (operator report, 2026-11-09):
//
//   "i run this /update command then it ask you are sure install update yes
//    or no i select yes then, this i see ... 'update installed failed: npm
//    exited with signal - manual: npm i -g @lab1207/wednesday@0.2.0-beta.5'"
//
// Two separate defects, both invisible before:
//
//  1. THE UPDATE NEVER RAN ON WINDOWS. The old code spawned `npm` with
//     `shell: false`. On Windows `npm` is `npm.cmd`, a BATCH file, and Node
//     cannot execute a batch file without a shell -- the spawn died with
//     ENOENT and `status` was null. The old message then read
//     `npm exited with ${status ?? 'signal'}`, which printed the literal
//     word "signal" and threw the real reason away. The operator was told
//     the install was killed by a signal that never existed.
//
//  2. THE INSTALL WAS SILENT. `spawnSync` blocks the event loop, so the
//     terminal froze for the whole install with npm's output captured and
//     never shown. "Nothing show means what install what now" is exactly
//     that: a frozen screen with no line saying what is happening.
//
// The fix: npm is invoked through `npm-command.ts` (node + npm-cli.js, no
// shell, works on every platform), the run is ASYNC so the UI keeps
// painting, every line npm prints is forwarded to the operator, and a
// failure names the real reason -- the OS error, the signal, or npm's own
// message -- never a placeholder.

export const UPDATE_PACKAGE = '@lab1207/wednesday'

// strict semver (loose enough for prerelease): 1.2.3 or 1.2.3-dev.4
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

export function isInstallableVersion(version: string): boolean {
  return VERSION_RE.test(version)
}

/**
 * The exact command shown to / printed for the operator.
 *
 * WHY `--foreground-scripts`: npm hides lifecycle-script output by default
 * (`npm config get foreground-scripts` -> false), so a plain install is
 * SILENT during the postinstall -- the step that links the execution floor.
 * The flag makes the install say what it is doing, which is the whole point
 * of the operator's "show me what is installing and what is next" ask.
 */
export function updateCommandLine(version: string): string {
  return `npm i -g ${UPDATE_PACKAGE}@${version} --foreground-scripts`
}

/**
 * Auto-restart guard: after a successful install the harness re-execs itself
 * once onto the new version. The child runs with WEDNESDAY_JUST_UPDATED=1 so
 * a second restart can never loop — if the version somehow still reads old,
 * the child just shows the notice instead of restarting again.
 */
export function shouldAutoRestart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEDNESDAY_JUST_UPDATED !== '1'
}

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * The seam the tests drive.
 *
 * WHY IT TAKES ONLY THE ARGS: the executable is resolved by `npm-command.ts`
 * (node + npm-cli.js on Windows), and a test must not have to know which
 * machine it runs on. What the test DOES pin is the ARG ARRAY -- that the
 * install spec is the exact pinned version and that no shell is involved.
 */
export type RunFn = (
  args: string[],
  hooks?: { onOutput?: (line: string) => void },
) => Promise<NpmRunResult>

/** Real runner: npm through the shared resolver, async, streaming. */
export const npmRun: RunFn = async (args, hooks) =>
  runNpm(args, {
    onOutput: hooks?.onOutput,
    timeoutMs: 240_000,
  })

export type InstallOutcome =
  | { ok: true; installed: string }
  | { ok: false; stage: 'version' | 'install' | 'verify'; detail: string }

/** What the operator is told while the install runs. */
export interface UpdateProgress {
  /** A short line: what is happening right now. */
  step?: (text: string) => void
  /** One line of npm's own output, exactly as npm printed it. */
  output?: (line: string) => void
}

export async function installUpdate(
  deps: { version: string; run?: RunFn; progress?: UpdateProgress },
): Promise<InstallOutcome> {
  const run = deps.run ?? npmRun
  const version = deps.version.trim()
  if (!isInstallableVersion(version)) {
    return { ok: false, stage: 'version', detail: `refusing to install malformed version "${deps.version}"` }
  }
  const spec = `${UPDATE_PACKAGE}@${version}`
  deps.progress?.step(`installing ${spec} from the npm registry — this can take a minute…`)
  const install = await run(
    ['install', '-g', spec, '--no-fund', '--no-audit', '--foreground-scripts'],
    { onOutput: deps.progress?.output },
  )
  if (!install.ok) {
    return {
      ok: false,
      stage: 'install',
      detail: describeNpmFailure(install),
    }
  }
  // Verify the pinned version really is what the registry serves now.
  deps.progress?.step(`verifying ${spec} is what the registry serves…`)
  const view = await run(['view', spec, 'version'])
  if (!view.ok || view.stdout.trim() !== version) {
    return {
      ok: false,
      stage: 'verify',
      detail: `install ran but the registry check said "${view.stdout.trim() || describeNpmFailure(view)}" (expected ${version})`,
    }
  }
  return { ok: true, installed: version }
}

/**
 * Is npm reachable at all on this machine?
 *
 * WHY THIS IS SEPARATE: "npm is not installed" and "npm is installed but the
 * install failed" are different answers, and the operator needs the first one
 * before the second one can even be attempted. The old code could not tell
 * them apart because it never checked.
 */
export function npmAvailability(): { available: boolean; detail: string } {
  const invocation = resolveNpm()
  if (!invocation) {
    return {
      available: false,
      detail:
        'npm could not be located on this machine (expected npm-cli.js beside node, or npm on PATH).',
    }
  }
  return { available: true, detail: invocation.label }
}

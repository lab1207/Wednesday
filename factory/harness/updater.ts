import { spawnSync } from 'node:child_process'

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

export const UPDATE_PACKAGE = '@lab1207/wednesday'

// strict semver (loose enough for prerelease): 1.2.3 or 1.2.3-dev.4
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

export function isInstallableVersion(version: string): boolean {
  return VERSION_RE.test(version)
}

/** The exact command shown to / printed for the operator. */
export function updateCommandLine(version: string): string {
  return `npm i -g ${UPDATE_PACKAGE}@${version}`
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
export type RunFn = (command: string, args: string[]) => RunResult

/** Real runner: npm as an arg array, no shell, bounded in time. */
export const npmRun: RunFn = (command, args) => {
  const done = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
    shell: false,
  })
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export type InstallOutcome =
  | { ok: true; installed: string }
  | { ok: false; stage: 'version' | 'install' | 'verify'; detail: string }

export function installUpdate(deps: { version: string; run?: RunFn }): InstallOutcome {
  const run = deps.run ?? npmRun
  const version = deps.version.trim()
  if (!isInstallableVersion(version)) {
    return { ok: false, stage: 'version', detail: `refusing to install malformed version "${deps.version}"` }
  }
  const spec = `${UPDATE_PACKAGE}@${version}`
  const install = run('npm', ['install', '-g', spec, '--no-fund', '--no-audit'])
  if (install.status !== 0) {
    return {
      ok: false,
      stage: 'install',
      detail: (install.stderr || install.stdout).trim().slice(0, 400) || `npm exited with ${install.status ?? 'signal'}`,
    }
  }
  // Verify the pinned version really is what the registry serves now.
  const view = run('npm', ['view', spec, 'version'])
  if (view.status !== 0 || view.stdout.trim() !== version) {
    return {
      ok: false,
      stage: 'verify',
      detail: `install ran but registry check said "${view.stdout.trim() || view.stderr.trim().slice(0, 200)}" (expected ${version})`,
    }
  }
  return { ok: true, installed: version }
}

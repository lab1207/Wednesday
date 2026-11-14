/**
 * One implementation of the `scan` command, shared by both entry points
 * (2026-11-08, B231).
 *
 * WHY ONE FILE: the gate has TWO callers and they must not drift. The
 * operator-facing command is `wednesday scan` — and `wednesday` is the
 * HARNESS bin (`bin/wednesday.js` imports `factory/harness/harness.ts`), not
 * `factory/cli.ts`. So the verb has to exist in the harness's argv parsing or
 * the operator's own command lands in the request parser and dies with
 * `Unknown option: --repo`. That is exactly what the first proof run showed:
 * the installed binary answered `startup health: OK ... Unknown option:
 * --repo`, because a scan request was read as a build request.
 *
 * `factory/cli.ts` forwards here too, so the internal verb and the
 * operator-facing verb are the same code.
 */
import { installHook, printReport, repoRoot, scanStaged } from './commit-scan'

export interface ScanArgs {
  /** The repository to scan. Defaults to the caller's repo. */
  repo: string
  /** Report the findings, then allow the commit anyway. */
  allow: boolean
  /** Install the gate into the target repository and stop. */
  install: boolean
}

/** Parse the scan command's arguments (pure). */
export function parseScanArgs(args: string[]): ScanArgs {
  const repoFlag = args.indexOf('--repo')
  const repo =
    repoFlag >= 0 && args[repoFlag + 1]
      ? repoRoot(args[repoFlag + 1])
      : repoRoot()

  // The escape hatch is BOTH a flag and an env var, because the hook that
  // calls this has no way to add a flag to a `git commit`: the operator sets
  // `WEDNESDAY_SCAN_ALLOW=1 git commit` and the env var is all there is.
  // Dropping the env form is how a documented escape hatch becomes a lie.
  const allow =
    args.includes('--allow-findings') ||
    process.env.WEDNESDAY_SCAN_ALLOW === '1'

  return {
    repo,
    allow,
    install: args.includes('--install-hook'),
  }
}

/**
 * Run the scan command, returning the exit code the caller should use.
 *
 * Never throws: a hook that crashes with a stack trace blocks the commit and
 * tells the operator nothing, so a failure is a message and a code.
 */
export function runScanCommand(args: string[]): number {
  const parsed = parseScanArgs(args)

  if (parsed.install) {
    const { path } = installHook(parsed.repo)
    console.log(`wednesday-scan: installed the gate at ${path}`)
    console.log('                core.hooksPath is now .githooks — the gate')
    console.log('                travels with the repository, so every clone')
    console.log('                and every contributor gets it.')
    return 0
  }

  const report = scanStaged(parsed.repo)
  return printReport(report, { allow: parsed.allow })
}

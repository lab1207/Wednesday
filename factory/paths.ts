import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

// Resolve bundled assets from this module, not the caller's working directory.
export const INSTALL_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const DSH_ROOT = resolve(process.env.WEDNESDAY_DSH_HOME ?? join(INSTALL_ROOT, 'dsh'))
export const DSH_AGENTS_HOME = join(DSH_ROOT, '.agents')
export const WORKER_DIRECTORY = join(INSTALL_ROOT, 'factory', 'dsh-worker')
export const HOST = join(WORKER_DIRECTORY, 'host.ts')

/**
 * Nearest self-contained DSH runtime closure: the installed per-platform
 * `wednesday-runtime-*` optional package first, the provisioned dev
 * closure second. Undefined when neither exists (fresh checkout without
 * provisioning, or a bare npm install before the runtime package ships).
 *
 * npm hoists an optional dependency out of the package that asks for it, so
 * the runtime usually sits in the SCOPE above the package
 * (`node_modules/@lab1207/wednesday-runtime-*`), not inside it. Both
 * layouts are checked, and Node itself is asked as the final authority.
 *
 * @param installRoot - the package root; defaults to this package.
 * @param workerDirectory - the worker directory; defaults to this package's.
 * @returns the runtime root, or undefined when no runtime is installed.
 */
export function runtimeRoot(
  installRoot: string = INSTALL_ROOT,
  workerDirectory: string = WORKER_DIRECTORY,
): string | undefined {
  const platform = `${process.platform}-${process.arch}`
  const candidates = [
    // A non-hoisted install (npm keeps the optional package under ours).
    join(installRoot, 'node_modules', '@lab1207', `wednesday-runtime-${platform}`, 'runtime'),
    // The normal npm install: optional deps are hoisted to the scope above
    // us, so the nested path above does not exist.
    join(installRoot, '..', `wednesday-runtime-${platform}`, 'runtime'),
    join(workerDirectory, 'deploy', 'runtime'),
  ]
  // Ask Node itself as the final authority. The require is created FROM the
  // install root, so it resolves exactly the way Node resolves the runtime
  // for the installed package — nested, hoisted or global.
  try {
    const require = createRequire(join(installRoot, 'package.json'))
    const manifest = require.resolve(`@lab1207/wednesday-runtime-${platform}/package.json`)
    candidates.splice(1, 0, join(dirname(manifest), 'runtime'))
  } catch {
    // Optional package absent; the fixed candidates and DSH_ROOT own it.
  }
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) return root
  }
  return undefined
}

// Writable state is independent of installation assets. Overrides support
// isolated tests and deployments; explicit per-file paths disable migration.
export const STATE_HOME = resolve(process.env.WEDNESDAY_STATE_HOME ?? join(homedir(), '.wednesday', 'state'))
export const TASKS_PATH = resolve(process.env.HERMES_TASKS_PATH ?? join(STATE_HOME, 'tasks.json'))
export const EVENTS_PATH = resolve(process.env.FACTORY_EVENTS_PATH ?? join(STATE_HOME, 'events.jsonl'))
/**
 * The MCP server's job registry (2026-11-17): the jobs a client started,
 * persisted so `wednesday_status` / `wednesday_wait` / `wednesday_result`
 * still answer after the server process restarts. Overridable for tests,
 * same as the other state files.
 */
export const JOBS_PATH = resolve(process.env.WEDNESDAY_JOBS_PATH ?? join(STATE_HOME, 'jobs.json'))

/**
 * WHERE OPERATOR-INSTALLED SKILLS LIVE (2026-11-11).
 *
 * The external skills surface: a skill directory the operator drops in and
 * Wednesday discovers on the next run. It sits beside the state home, NOT
 * inside it, because a skill is a thing the operator OWNS (they edit it, they
 * version it, they share it) and the state home is runtime scratch that gets
 * migrated and cleaned.
 *
 * `WEDNESDAY_SKILLS_HOME` overrides it, for a portable install and for the
 * tests (which must never touch the operator's real home).
 */
export const SKILLS_HOME = resolve(
  process.env.WEDNESDAY_SKILLS_HOME ?? join(homedir(), '.wednesday', 'skills'),
)

/**
 * The PROJECT's own skills: `<workspace>/.wednesday/skills/`.
 *
 * A skill that belongs to one repository lives with that repository, so it
 * travels with a clone and a teammate gets it without installing anything.
 */
export function workspaceSkillsHome(workspace: string): string {
  return join(resolve(workspace), '.wednesday', 'skills')
}

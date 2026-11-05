import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 */
export function runtimeRoot(): string | undefined {
  const platform = `${process.platform}-${process.arch}`
  for (const root of [
    join(INSTALL_ROOT, 'node_modules', '@lab1207', `wednesday-runtime-${platform}`, 'runtime'),
    join(WORKER_DIRECTORY, 'deploy', 'runtime'),
  ]) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) return root
  }
  return undefined
}

// Writable state is independent of installation assets. Overrides support
// isolated tests and deployments; explicit per-file paths disable migration.
export const STATE_HOME = resolve(process.env.WEDNESDAY_STATE_HOME ?? join(homedir(), '.wednesday', 'state'))
export const TASKS_PATH = resolve(process.env.HERMES_TASKS_PATH ?? join(STATE_HOME, 'tasks.json'))
export const EVENTS_PATH = resolve(process.env.FACTORY_EVENTS_PATH ?? join(STATE_HOME, 'events.jsonl'))

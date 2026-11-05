/**
 * Zero-config defaults (2026-10-03): the harness should work like
 * `type a request → it runs`, not like a flag form.
 *
 * Discovery is deliberately cheap and read-only: look at the workspace,
 * pick the verification command and stack, and stay silent unless the
 * guess is genuinely risky. Explicit flags always win.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AutoDefaults {
  /** Verification commands for the task, best guess first. */
  tests: string[]
  stack: string
  role: string
  /** How the guess was made (shown only in the preview line). */
  reason: string
}

const STACK_FILES: Array<[string, string, string]> = [
  ['package.json', 'node', 'backend'],
  ['pyproject.toml', 'python', 'backend'],
  ['requirements.txt', 'python', 'backend'],
  ['Cargo.toml', 'rust', 'backend'],
  ['go.mod', 'go', 'backend'],
]

const TEST_COMMANDS: Array<[string, string[]]> = [
  ['package.json', ['npm test']],
  ['pyproject.toml', ['python -m pytest -q']],
  ['requirements.txt', ['python -m pytest -q']],
  ['Cargo.toml', ['cargo test']],
  ['go.mod', ['go test ./...']],
]

/**
 * Verification fallback for directories with no test manifest: the build
 * must still leave something behind. `npm test` in a manifest-less dir can
 * never pass (2026-10-31 live-run finding), so an empty workspace must fail
 * and a non-empty one passes. Node is guaranteed — Wednesday is a node app.
 */
export const NONEMPTY_WORKSPACE_CHECK =
  'node -e "const fs=require(\'fs\');process.exit(fs.readdirSync(\'.\').length===0?1:0)"'

/**
 * Best-effort defaults from the workspace. Manifests pick their real test
 * command; anything without a manifest gets the non-empty-workspace check,
 * because a guessed `npm test` can never pass where no package.json exists.
 */
export function detectDefaults(workspace: string): AutoDefaults {
  const files = safeReadDir(workspace)
  for (const [file, tests] of TEST_COMMANDS) {
    if (files.includes(file)) {
      return { tests, ...stackFor(file), reason: `${file} found` }
    }
  }
  // python-style test dirs without a manifest
  if (files.includes('test') || files.includes('tests') || files.includes('test_')) {
    return { tests: ['python -m pytest -q'], stack: 'python', role: 'backend', reason: 'python test dir found' }
  }
  // source dirs without a manifest: no package.json means `npm test` cannot
  // run — verify the work left files behind instead.
  if (files.includes('server') || files.includes('src')) {
    return { tests: [NONEMPTY_WORKSPACE_CHECK], stack: 'node', role: 'backend', reason: 'source dir found, no manifest — non-empty workspace check' }
  }
  return { tests: [NONEMPTY_WORKSPACE_CHECK], stack: 'node', role: 'backend', reason: 'nothing recognisable — non-empty workspace check' }
}

function stackFor(file: string): { stack: string; role: string } {
  const hit = STACK_FILES.find(([name]) => name === file)
  return hit ? { stack: hit[1], role: hit[2] } : { stack: 'node', role: 'backend' }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Package.json test script, if present — used to confirm the guessed
 * command actually exists before we ask the operator to approve it.
 */
export function packageHasTestScript(workspace: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return typeof pkg.scripts?.test === 'string'
  } catch {
    return false
  }
}

/** True when the workspace looks like a real project (not a bare dir). */
export function hasProjectMarker(workspace: string): boolean {
  if (!existsSync(workspace)) return false
  const files = safeReadDir(workspace)
  return STACK_FILES.some(([name]) => files.includes(name))
}
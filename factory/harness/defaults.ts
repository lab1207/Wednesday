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
 * Script names that are a GATE, not a feature (2026-11-08).
 *
 * WHY: three separate briefs asked for the same thing — "automated
 * compilation and type checks", "strict linters catch 90% of the small
 * models' mistakes". The mechanism already exists (`verify` runs whatever
 * `--test` commands the task declares, and the repair loop feeds a failure
 * back to the coder), but nothing ARRANGED it: a TypeScript workspace with a
 * `typecheck` script was answering `npm test` and nothing else, so a missing
 * brace reached the operator as a passing run.
 *
 * A sub-3B model's most common defect is a syntax slip, and the cheapest,
 * most deterministic reader of a syntax slip is the compiler. Running the
 * gate the project already declares costs one read of package.json and turns
 * "the model wrote it" into "the compiler agreed".
 *
 * Only scripts the manifest DECLARES are used — never a guessed `npx tsc`,
 * which would download a toolchain on a machine that has none and turn a
 * missing dependency into a failed run.
 */
const GATE_SCRIPTS: Array<[string, string]> = [
  ['typecheck', 'npm run typecheck'],
  ['tsc', 'npm run tsc'],
  ['lint', 'npm run lint'],
]

/** The scripts a manifest declares, or {} when there is no readable one. */
export function packageScripts(workspace: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') return pkg.scripts
  } catch {
    // No manifest, or unreadable: callers fall back to what they have.
  }
  return {}
}

/**
 * The gate commands this workspace declares, in declaration order.
 *
 * Pure and exported so the claim can be asserted without a model.
 */
export function packageGateCommands(workspace: string): string[] {
  const scripts = packageScripts(workspace)
  const gates: string[] = []
  for (const [name, command] of GATE_SCRIPTS) {
    if (typeof scripts[name] === 'string') {
      gates.push(command)
    }
  }
  return gates
}

/**
 * Best-effort defaults from the workspace. Manifests pick their real test
 * command; anything without a manifest gets the non-empty-workspace check,
 * because a guessed `npm test` can never pass where no package.json exists.
 */
export function detectDefaults(workspace: string): AutoDefaults {
  const files = safeReadDir(workspace)
  for (const [file, tests] of TEST_COMMANDS) {
    if (!files.includes(file)) continue

    if (file !== 'package.json') {
      return { tests, ...stackFor(file), reason: `${file} found` }
    }

    // A manifest can declare more than a test: run the gates it declares
    // too, so a syntax slip is caught by the compiler instead of reaching
    // the operator. And when the manifest declares NO test script, `npm
    // test` is a command that cannot pass — the run would be red before it
    // started, which is the same defect class as a broken gate.
    const scripts = packageScripts(workspace)
    const gates = packageGateCommands(workspace)

    if (typeof scripts.test === 'string') {
      return {
        tests: ['npm test', ...gates],
        stack: 'node',
        role: 'backend',
        reason:
          gates.length > 0
            ? `package.json found (test + ${gates.length} declared gate(s))`
            : 'package.json found',
      }
    }

    if (gates.length > 0) {
      return {
        tests: gates,
        stack: 'node',
        role: 'backend',
        reason: `package.json found, no "test" script — the declared gate(s) run instead`,
      }
    }

    return {
      tests: [NONEMPTY_WORKSPACE_CHECK],
      stack: 'node',
      role: 'backend',
      reason: 'package.json found, no "test" script and no declared gate — non-empty workspace check',
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
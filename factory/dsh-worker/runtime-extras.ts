// Runtime seam backfill (2026-11-16).
//
// The worker configuration (`cordis.yml`) and the DSH runtime closure ship
// INDEPENDENTLY: the configuration lives in this repository, the closure
// lives in the per-platform optional package
// `@lab1207/wednesday-runtime-<platform>`. A public install can therefore end
// up with a configuration that names a plugin the installed closure does not
// have, and the worker then fails to load its plugin tree
// ("loader entries failed to apply") — the install looks healthy and EVERY
// task dies at the worker stage.
//
// The seam packages this repository needs are vendored under
// `runtime-extras/` (see its README). A missing one is copied into the
// installed closure before the worker starts. A package the closure already
// has is never touched: the closure's own version always wins.

import { cp, readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { WORKER_DIRECTORY } from '../paths'

/** What one backfill pass did. */
export interface RuntimeBackfillResult {
  /** Package names copied into the closure. */
  copied: string[]
  /** Package names the closure already had, left untouched. */
  skipped: string[]
  /** Human-readable reasons; a refusal is reported, never thrown. */
  errors: string[]
}

/** A package name is `@scope/name`: one scope, one name, no separators. */
const SCOPED_NAME = /^@([^/\\]+)\/([^/\\]+)$/

/**
 * The vendored seam packages shipped with this package.
 *
 * @param workerDirectory - the worker directory; defaults to this package's.
 * @returns the absolute path of the vendored extras directory.
 */
export function runtimeExtrasRoot(workerDirectory: string = WORKER_DIRECTORY): string {
  return join(workerDirectory, 'runtime-extras')
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Copy the vendored seam packages the installed runtime closure lacks.
 *
 * The closure is the target: `<runtimeRoot>/node_modules/@scope/name`. A
 * package that is already there is skipped and NEVER overwritten, so a
 * closure that is newer than this package keeps its own version. Anything
 * that cannot be copied is reported in `errors`; this function never throws,
 * because a failed backfill must surface as a diagnosable worker failure
 * rather than as a host that dies before it can explain itself.
 *
 * @param runtimeRoot - the installed runtime closure root.
 * @param extrasRoot - the vendored extras directory; defaults to this package's.
 * @returns what was copied, what was skipped and what was refused.
 */
export async function backfillRuntimeExtras(
  runtimeRoot: string,
  extrasRoot: string = runtimeExtrasRoot(),
): Promise<RuntimeBackfillResult> {
  const copied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const targetRoot = resolve(runtimeRoot, 'node_modules')

  let scopes: Awaited<ReturnType<typeof readdir>>
  try {
    scopes = await readdir(extrasRoot, { withFileTypes: true })
  } catch (error) {
    errors.push(`cannot read the vendored extras at ${extrasRoot}: ${describe(error)}`)
    return { copied, skipped, errors }
  }

  for (const scope of scopes) {
    if (!scope.isDirectory() || !scope.name.startsWith('@')) continue
    const scopeDirectory = join(extrasRoot, scope.name)

    let packages: Awaited<ReturnType<typeof readdir>>
    try {
      packages = await readdir(scopeDirectory, { withFileTypes: true })
    } catch (error) {
      errors.push(`cannot read the vendored scope ${scope.name}: ${describe(error)}`)
      continue
    }

    for (const entry of packages) {
      if (!entry.isDirectory()) continue
      const source = join(scopeDirectory, entry.name)

      let name: string
      try {
        const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name !== 'string') throw new Error('package.json has no name')
        name = manifest.name
      } catch (error) {
        errors.push(`refused ${scope.name}/${entry.name}: ${describe(error)}`)
        continue
      }

      const match = SCOPED_NAME.exec(name)
      if (!match) {
        errors.push(`refused ${name}: a vendored package must be named @scope/name`)
        continue
      }
      const [, scopeName, packageName] = match
      // The manifest decides nothing about WHERE a package lands: its
      // directory decides that, so a manifest cannot steer a copy out of
      // the closure it belongs to.
      if (scopeName !== scope.name.slice(1) || packageName !== entry.name) {
        errors.push(`refused ${name}: it does not match its directory ${scope.name}/${entry.name}`)
        continue
      }

      const target = join(targetRoot, scope.name, packageName)
      if (resolve(target) !== targetRoot && !resolve(target).startsWith(targetRoot + sep)) {
        errors.push(`refused ${name}: the target would leave the runtime closure`)
        continue
      }

      if (await exists(target)) {
        skipped.push(name)
        continue
      }

      try {
        await cp(source, target, { recursive: true, dereference: true })
        copied.push(name)
      } catch (error) {
        errors.push(`failed to copy ${name}: ${describe(error)}`)
      }
    }
  }

  return { copied, skipped, errors }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Wednesday postinstall: link the DSH execution floor into place.
// The host (factory/dsh-worker/host.ts) imports @deepseek-ai/dsh-app-boot
// and dsh-session, which are unpublished workspace packages — they resolve
// on dev machines via the dsh checkout tsconfig, and NOWHERE on an
// npm-installed machine. This script junctions them from the nearest
// self-contained runtime closure (installed optional package first,
// provisioned dev closure second) into our own node_modules, so host
// imports resolve by location on every machine. Plain node, zero deps.
//
// Safety: only creates junctions/symlinks; never deletes real directories.
// Missing runtime = loud warning + exit 0 (install succeeds degraded;
// the first task run fails with a clear message instead).
// Idempotent: safe to re-run on every `npm install`.
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_ROOT = fileURLToPath(new URL('../', import.meta.url))
// The only unpublished @deepseek-ai import missing from our own
// node_modules (grep-verified 2026-09-20: host.ts and worker-bin.ts need
// dsh-app-boot; dsh-session already arrives as a transitive dependency at
// a version the live benchmarks proved compatible, so it is deliberately
// NOT shadowed here).
const LINK_NAMES = ['dsh-app-boot']

function runtimeCandidates() {
  const platform = `${process.platform}-${process.arch}`
  return [
    join(INSTALL_ROOT, 'node_modules', '@lab1207', `wednesday-runtime-${platform}`, 'runtime'),
    join(INSTALL_ROOT, 'factory', 'dsh-worker', 'deploy', 'runtime'),
  ]
}

function findRuntime() {
  for (const root of runtimeCandidates()) {
    const missing = LINK_NAMES.filter(name => !existsSync(join(root, 'node_modules', '@deepseek-ai', name)))
    if (missing.length === 0) return root
  }
  return undefined
}

async function link(source, target) {
  let metadata
  try {
    metadata = lstatSync(target)
  } catch {
    metadata = undefined
  }
  if (metadata) {
    if (!metadata.isSymbolicLink()) {
      console.warn(`[wednesday] keeping real directory (not linking): ${target}`)
      return
    }
    rmSync(target, { recursive: true, force: true })
  }
  await mkdir(join(INSTALL_ROOT, 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(source, target, 'junction')
  console.log(`[wednesday] linked ${target} -> ${source}`)
}

async function main() {
  const runtime = findRuntime()
  if (!runtime) {
    console.warn('[wednesday] no DSH runtime found (looked for the wednesday-runtime optional package and factory/dsh-worker/deploy/runtime). Task execution will fail until one is provisioned; `wednesday --help` and config still work.')
    return
  }
  for (const name of LINK_NAMES) {
    await link(
      join(runtime, 'node_modules', '@deepseek-ai', name),
      join(INSTALL_ROOT, 'node_modules', '@deepseek-ai', name),
    )
  }
  console.log(`[wednesday] execution floor linked from ${runtime}`)
}

main().catch(error => {
  console.warn(`[wednesday] postinstall warning: ${error instanceof Error ? error.message : String(error)}`)
})

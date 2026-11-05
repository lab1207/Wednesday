// Build a self-contained DSH runtime for Wednesday's host + ACP worker.
// Reuses the deployment pattern from dsh/scripts/build-exe-for-python-sdk.ts:
// pnpm deploy → restore legacy hoists → materialize links, leaving no
// symlinks into the checkout. Output: factory/dsh-worker/deploy/runtime.
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DSH_ROOT = join(INSTALL_ROOT, 'dsh')
const DEPLOY_DIRECTORY = join(INSTALL_ROOT, 'factory', 'dsh-worker', 'deploy')
const RUNTIME = join(DEPLOY_DIRECTORY, 'runtime')
const DEPLOY_ROOT_PACKAGE = 'wednesday-runtime-pkg'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = join(DSH_ROOT, 'apps', 'wednesday-runtime', 'node_modules')
/** Worker entry inside the deployed closure. */
const WORKER_BIN = join('node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')

const fail = (message: string): never => {
  process.stderr.write(`[provision-worker] ${message}\n`)
  process.exit(1)
}

const findSymlink = async (directory: string): Promise<string | undefined> => {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

const materializeStagedLinks = async (): Promise<void> => {
  const nodeModules = join(RUNTIME, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Restore direct packages the legacy hoister places beside the deploy source. */
const restoreLegacyHoists = async (): Promise<void> => {
  const manifest = JSON.parse(await readFile(join(RUNTIME, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(RUNTIME, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(DEPLOY_SOURCE_NODE_MODULES, dependency)
    if (!existsSync(source)) {
      fail(`deployed dependency ${dependency} is absent from both ${destination} and ${DEPLOY_SOURCE_NODE_MODULES}. Run pnpm install in ${DSH_ROOT} first.`)
    }
    const nestedNodeModules = join(source, 'node_modules')
    await mkdir(join(RUNTIME, 'node_modules', dependency.split('/').slice(0, -1).join('/')), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
  }
}

if (!existsSync(join(DSH_ROOT, 'pnpm-workspace.yaml'))) {
  fail(`dsh workspace not found at ${DSH_ROOT}`)
}
if (!existsSync(join(DSH_ROOT, 'node_modules'))) {
  fail(`dsh dependencies not installed; run: pnpm install  (in ${DSH_ROOT})`)
}
await rm(RUNTIME, { recursive: true, force: true })
const deploy = spawnSync('pnpm', [
  '--filter', DEPLOY_ROOT_PACKAGE, 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true', RUNTIME,
], { cwd: DSH_ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
if (deploy.status !== 0) {
  fail(`pnpm deploy failed:\n${deploy.stderr}${deploy.stdout}`)
}
await restoreLegacyHoists()
await materializeStagedLinks()
const remaining = await findSymlink(join(RUNTIME, 'node_modules'))
if (remaining !== undefined) {
  fail(`staged runtime still contains a symlink: ${remaining}`)
}
const workerEntry = join(RUNTIME, WORKER_BIN)
if (!existsSync(workerEntry)) {
  fail(`worker entry missing after deploy: ${workerEntry}`)
}
process.stdout.write(`[provision-worker] self-contained runtime at ${relative(process.cwd(), RUNTIME)}\n`)

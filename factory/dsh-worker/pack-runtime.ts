// Dev-time packer: stage a per-platform DSH runtime package from the
// provisioned closure (factory/dsh-worker/deploy/runtime, built by
// provision-worker.ts). Prunes other platforms' native prebuilds, writes a
// manifest, and stages dist/runtime-<platform>/ ready for `npm publish`
// as @lab1207/wednesday-runtime-<platform> (consumed via optionalDependencies).
// Run: npx tsx factory/dsh-worker/pack-runtime.ts [win32-x64]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RUNTIME = join(ROOT, 'factory', 'dsh-worker', 'deploy', 'runtime')
const WORKER_BIN = join('node_modules', '@deepseek-ai', 'dsh-factory-acp-worker', 'lib', 'bin.js')

const fail = (message: string): never => {
  process.stderr.write(`[pack-runtime] ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const platform = process.argv[2] ?? 'win32-x64'
  if (!existsSync(join(RUNTIME, WORKER_BIN))) {
    fail(`worker entry missing in provisioned closure (run provision-worker.ts first): ${join(RUNTIME, WORKER_BIN)}`)
  }
  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  let dshCommit = 'unknown'
  try {
    dshCommit = execFileSync('git', ['-C', join(ROOT, 'dsh'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { /* dsh checkout without git history */ }

  const out = join(ROOT, 'dist', `runtime-${platform}`)
  await rm(out, { recursive: true, force: true })
  await mkdir(join(out, 'runtime'), { recursive: true })
  // Copy the closure, pruning other platforms' native prebuilds.
  await cp(join(RUNTIME, 'node_modules'), join(out, 'runtime', 'node_modules'), {
    recursive: true,
    dereference: true,
    filter: path => {
      // cp supplies native separators; match with forward slashes.
      const lower = path.replace(/\\/g, '/').toLowerCase()
      if (lower.includes('/prebuilds/') || lower.endsWith('/prebuilds')) {
        // Keep the prebuilds dir itself plus this platform's subdirectory.
        return lower.includes(platform)
          || lower.endsWith('/prebuilds')
      }
      if (lower.includes('koffi-')) return lower.includes(`koffi-${platform}`)
      return true
    },
  })
  const prunedBin = join(out, 'runtime', WORKER_BIN)
  if (!existsSync(prunedBin)) fail(`worker entry lost to pruning (bug): ${prunedBin}`)

  const name = `@lab1207/wednesday-runtime-${platform}`
  await writeFile(join(out, 'package.json'), JSON.stringify({
    name,
    version: rootManifest.version,
    description: `Wednesday DSH execution floor (per-platform runtime closure, ${platform}).`,
    license: 'Apache-2.0',
    type: 'module',
    files: ['runtime/'],
  }, null, 2) + '\n')
  await writeFile(join(out, 'manifest.json'), JSON.stringify({
    package: name,
    version: rootManifest.version,
    platform,
    dshCommit,
    packedAt: new Date().toISOString(),
    workerBin: WORKER_BIN,
  }, null, 2) + '\n')
  process.stdout.write(`[pack-runtime] staged ${out}\n`)
}

void main().catch(error => {
  process.stderr.write(`[pack-runtime] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

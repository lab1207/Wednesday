import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DSH_ROOT, WORKER_DIRECTORY } from '../paths'

// Reuse DSH's required-peer traversal. Its CLI-preset checks do not apply
// to Wednesday, which boots the two YAML configurations checked below.
const { verifyRuntimeClosure } = await import(pathToFileURL(
  join(DSH_ROOT, 'scripts', 'verify-runtime-closure.ts'),
).href)
const manifestPath = join(WORKER_DIRECTORY, 'deploy', 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
// The workspace member is the deploy source; this git-visible copy must not drift.
const workspaceManifestPath = join(DSH_ROOT, 'apps', 'wednesday-runtime', 'package.json')
const workspaceManifest = JSON.parse(await readFile(workspaceManifestPath, 'utf8'))
assert.deepEqual(
  manifest.dependencies,
  workspaceManifest.dependencies,
  `deploy manifest drift: ${manifestPath} vs ${workspaceManifestPath}`,
)
const required = new Set([
  '@deepseek-ai/dsh-factory-acp-worker',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-session',
])
for (const file of ['host.cordis.yml', 'cordis.yml']) {
  const yaml = await readFile(join(WORKER_DIRECTORY, file), 'utf8')
  const names = [...yaml.matchAll(/^\s+name: ['"](@deepseek-ai\/[^'"]+)['"]\s*$/gm)]
  const rows = yaml.match(/^\s+name:/gm) ?? []
  assert.equal(names.length, rows.length, `${file}: unsupported plugin name syntax`)
  assert.ok(names.length > 0, `${file}: no plugins found`)
  for (const match of names) required.add(match[1])
}
for (const name of required) {
  assert.equal(manifest.dependencies[name], 'workspace:^', `missing host/worker dependency: ${name}`)
}
const peerFailures = async (path: string): Promise<string[]> => {
  const result = await verifyRuntimeClosure(DSH_ROOT, path)
  return result.failures.filter((failure: string) => failure.startsWith(`${manifest.name} -> `))
}
assert.deepEqual(await peerFailures(manifestPath), [], 'required workspace peers must be explicit')

const temporaryRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir()
await mkdir(temporaryRoot, { recursive: true })
const temporary = await mkdtemp(join(temporaryRoot, 'wednesday-closure-'))
try {
  const brokenPath = join(temporary, 'package.json')
  const dependencies = { ...manifest.dependencies }
  delete dependencies['@deepseek-ai/cordis']
  await writeFile(brokenPath, JSON.stringify({ ...manifest, dependencies }))
  const failures = await peerFailures(brokenPath)
  assert.ok(failures.some(failure => failure.endsWith(' -> @deepseek-ai/cordis')),
    'negative control: removing Cordis must fail')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log(`WEDNESDAY DEPLOY CLOSURE: PASS (${Object.keys(manifest.dependencies).length} direct dependencies; host/worker plugins; missing-peer rejection)`)

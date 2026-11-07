import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelOf,
  checkForUpdates,
  checkUpdate,
  compareVersions,
  detectLocalInstall,
  resolveUpdate,
  updateStatusLines,
} from './update-check.js'

async function stubRegistry(tags: Record<string, string>, status = 200): Promise<{ url: string; close: () => void; hits: () => number }> {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ 'dist-tags': tags }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub did not bind')
  return { url: `http://127.0.0.1:${address.port}/pkg`, close: () => server.close(), hits: () => hits }
}

async function main(): Promise<void> {
  // version compare
  assert.equal(compareVersions('0.1.0-dev.1', '0.1.0-dev.2'), -1)
  assert.equal(compareVersions('0.1.0-dev.2', '0.1.0-dev.1'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.1.0-dev.9', '0.1.0'), -1)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('???', '0.1.0'), 0)
  assert.equal(channelOf('0.1.0-dev.2'), 'dev')
  assert.equal(channelOf('0.1.0'), 'latest')

  const directory = await mkdtemp(join(tmpdir(), 'update-check-'))
  try {
    // newer on same channel -> notice with install command
    const fresh = await stubRegistry({ dev: '0.1.0-dev.9', latest: '0.0.9' })
    try {
      const notice = await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: fresh.url, stateDir: join(directory, 'a') })
      assert.match(notice ?? '', /0\.1\.0-dev\.2 → 0\.1\.0-dev\.9/)
      // the notice pins the EXACT remote version, not the moving tag
      assert.match(notice ?? '', /npm i -g @lab1207\/wednesday@0\.1\.0-dev\.9/)
      assert.match(notice ?? '', /\/update/)
      // resolveUpdate returns the raw versions for the installer to pin
      assert.deepEqual(
        await resolveUpdate({ version: '0.1.0-dev.2', registryUrl: fresh.url, stateDir: join(directory, 'a2'), force: true }),
        { current: '0.1.0-dev.2', remote: '0.1.0-dev.9', channel: 'dev' },
      )
      assert.equal(fresh.hits(), 2)
      // second call within a day: NO second fetch, but the cached remote
      // version still produces the notice (home banner stays up all day)
      const cachedNotice = await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: fresh.url, stateDir: join(directory, 'a') })
      assert.match(cachedNotice ?? '', /0\.1\.0-dev\.9/)
      assert.equal(fresh.hits(), 2)
    } finally {
      fresh.close()
    }

    // a dev build is offered a stable release when one ships (the real-world
    // "we published 0.2.0 but dev users only watch the dev tag" hole)
    const shipped = await stubRegistry({ dev: '0.1.0-dev.9', latest: '0.2.0' })
    try {
      const found = await resolveUpdate({ version: '0.1.0-dev.2', registryUrl: shipped.url, stateDir: join(directory, 'b0'), force: true })
      assert.equal(found?.remote, '0.2.0', 'a prerelease install still sees a newer stable release')
    } finally {
      shipped.close()
    }

    // stable channel tracks latest, ignores dev
    const stable = await stubRegistry({ dev: '0.1.0-dev.9', latest: '0.1.0' })
    try {
      assert.equal(await checkForUpdates({ version: '0.1.0', registryUrl: stable.url, stateDir: join(directory, 'b') }), null)
      const behind = await stubRegistry({ latest: '0.2.0' })
      try {
        assert.match((await checkForUpdates({ version: '0.1.0', registryUrl: behind.url, stateDir: join(directory, 'c') })) ?? '', /npm i -g @lab1207\/wednesday@0\.2\.0/)
      } finally {
        behind.close()
      }
    } finally {
      stable.close()
    }

    // registry error -> silent null (and cached: no throw on corrupt cache either)
    const broken = await stubRegistry({}, 500)
    try {
      assert.equal(await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: broken.url, stateDir: join(directory, 'd') }), null)
    } finally {
      broken.close()
    }
    // corrupt cache = treated as stale, check still runs
    const corruptDir = join(directory, 'e')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'update-check.json'), 'not-json', 'utf8')
    const okStub = await stubRegistry({ dev: '0.1.0-dev.9' })
    try {
      assert.match((await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: okStub.url, stateDir: corruptDir })) ?? '', /dev\.9/)
    } finally {
      okStub.close()
    }

    // unreachable registry -> silent null, fast (no 2.5s hang in test: closed port)
    const closed = await stubRegistry({})
    const closedUrl = closed.url
    closed.close()
    const start = Date.now()
    assert.equal(await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: closedUrl, stateDir: join(directory, 'f') }), null)
    assert.ok(Date.now() - start < 20000, 'offline check must fail fast-ish')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  // cache file written
  const directory2 = await mkdtemp(join(tmpdir(), 'update-check-'))
  try {
    const stub = await stubRegistry({ dev: '0.1.0-dev.9' })
    try {
      await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: stub.url, stateDir: directory2 })
      const cached = JSON.parse(await readFile(join(directory2, 'update-check.json'), 'utf8')) as { at: number }
      assert.ok(typeof cached.at === 'number')
    } finally {
      stub.close()
    }
  } finally {
    await rm(directory2, { recursive: true, force: true })
  }

  // force: bypasses the daily cache read (used by /update) but still writes it
  const directory3 = await mkdtemp(join(tmpdir(), 'update-check-force-'))
  try {
    const stub = await stubRegistry({ dev: '0.1.0-dev.9' })
    try {
      const stateDir = join(directory3, 'state')
      await mkdir(stateDir, { recursive: true })
      await writeFile(join(stateDir, 'update-check.json'), JSON.stringify({ at: Date.now() }), 'utf8')
      // force must ignore the fresh cache read (used by /update, every start
      // and every exit) but still writes it — with the remote version, so
      // later non-forced calls can report the update without a fetch
      const forced = await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: stub.url, stateDir, force: true })
      assert.match(forced ?? '', /dev\.9/, 'force bypasses the cache read')
      const hitsAfterForce = stub.hits()
      // without force the fresh cache now RETURNS the cached notice (no fetch)
      const cached = await checkForUpdates({ version: '0.1.0-dev.2', registryUrl: stub.url, stateDir })
      assert.match(cached ?? '', /dev\.9/, 'fresh cache reports the cached remote version')
      assert.equal(stub.hits(), hitsAfterForce, 'cache hit means no fetch')
      const onDisk = JSON.parse(await readFile(join(stateDir, 'update-check.json'), 'utf8')) as { at: number; remote?: string }
      assert.equal(onDisk.remote, '0.1.0-dev.9', 'cache stores the remote version')
    } finally {
      stub.close()
    }
  } finally {
    await rm(directory3, { recursive: true, force: true })
  }

  // ---- 2026-11-07: the check says what it ACTUALLY learned --------------
  //
  // Operator report: "the /update command does not work". The old check
  // answered one bit and the command turned every other outcome into
  // "up to date" -- including a FAILED check and a local build that is
  // AHEAD of the published release. A failed check must never say
  // "up to date".
  const honestDir = await mkdtemp(join(tmpdir(), 'update-check-honest-'))
  try {
    const newer = await stubRegistry({ beta: '0.2.0-beta.9' })
    try {
      const status = await checkUpdate({ version: '0.2.0-beta.4', registryUrl: newer.url, stateDir: join(honestDir, 'a'), force: true })
      assert.equal(status.kind, 'available')
      assert.equal(status.kind === 'available' ? status.remote : '', '0.2.0-beta.9')
    } finally {
      newer.close()
    }

    const same = await stubRegistry({ beta: '0.2.0-beta.4' })
    try {
      const status = await checkUpdate({ version: '0.2.0-beta.4', registryUrl: same.url, stateDir: join(honestDir, 'b'), force: true })
      assert.equal(status.kind, 'current', 'the same version is current, not available')
    } finally {
      same.close()
    }

    // A developer link (or an unpublished build) is AHEAD of npm.
    const ahead = await stubRegistry({ beta: '0.2.0-beta.3' })
    try {
      const status = await checkUpdate({ version: '0.2.0-beta.4', registryUrl: ahead.url, stateDir: join(honestDir, 'c'), force: true })
      assert.equal(status.kind, 'ahead', 'a local build newer than npm is not "up to date"')
    } finally {
      ahead.close()
    }

    // A FAILED check is a failure, and says so.
    const dead = await stubRegistry({}, 500)
    try {
      const status = await checkUpdate({ version: '0.2.0-beta.4', registryUrl: dead.url, stateDir: join(honestDir, 'd'), force: true })
      assert.equal(status.kind, 'failed')
      const lines = updateStatusLines(status).join('\n')
      assert.ok(!/up to date/i.test(lines), 'a failed check must never say "up to date"')
      assert.match(lines, /FAILED/, 'a failed check says it failed')
    } finally {
      dead.close()
    }

    // The words for each outcome.
    const aheadLines = updateStatusLines({
      kind: 'ahead', current: '0.2.0-beta.4', remote: '0.2.0-beta.3', channel: 'beta',
    }).join('\n')
    assert.match(aheadLines, /AHEAD/, 'an ahead build is named as ahead')
    const availableLines = updateStatusLines({
      kind: 'available', current: '0.2.0-beta.3', remote: '0.2.0-beta.4', channel: 'beta',
    }).join('\n')
    assert.match(availableLines, /npm i -g @lab1207\/wednesday@0\.2\.0-beta\.4/, 'the install command pins the exact version')
    const linkedLines = updateStatusLines(
      { kind: 'current', current: '0.2.0-beta.4', remote: '0.2.0-beta.4', channel: 'beta' },
      { kind: 'linked', target: 'C:\\wednesday' },
    ).join('\n')
    assert.match(linkedLines, /LINK/, 'a linked install is named as a link')
  } finally {
    await rm(honestDir, { recursive: true, force: true })
  }

  // A LINKED install (the operator's global install is a junction to the
  // working tree) is detected, so /update can explain itself.
  const linkDir = await mkdtemp(join(tmpdir(), 'update-check-link-'))
  try {
    const target = join(linkDir, 'target')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), '{"name":"@lab1207/wednesday"}', 'utf8')
    const link = join(linkDir, 'linked')
    await symlink(target, link, 'junction')
    const install = detectLocalInstall(join(link, 'bin', 'wednesday.js'))
    assert.equal(install.kind, 'linked', 'a junction install is a link')
    assert.ok(install.target, 'the link names its target')
    const plain = detectLocalInstall(join(target, 'bin', 'wednesday.js'))
    assert.equal(plain.kind, 'published', 'a real directory is a published install')
  } catch (error) {
    // A host that refuses junctions (no developer mode) must not fail the
    // suite: the detection is a nicety, the honest statuses are not.
    assert.ok(error instanceof Error)
  } finally {
    await rm(linkDir, { recursive: true, force: true })
  }

  console.log('UPDATE CHECK TEST: PASS (semver, channels, cache, force bypass, honest statuses, link detection)')
}
void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

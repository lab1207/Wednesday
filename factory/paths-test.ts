import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { INSTALL_ROOT } from './paths'

const temporaryRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : process.env.TMPDIR ?? '/tmp'
await mkdir(temporaryRoot, { recursive: true })
const directory = await mkdtemp(join(temporaryRoot, 'wednesday-portable-'))
try {
  const relocated = join(directory, 'Wednesday moved install')
  const workspace = join(directory, 'project with spaces')
  await mkdir(workspace, { recursive: true })
  await cp(join(INSTALL_ROOT, 'factory'), join(relocated, 'factory'), {
    recursive: true,
    filter: source => !source.endsWith('.jsonl') && !source.endsWith('tasks.json'),
  })
  await cp(join(INSTALL_ROOT, 'bin'), join(relocated, 'bin'), { recursive: true })
  await cp(join(INSTALL_ROOT, 'package.json'), join(relocated, 'package.json'))
  // Reuse installed dependencies only; no reference back to original Factory source.
  await symlink(join(INSTALL_ROOT, 'node_modules'), join(relocated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(relocated, 'dsh', '.agents'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), '{"name":"portability-proof"}')
  const stateHome = join(directory, 'profile state')
  const env = { ...process.env, FACTORY_EXECUTION_MODE: 'deterministic', WEDNESDAY_STATE_HOME: stateHome }
  for (const name of ['HERMES_TASKS_PATH', 'FACTORY_EVENTS_PATH', 'HARNESS_WORKSPACE', 'WEDNESDAY_DSH_HOME', 'FACTORY_CODER_PROVIDER']) delete env[name]
  const child = spawnSync(process.execPath, [join(relocated, 'bin', 'wednesday.js'),
    'Create portable.txt containing exactly PORTABLE_OK.', '--test',
    `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('portable.txt','utf8').trim(),'PORTABLE_OK')"`,
    '--required-file', 'portable.txt'], { cwd: workspace, env, input: 'y\n', encoding: 'utf8', timeout: 120000 })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.match(child.stdout, /task.completed/)
  assert.equal((await readFile(join(workspace, 'portable.txt'), 'utf8')).trim(), 'PORTABLE_OK')
  const store = JSON.parse(await readFile(join(stateHome, 'tasks.json'), 'utf8'))
  assert.equal(store.tasks.length, 1)
  assert.equal(store.tasks[0].engineeringTask.workspace, resolve(workspace))
  assert.equal(store.tasks[0].status, 'completed')
  const events = (await readFile(join(stateHome, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).type, 'task.completed')
  // Exercise first-use migration through the actual store/event entry points.
  const legacyTasks = join(relocated, 'factory', 'hermes', 'tasks.json')
  const legacyEvents = join(relocated, 'factory', 'events', 'factory-events.jsonl')
  await assert.rejects(readFile(legacyTasks), { code: 'ENOENT' })
  await assert.rejects(readFile(legacyEvents), { code: 'ENOENT' })
  const taskBytes = await readFile(join(stateHome, 'tasks.json'), 'utf8')
  const eventBytes = await readFile(join(stateHome, 'events.jsonl'), 'utf8')
  await writeFile(legacyTasks, taskBytes)
  await writeFile(legacyEvents, eventBytes)
  await rm(stateHome, { recursive: true })
  const migrationProbe = join(relocated, 'migration-probe.mts')
  await writeFile(migrationProbe, `
    import assert from 'node:assert/strict'
    import { loadStore } from './factory/hermes/store.ts'
    import { PersistentFactoryEventBus } from './factory/events/index.ts'
    import { EVENTS_PATH } from './factory/paths.ts'
    const store = await loadStore()
    assert.equal(store.tasks.length, 1)
    const events = await new PersistentFactoryEventBus({ filePath: EVENTS_PATH }).list()
    assert.equal(events.at(-1).type, 'task.completed')
  `)
  const runProbe = (extraEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', migrationProbe], {
    cwd: relocated, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000,
  })
  const migrated = runProbe()
  assert.equal(migrated.status, 0, migrated.stderr)
  assert.equal(await readFile(join(stateHome, 'tasks.json'), 'utf8'), taskBytes)
  assert.equal(await readFile(join(stateHome, 'events.jsonl'), 'utf8'), eventBytes)
  assert.equal(await readFile(legacyTasks, 'utf8'), taskBytes)
  assert.equal(await readFile(legacyEvents, 'utf8'), eventBytes)
  await writeFile(legacyTasks, 'broken legacy data')
  await writeFile(legacyEvents, 'broken legacy data')
  const existing = runProbe()
  assert.equal(existing.status, 0, existing.stderr)
  const explicitTasks = join(directory, 'explicit', 'nested', 'tasks.json')
  const explicitEvents = join(directory, 'explicit', 'nested', 'events.jsonl')
  await writeFile(migrationProbe, `
    import assert from 'node:assert/strict'
    import { loadStore, saveStore } from './factory/hermes/store.ts'
    import { PersistentFactoryEventBus } from './factory/events/index.ts'
    import { EVENTS_PATH } from './factory/paths.ts'
    const store = await loadStore()
    assert.equal(store.tasks.length, 0)
    await saveStore(store)
    assert.deepEqual(await new PersistentFactoryEventBus({ filePath: EVENTS_PATH }).list(), [])
  `)
  const explicit = runProbe({ HERMES_TASKS_PATH: explicitTasks, FACTORY_EVENTS_PATH: explicitEvents })
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.equal(JSON.parse(await readFile(explicitTasks, 'utf8')).tasks.length, 0)
  for (const invalid of ['broken', '{}', 'null']) {
    await writeFile(explicitTasks, invalid)
    const corrupted = runProbe({ HERMES_TASKS_PATH: explicitTasks, FACTORY_EVENTS_PATH: explicitEvents })
    assert.notEqual(corrupted.status, 0)
    assert.equal(await readFile(explicitTasks, 'utf8'), invalid)
  }
  const probe = join(relocated, 'probe.mts')
  await writeFile(probe, `import { DSH_ROOT, HOST, TASKS_PATH, EVENTS_PATH } from './factory/paths.ts'; console.log(JSON.stringify({DSH_ROOT, HOST, TASKS_PATH, EVENTS_PATH}))`)
  const paths = spawnSync(process.execPath, ['--import', 'tsx', probe], { cwd: relocated, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(paths.status, 0, paths.stderr)
  const actual = JSON.parse(paths.stdout)
  assert.equal(actual.DSH_ROOT, join(relocated, 'dsh'))
  assert.equal(actual.HOST, join(relocated, 'factory', 'dsh-worker', 'host.ts'))
  const overridden = spawnSync(process.execPath, ['--import', 'tsx', probe], {
    cwd: relocated, env: { ...env, WEDNESDAY_DSH_HOME: workspace, HERMES_TASKS_PATH: join(directory, 'override.json'), FACTORY_EVENTS_PATH: join(directory, 'override.jsonl') }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(overridden.status, 0, overridden.stderr)
  assert.deepEqual(JSON.parse(overridden.stdout), { DSH_ROOT: workspace, HOST: actual.HOST, TASKS_PATH: join(directory, 'override.json'), EVENTS_PATH: join(directory, 'override.jsonl') })
  console.log('PORTABLE PATHS TEST: PASS (relocated source, spaces, separate cwd, default state, exact artifact, overrides)')
} finally {
  await rm(directory, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyLegacyState } from './state-migration'

const base = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir()
await mkdir(base, { recursive: true })
const directory = await mkdtemp(join(base, 'wednesday-state-'))
try {
  const source = join(directory, 'legacy.json')
  const destination = join(directory, 'new profile', 'state', 'tasks.json')
  const raw = '\uFEFF' + JSON.stringify({ tasks: [{ id: 'preserved' }], updatedAt: 'legacy' }) + '\n'
  await copyLegacyState(source, destination, 'tasks')
  await assert.rejects(readFile(destination), { code: 'ENOENT' })
  await writeFile(source, raw)
  await copyLegacyState(source, destination, 'tasks')
  assert.equal(await readFile(destination, 'utf8'), raw)
  assert.equal(await readFile(source, 'utf8'), raw)
  await writeFile(source, 'broken legacy data')
  await copyLegacyState(source, destination, 'tasks')
  assert.equal(await readFile(destination, 'utf8'), raw)
  const invalidDestination = join(directory, 'invalid', 'tasks.json')
  for (const invalid of ['broken', '{}', 'null']) {
    await writeFile(source, invalid)
    await assert.rejects(copyLegacyState(source, invalidDestination, 'tasks'))
    await assert.rejects(readFile(invalidDestination), { code: 'ENOENT' })
  }
  const events = '{"id":"event-1","taskId":"preserved","type":"task.completed"}\r\n'
  const eventDestination = join(directory, 'new profile', 'state', 'events.jsonl')
  await writeFile(source, events)
  await copyLegacyState(source, eventDestination, 'events')
  assert.equal(await readFile(eventDestination, 'utf8'), events)
  assert.equal(await readFile(source, 'utf8'), events)
  await writeFile(source, events + 'broken\n')
  await assert.rejects(copyLegacyState(source, join(directory, 'invalid-events.jsonl'), 'events'))
  await copyLegacyState(source, source, 'events')
  const directorySource = join(directory, 'directory-source')
  await mkdir(directorySource)
  await assert.rejects(copyLegacyState(directorySource, join(directory, 'unreadable.json'), 'tasks'))
  console.log('STATE MIGRATION TEST: PASS (missing legacy, nested destination, byte preservation, no overwrite, invalid/unreadable data refused)')
} finally {
  await rm(directory, { recursive: true, force: true })
}

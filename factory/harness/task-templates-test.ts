/**
 * Offline test for the task template store: save/load roundtrip, duplicate
 * name replacement, lookup by name and by id, delete, usage counters, and
 * corrupt-file tolerance. No network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Point STATE_HOME at a temp dir BEFORE the module under test is imported:
// factory/paths.ts captures STATE_HOME at import time.
const stateHome = mkdtempSync(join(tmpdir(), 'wednesday-task-templates-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const {
  templatesFile,
  loadTemplates,
  saveTemplate,
  updateTemplate,
  deleteTemplate,
  markTemplateUsed,
  findTemplate,
} = await import('./task-templates')

async function main(): Promise<void> {
  // 1. Empty store.
  assert.deepEqual(loadTemplates(), [])

  // 2. The file lives under the temp state home, never in the repo.
  const file = templatesFile()
  assert.ok(file.includes('templates.json'), `file is templates.json, got ${file}`)
  assert.ok(file.startsWith(stateHome), `file is under the temp state home, got ${file}`)

  // 3. Save + load roundtrip.
  const saved = saveTemplate({
    name: 'nightly-checks',
    request: 'run the nightly checks',
    flags: { test: 'npm test', 'required-file': 'src/a.ts' },
    workspace: 'C:\\workspace\\alpha',
  })
  assert.ok(saved.id)
  assert.equal(typeof saved.createdAt, 'number')
  assert.equal(saved.name, 'nightly-checks')
  assert.equal(saved.request, 'run the nightly checks')
  assert.deepEqual(saved.flags, { test: 'npm test', 'required-file': 'src/a.ts' })
  assert.equal(saved.workspace, 'C:\\workspace\\alpha')

  const loaded = loadTemplates()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, saved.id)
  assert.equal(loaded[0].request, 'run the nightly checks')
  assert.equal(loaded[0].flags?.test, 'npm test')
  assert.ok(existsSync(file), 'the store file was written')

  // 4. A duplicate name REPLACES the template (same id), not a second row.
  const replaced = saveTemplate({ name: 'nightly-checks', request: 'run the nightly checks again' })
  assert.equal(replaced.id, saved.id, 'the duplicate keeps the original id')
  assert.equal(replaced.createdAt, saved.createdAt, 'the duplicate keeps the original creation time')
  assert.equal(replaced.request, 'run the nightly checks again')
  assert.equal(loadTemplates().length, 1, 'no second template with the same name')

  // 5. Find by name (case-insensitive) and by id.
  const byName = findTemplate('Nightly-Checks')
  assert.ok(byName, 'found by name')
  assert.equal(byName?.id, saved.id)
  const byId = findTemplate(saved.id)
  assert.ok(byId, 'found by id')
  assert.equal(byId?.name, 'nightly-checks')
  assert.equal(findTemplate('nope'), null, 'unknown name finds nothing')
  assert.equal(findTemplate('unknown-id'), null, 'unknown id finds nothing')

  // 6. Update.
  const updated = updateTemplate(saved.id, { request: 'run the nightly checks once more' })
  assert.ok(updated)
  assert.equal(updated?.request, 'run the nightly checks once more')
  assert.equal(loadTemplates()[0].request, 'run the nightly checks once more')
  assert.equal(updateTemplate('missing-id', { request: 'x' }), null, 'unknown id updates nothing')

  // 7. Usage counters.
  markTemplateUsed(saved.id)
  const afterOne = loadTemplates()[0]
  assert.equal(afterOne.useCount, 1)
  assert.equal(typeof afterOne.lastUsedAt, 'number')
  markTemplateUsed(saved.id)
  const afterTwo = loadTemplates()[0]
  assert.equal(afterTwo.useCount, 2)
  assert.ok((afterTwo.lastUsedAt ?? 0) >= (afterOne.lastUsedAt ?? 0))
  markTemplateUsed('missing-id')

  // 8. Delete.
  assert.equal(deleteTemplate(saved.id), true)
  assert.deepEqual(loadTemplates(), [])
  assert.equal(deleteTemplate(saved.id), false, 'deleting twice reports nothing removed')

  // 9. A corrupt file reads as empty and is left alone on disk.
  const corrupt = '{ this is not json'
  writeFileSync(file, corrupt, 'utf8')
  assert.deepEqual(loadTemplates(), [], 'a corrupt file reads as empty')
  assert.equal(readFileSync(file, 'utf8'), corrupt, 'the corrupt file was left untouched')

  rmSync(stateHome, { recursive: true, force: true })
  console.log('task-templates: PASS')
}

main().catch((err) => { console.error(err); process.exit(1) })

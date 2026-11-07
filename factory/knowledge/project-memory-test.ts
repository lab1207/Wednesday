/**
 * Offline test for project memory: per-workspace storage, case-insensitive
 * upsert, forget, corrupt-file tolerance, the rendered block and its cap,
 * and the adapter card. No network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

// Point STATE_HOME at a temp dir BEFORE the module under test is imported:
// factory/paths.ts captures STATE_HOME at import time.
const stateHome = mkdtempSync(join(tmpdir(), 'wednesday-project-memory-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const {
  memoryDir,
  memoryFile,
  loadProjectMemory,
  rememberFact,
  forgetFact,
  renderProjectMemory,
  ProjectMemoryAdapter,
  PROJECT_MEMORY_SKILL_NAME,
} = await import('./project-memory')

const WORKSPACE_A = 'C:\\workspace\\alpha'
const WORKSPACE_B = 'C:\\workspace\\beta'

async function main(): Promise<void> {
  // 1. Storage layout: hashed directory under the state home, no raw path.
  assert.equal(memoryDir(), join(stateHome, 'project-memory'))
  const file = memoryFile(WORKSPACE_A)
  assert.ok(file.startsWith(memoryDir()), 'memory file lives under the memory dir')
  assert.ok(file.endsWith(join('memory.json')), 'memory file is memory.json')
  const hashDir = file.split(sep).slice(-2, -1)[0] ?? ''
  assert.match(hashDir, /^[0-9a-f]{40}$/, 'the directory is a sha1 hash, not a raw path')
  assert.ok(!file.includes('alpha'), 'the raw workspace path is not in the filename')

  // 2. Remember + load roundtrip.
  const empty = loadProjectMemory(WORKSPACE_A)
  assert.deepEqual(empty.facts, [])
  assert.equal(empty.updatedAt, 0)

  const remembered = rememberFact(WORKSPACE_A, 'test command', 'npm test')
  assert.equal(remembered.facts.length, 1)
  assert.equal(remembered.facts[0].key, 'test command')
  assert.equal(remembered.facts[0].value, 'npm test')
  assert.ok(existsSync(memoryFile(WORKSPACE_A)), 'the memory file was written')

  const loaded = loadProjectMemory(WORKSPACE_A)
  assert.equal(loaded.facts.length, 1)
  assert.equal(loaded.facts[0].value, 'npm test')
  assert.ok(loaded.updatedAt > 0)

  // 3. Upsert: same key, different case, replaces the value.
  const upserted = rememberFact(WORKSPACE_A, 'TEST COMMAND', 'npm run test:unit')
  assert.equal(upserted.facts.length, 1, 'the case-insensitive key is the same fact')
  assert.equal(upserted.facts[0].value, 'npm run test:unit')
  assert.equal(loadProjectMemory(WORKSPACE_A).facts.length, 1)

  // 4. Two workspaces do not share memory.
  rememberFact(WORKSPACE_B, 'test command', 'pytest')
  assert.equal(loadProjectMemory(WORKSPACE_A).facts[0].value, 'npm run test:unit')
  assert.equal(loadProjectMemory(WORKSPACE_B).facts[0].value, 'pytest')
  assert.notEqual(memoryFile(WORKSPACE_A), memoryFile(WORKSPACE_B))

  // 5. Render: header + fact lines.
  const rendered = renderProjectMemory(WORKSPACE_A)
  assert.ok(rendered.startsWith('PROJECT MEMORY (this workspace):'), `header present, got: ${rendered}`)
  assert.ok(rendered.includes('- test command: npm run test:unit'), `fact line present, got: ${rendered}`)

  // 6. Render of an empty workspace.
  assert.equal(renderProjectMemory('C:\\workspace\\empty'), 'PROJECT MEMORY: none yet')

  // 7. Render respects maxChars and says so when it cuts.
  rememberFact(WORKSPACE_A, 'lint', 'npm run lint')
  rememberFact(WORKSPACE_A, 'build', 'npm run build --if-present')
  const capped = renderProjectMemory(WORKSPACE_A, 60)
  assert.ok(capped.length <= 60, `cap holds, got ${capped.length}`)
  assert.ok(capped.includes('truncated'), `the cut is announced, got: ${capped}`)
  assert.ok(capped.startsWith('PROJECT MEMORY (this workspace):'), 'the header survives the cut')

  // A cap too small for the full header still honours the cap AND the promise.
  for (const tight of [30, 42, 20, 11, 5]) {
    const tightRender = renderProjectMemory(WORKSPACE_A, tight)
    assert.ok(tightRender.length <= tight, `cap ${tight} holds, got ${tightRender.length}`)
    assert.ok(
      tightRender.includes('truncat') || tightRender.includes('cut'),
      `cap ${tight} still announces the cut, got: ${tightRender}`,
    )
  }

  // 8. Forget removes the fact, and reports when there was nothing to remove.
  assert.equal(forgetFact(WORKSPACE_A, 'lint'), true)
  assert.equal(loadProjectMemory(WORKSPACE_A).facts.some(f => f.key === 'lint'), false)
  assert.equal(forgetFact(WORKSPACE_A, 'lint'), false, 'forgetting twice reports nothing removed')

  // 9. A corrupt file reads as empty and is left alone on disk.
  const corrupt = '{ not json at all'
  writeFileSync(memoryFile(WORKSPACE_B), corrupt, 'utf8')
  const recovered = loadProjectMemory(WORKSPACE_B)
  assert.deepEqual(recovered.facts, [])
  assert.equal(recovered.updatedAt, 0)
  assert.equal(readFileSync(memoryFile(WORKSPACE_B), 'utf8'), corrupt, 'the corrupt file was left untouched')

  // 10. The adapter: one card, load returns the rendered memory.
  const adapter = new ProjectMemoryAdapter()
  const listed = await adapter.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'project:memory')
  assert.equal(listed[0].name, PROJECT_MEMORY_SKILL_NAME)
  assert.equal(listed[0].invocation.modelInvocable, true)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.ok((listed[0].whenToUse ?? '').includes('already learned'), 'whenToUse names the learned facts')
  assert.ok((listed[0].whenToUse ?? '').includes('this workspace'), 'whenToUse names the workspace')

  const skill = await adapter.load('project:memory')
  assert.ok(skill)
  assert.equal(skill?.name, 'project:memory')
  assert.equal(skill?.source, 'project-memory')
  assert.equal(skill?.provider, 'wednesday')
  assert.ok((skill?.content.length ?? 0) <= 4000, `the loaded memory is capped, got ${skill?.content.length}`)
  // The current workspace (process.cwd()) is what the adapter renders.
  rememberFact(process.cwd(), 'current workspace fact', 'present')
  const current = await adapter.load('project:memory')
  assert.ok((current?.content ?? '').includes('- current workspace fact: present'), 'the current workspace is rendered')

  assert.equal(await adapter.load('project:nope'), undefined, 'a miss returns nothing')

  rmSync(stateHome, { recursive: true, force: true })
  console.log('project-memory: PASS')
}

main().catch((err) => { console.error(err); process.exit(1) })

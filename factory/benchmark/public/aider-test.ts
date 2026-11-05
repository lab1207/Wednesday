/**
 * Offline test for the Aider-polyglot public-bench adapter. No model:
 * proves payload roundtrip, workspace setup (stubs visible, tests hidden),
 * red grading (stub fails), green grading (canonical example passes) and
 * the missing-dataset error path. Real-dataset checks run only when
 * POLYGLOT_ROOT is set (fetched at setup, gitignored).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AIDER_GRADE_FILE,
  createAiderAdapter,
  decodePayload,
  encodePayload,
  setupAiderWorkspace,
  type AiderPayload,
} from './aider'

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  // 1. Payload roundtrip.
  const payload: AiderPayload = {
    language: 'python',
    slug: 'demo',
    solutionFiles: ['demo.py'],
    testFiles: [{ path: 'demo_test.py', content: 'x' }],
    gradeCommand: 'python -m unittest demo_test',
  }
  assert.deepEqual(decodePayload(encodePayload(payload)), payload)

  // 2. Missing dataset root is a hard error.
  assert.throws(() => createAiderAdapter(''), /dataset root required/)

  // 3. Real dataset (only when fetched at setup).
  const root = process.env.POLYGLOT_ROOT?.trim()
  if (!root) {
    console.log('AIDER ADAPTER TEST: PASS (synthetic only; POLYGLOT_ROOT unset)')
    return
  }
  const adapter = createAiderAdapter(root)
  const problems = await adapter.listProblems()
  const py = problems.filter(p => p.id.startsWith('aider/python/'))
  const rs = problems.filter(p => p.id.startsWith('aider/rust/'))
  assert.ok(py.length > 0, 'expected python exercises')
  assert.ok(rs.length > 0, 'expected rust exercises')
  console.log(`  dataset: ${py.length} python + ${rs.length} rust exercises`)

  const temp = await mkdtemp(join(tmpdir(), 'aider-adapter-'))
  try {
    for (const problem of [py[0], rs[0]]) {
      const p = decodePayload(problem.test)
      assert.ok(problem.objective.includes('grade_aider.py'))
      const ws = join(temp, p.slug)
      await setupAiderWorkspace(ws, problem)
      // Stubs + instructions visible; tests hidden; grader present.
      for (const solution of p.solutionFiles) {
        assert.ok(await exists(join(ws, solution)), `missing stub ${solution}`)
      }
      assert.ok(await exists(join(ws, 'instructions.md')))
      assert.ok(await exists(join(ws, AIDER_GRADE_FILE)))
      for (const test of p.testFiles) {
        assert.ok(!(await exists(join(ws, test.path))), `test leaked: ${test.path}`)
      }
      // RED: stub fails the board tests.
      const red = await adapter.grade(ws, problem)
      assert.equal(red.passed, false, `stub unexpectedly passed ${problem.id}: ${red.detail}`)
      assert.ok(red.detail.length > 0)
      // GREEN: canonical example passes the board tests.
      const exerciseDir = join(root, p.language, 'exercises', 'practice', p.slug)
      const ext = p.language === 'python' ? '.py' : '.rs'
      const names = await readdir(join(exerciseDir, '.meta'))
      const example = names.find(n => n.startsWith('example') && n.endsWith(ext))
      assert.ok(example, `no canonical example for ${problem.id}`)
      const canonical = await readFile(join(exerciseDir, '.meta', example), 'utf8')
      for (const solution of p.solutionFiles) {
        await writeFile(join(ws, solution), canonical, 'utf8')
      }
      const green = await adapter.grade(ws, problem)
      assert.equal(green.passed, true, `canonical failed ${problem.id}: ${green.detail}`)
      console.log(`  green/red: PASS (${problem.id})`)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  console.log('AIDER ADAPTER TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

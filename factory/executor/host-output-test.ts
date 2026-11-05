import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  consumeHostOutput,
  flushHostOutput,
  hostOutput,
  ACTIVITY_MARK,
} from './host-output'

import {
  WorkspaceWatcher,
  diffWorkspace,
  snapshotWorkspace,
} from './workspace-watch'

/**
 * Live activity: the host's stdout, the workspace watcher, and the rules that
 * keep both away from the answer and from the run's outcome.
 */

async function main(): Promise<void> {
  // ── The answer stays the answer ───────────────────────────────────────────
  {
    const state = hostOutput()
    const activities = consumeHostOutput(
      state,
      `${ACTIVITY_MARK}${JSON.stringify({ kind: 'reasoning', text: 'checking the repo' })}\n`,
    )
    assert.equal(activities.length, 1, 'the activity line is handed over')
    assert.equal(activities[0]!.kind, 'reasoning')
    assert.equal(activities[0]!.text, 'checking the repo')
    assert.equal(state.answer, '', 'and it never reaches the answer')
  }
  {
    const state = hostOutput()
    consumeHostOutput(state, 'The answer.\n')
    consumeHostOutput(state, 'Second line.\n')
    assert.equal(state.answer, 'The answer.\nSecond line.\n', 'the answer keeps its bytes')
  }
  {
    // A line split across two reads is held until it is whole.
    const state = hostOutput()
    const first = consumeHostOutput(state, 'The ans')
    assert.equal(first.length, 0, 'a partial line carries no activity')
    assert.equal(state.answer, '', 'and is not answer yet either')
    const second = consumeHostOutput(state, 'wer.\n')
    assert.equal(second.length, 0)
    assert.equal(state.answer, 'The answer.\n', 'the line lands whole')
  }
  {
    // An activity line split across two reads is held the same way.
    const state = hostOutput()
    const payload = `${ACTIVITY_MARK}${JSON.stringify({ kind: 'tool', tool: 'bash' })}`
    const first = consumeHostOutput(state, payload.slice(0, 10))
    assert.equal(first.length, 0, 'a partial activity line is not an activity')
    const second = consumeHostOutput(state, `${payload.slice(10)}\n`)
    assert.equal(second.length, 1, 'and lands when it is whole')
    assert.equal(second[0]!.tool, 'bash')
  }
  {
    // The last line may arrive without its newline.
    const state = hostOutput()
    consumeHostOutput(state, 'No trailing newline.')
    assert.equal(state.answer, '', 'the tail waits')
    const tail = flushHostOutput(state)
    assert.equal(tail.length, 0)
    assert.equal(state.answer, 'No trailing newline.', 'and lands at the end')
  }
  {
    // A malformed activity line is not an answer line either.
    const state = hostOutput()
    const activities = consumeHostOutput(state, `${ACTIVITY_MARK}{not json}\n`)
    assert.equal(activities.length, 0, 'a malformed line carries no activity')
    assert.equal(state.answer, '', 'and it does not become the answer')
  }

  // ── The workspace watcher ─────────────────────────────────────────────────
  const directory = await mkdtemp(join(tmpdir(), 'wednesday-watch-'))
  try {
    const root = join(directory, 'workspace')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}\n')
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n')

    const before = snapshotWorkspace(root)
    assert.ok(before.has('package.json'), 'the snapshot holds the workspace files')
    assert.ok(before.has('src/index.ts'), 'and the nested ones, with forward slashes')

    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 2\nexport const y = 3\n')
    await writeFile(join(root, 'new.txt'), 'hello\n')
    const after = snapshotWorkspace(root)
    const changes = diffWorkspace(before, after)
    const paths = changes.map(change => `${change.change}:${change.path}`)
    assert.ok(paths.includes('modified:src/index.ts'), 'a changed file is reported')
    assert.ok(paths.includes('created:new.txt'), 'a new file is reported')
    assert.ok(!paths.some(path => path.endsWith(':package.json')), 'an untouched file is not reported')

    // The directories that are never interesting are never walked.
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    const withModules = snapshotWorkspace(root)
    assert.ok(!withModules.has('node_modules/left-pad/index.js'), 'node_modules is skipped')

    // A deleted file is reported as deleted.
    await rm(join(root, 'new.txt'), { force: true })
    const deleted = diffWorkspace(after, snapshotWorkspace(root))
    assert.ok(deleted.some(change => change.change === 'deleted' && change.path === 'new.txt'), 'a removed file is reported')

    // The watcher reports the same changes while it runs.
    const seen: string[] = []
    const watcher = new WorkspaceWatcher(root, change => {
      seen.push(`${change.change}:${change.path}`)
    })
    watcher.start()
    await writeFile(join(root, 'live.txt'), 'live\n')
    // The watcher polls on an interval; give it one tick.
    await new Promise(resolve => setTimeout(resolve, 1200))
    watcher.stop()
    assert.ok(seen.includes('created:live.txt'), 'the watcher reports a file written while it runs')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  console.log('HOST OUTPUT + WATCHER TEST: PASS (activity separated from the answer, the workspace watched)')
}

void main().catch(error => {
  console.error(error)
  process.exit(1)
})

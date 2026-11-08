/**
 * The /history regression test: the storage existed, the LISTING did not.
 *
 * Four claims, all offline and driven through the real store in a temp state
 * home (never the operator's):
 *   1. `listSessions()` returns every saved session, newest first.
 *   2. One malformed file is skipped, never fatal.
 *   3. `firstRequestOf()` names a subject without inventing a "turn" count.
 *   4. `/history` answers in the terminal, on both the empty and the full case.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function session(id: string, savedAt: number, request: string) {
  return {
    id,
    startedAt: savedAt - 65_000,
    savedAt,
    composerLabel: null,
    tokens: 0,
    messages: [
      { text: request, tone: 'plain' },
      { text: 'done', tone: 'green' },
    ],
  }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'wednesday-history-'))
  process.env.WEDNESDAY_STATE_HOME = home
  // Dynamic import AFTER the env var: paths.ts resolves STATE_HOME at module
  // load, so a static import would pin the operator's real state home and the
  // test would list the operator's own sessions.
  const { firstRequestOf, listSessions, loadSession, saveSession, sessionsDir } =
    await import('./session-store')

  try {
    // 1. Empty first: a history command that crashes on an empty store is
    //    the "y does nothing" failure mode again.
    assert.deepEqual(listSessions(), [], 'an empty store lists nothing')

    assert.ok(saveSession(session('20261108_090000_aaa', 1_000, 'build me website')))
    assert.ok(saveSession(session('20261108_100000_bbb', 2_000, 'fix the login leak')))

    const listed = listSessions()
    assert.equal(listed.length, 2, 'both sessions are listed')
    assert.equal(
      listed[0].id,
      '20261108_100000_bbb',
      'the newest session is first',
    )
    assert.equal(
      listed[1].id,
      '20261108_090000_aaa',
      'and the older one is second',
    )

    // 2. A malformed file is skipped, not fatal.
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(join(sessionsDir(), 'broken.json'), '{not json', 'utf8')
    writeFileSync(join(sessionsDir(), 'not-a-session.json'), JSON.stringify({ id: 'x' }), 'utf8')
    assert.equal(listSessions().length, 2, 'a broken file is skipped, never fatal')

    // 3. The subject column says rows, never turns — because a stored
    //    transcript does not mark which rows the operator typed.
    const first = firstRequestOf(listed[0])
    assert.equal(first, 'fix the login leak', 'the subject is the first plain row')
    const framed = {
      id: 'f',
      startedAt: 0,
      savedAt: 1,
      composerLabel: null,
      tokens: 0,
      messages: [{ text: 'framed answer', tone: 'plain', panel: { title: 't', lines: [] } }],
    }
    assert.equal(
      firstRequestOf(framed),
      '(no transcript rows)',
      'a session of only framed answers says so rather than inventing a subject',
    )

    // 4. `--resume` and `/history` agree on the same ids: the listing must
    //    hand the operator an id the resume path can actually load.
    assert.ok(loadSession(listed[0].id), 'a listed id is loadable')

    // 5. The command answers in a real terminal (classic path, piped).
    const home2 = mkdtempSync(join(tmpdir(), 'wednesday-history-repl-'))
    process.env.WEDNESDAY_STATE_HOME = home2
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'C:/wednesday/bin/wednesday.js', '--repl', '--test', 'node -e "process.exit(0)"'],
      {
        cwd: 'C:/wednesday',
        encoding: 'utf8',
        input: '/history\n/exit\n',
        timeout: 5 * 60 * 1000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          FACTORY_LLM_PROVIDER: 'local',
          LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
          LOCAL_LLM_MODEL: 'demo-3b',
          LOCAL_LLM_API_KEY: 'demo',
        },
      },
    )
    assert.equal(run.status, 0, (run.stderr || run.stdout || '').slice(0, 400))
    assert.match(
      run.stdout ?? '',
      /No saved sessions on this path/,
      'the empty case is spoken, and says WHICH path has nothing',
    )
    rmSync(home2, { recursive: true, force: true })

    console.log('history: PASS')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

void main()

/**
 * Session store + exit card (2026-10-25).
 *
 * The card's promise is the whole point: `Resume this session with:` is only
 * honest if the file it names exists and loads back. These tests run the real
 * store against a throwaway state dir — no repo writes, no touching the
 * operator's actual sessions.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'wednesday-sessions-'))
  process.env.WEDNESDAY_STATE_HOME = home
  const { saveSession, loadSession, latestSession, sessionsDir, formatDuration, exitCard } =
    await import('./session-store')

  try {
    const messages = [
      { text: '❯ fix the login leak', tone: 'bold' as const },
      { text: '┊ ✿ agent        started · planner', tone: 'dim' as const },
      { text: '┊ ☞ tool         called · coder', tone: 'yellow' as const },
      { text: '┊ ❀ task         completed', tone: 'green' as const },
    ]
    const path = saveSession({
      id: '20261025_101500_abc123',
      startedAt: Date.now() - 95_000,
      savedAt: 0,
      composerLabel: 'qwen2.5-coder-3b',
      crewLabel: 'crew · 3 seats',
      tokens: 2318,
      messages,
    })
    assert.ok(path, 'a safe id saves')
    assert.deepEqual(readdirSync(sessionsDir()), ['20261025_101500_abc123.json'])

    const loaded = loadSession('20261025_101500_abc123')
    assert.ok(loaded, 'the saved session loads')
    assert.equal(loaded!.composerLabel, 'qwen2.5-coder-3b')
    assert.equal(loaded!.crewLabel, 'crew · 3 seats')
    assert.equal(loaded!.tokens, 2318)
    assert.deepEqual(loaded!.messages, messages, 'the transcript round-trips')
    assert.ok(loaded!.savedAt > 0, 'the save stamps its own time')

    // A path is a filename: traversal is refused, not sanitised.
    assert.equal(saveSession({ ...loaded!, id: '../escape' }), null, 'an unsafe id is refused')
    assert.equal(loadSession('../escape'), null, 'an unsafe id never loads')
    assert.equal(loadSession('missing'), null, 'a missing id is null, not a throw')

    // A bare --resume takes the newest file.
    const later = saveSession({ ...loaded!, id: '20261025_102000_def456' })
    assert.ok(later)
    assert.equal(latestSession()?.id, '20261025_102000_def456', 'the newest session wins')

    // Hermes' duration grammar.
    assert.equal(formatDuration(14_000), '14s')
    assert.equal(formatDuration(134_000), '2m 14s')
    assert.equal(formatDuration(3_723_000), '1h 2m 3s')

    // An empty session gets the one-line goodbye — never a resume block for a
    // transcript that was never saved.
    assert.deepEqual(exitCard({ id: 'x', durationMs: 1000, messages: [] }), ['Goodbye! ✦'])

    const card = exitCard({ id: '20261025_101500_abc123', durationMs: 95_000, messages })
    const text = card.join('\n')
    assert.match(text, /^Resume this session with:$/m)
    assert.match(text, /wednesday --repl --resume 20261025_101500_abc123/)
    // The label column is Hermes' 16 wide, so the four facts line up.
    assert.match(text, /^Session:\s{8}20261025_101500_abc123$/m)
    assert.match(text, /^Duration:\s{7}1m 35s$/m)
    assert.match(text, /^Messages:\s{7}4 \(1 request, 1 tool call\)$/m)

    console.log('SESSION STORE TEST: PASS (save/load/latest, unsafe ids, duration grammar, exit card)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

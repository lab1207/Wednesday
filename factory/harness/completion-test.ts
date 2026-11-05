/**
 * Offline tests for the composer completion engine.
 *
 * Pure: no terminal, no filesystem, no clock. The engine decides what is
 * being completed and what the candidates are; the screen draws them.
 */
import assert from 'node:assert/strict'

import {
  acceptedGhostText,
  acceptedText,
  atTokenAt,
  clampActive,
  COMPLETION_LIMIT,
  completionFor,
  fuzzyScore,
  moveActive,
  rankCommands,
  rankFiles,
  slashTokenAt,
  type CommandSpec,
} from './completion'

const COMMANDS: CommandSpec[] = [
  { name: '/model', desc: 'every model — assign it a role' },
  { name: '/status', desc: 'route · model · pool · shape' },
  { name: '/stats', desc: 'token usage for this session' },
  { name: '/tasks', desc: 'list persisted tasks', argHint: '<id>' },
  { name: '/crew', desc: 'list · select · edit · delete teams' },
  { name: '/doctor', desc: 'readiness check (read-only)' },
  { name: '/help', desc: 'this page' },
]

async function main(): Promise<void> {
  // 1. The fuzzy scorer: a SUBSEQUENCE matches, a scattered one does not.
  {
    assert.equal(fuzzyScore('model', 'model'), 1000, 'an exact match scores highest')
    assert.equal(fuzzyScore('mod', '/model'), null === fuzzyScore('mod', '/model') ? null : fuzzyScore('mod', '/model'), 'scoring is deterministic')
    assert.notEqual(fuzzyScore('mdl', 'model'), null, 'mdl finds model — a subsequence match')
    assert.equal(fuzzyScore('zzz', 'model'), null, 'a query with no match does not match')
    assert.notEqual(fuzzyScore('mo', 'model'), null)
    const prefix = fuzzyScore('mo', 'model')!
    const scattered = fuzzyScore('mo', 'm-o-d-e-l')!
    assert.ok(prefix > scattered, 'a prefix beats a scattered match')
    const short = fuzzyScore('model', 'model')!
    const long = fuzzyScore('model', 'model-port')!
    assert.ok(short > long, 'the shorter candidate wins a tie')
    // A word-boundary hit is worth more than one inside a word.
    const boundary = fuzzyScore('md', 'my-model')!
    const inside = fuzzyScore('md', 'nomad')!
    assert.ok(boundary > inside, 'a word-start hit beats one inside a word')

    // pi's rule (MIT): a CONTIGUOUS occurrence beats a scattered one, even
    // when the scattered one comes first in the text. The greedy alignment
    // alone would take the letters from the wrong part of the candidate.
    const contiguous = fuzzyScore('opus', 'opqqqopus')!
    const scatteredHit = fuzzyScore('opus', 'oxpxuxsx')!
    assert.ok(contiguous > scatteredHit, 'a contiguous occurrence beats a scattered one')

    // pi's alphanumeric swap: `opus4` also looks for `4opus`. The swap is a
    // guess, so a REAL match always wins.
    assert.notEqual(fuzzyScore('opus4', '4opus.ts'), null, 'an alphanumeric swap finds 4opus.ts')
    const real = fuzzyScore('opus4', 'opus4.ts')!
    const swapped = fuzzyScore('opus4', '4opus.ts')!
    assert.ok(real > swapped, 'a real match beats the swapped guess')
  }

  // 2. The slash token: a command is a command only where a command can be.
  {
    assert.deepEqual(slashTokenAt('/mo', 3), { start: 0, end: 3, token: 'mo' }, 'a line-start command is found')
    assert.deepEqual(slashTokenAt('/mo rest', 3), { start: 0, end: 3, token: 'mo' }, 'the token stops at the space')
    assert.deepEqual(slashTokenAt('hello /mo', 9), { start: 6, end: 9, token: 'mo' }, 'a command after whitespace is found')
    assert.equal(slashTokenAt('hello/mo', 8), null, 'a slash glued to a word is not a command')
    assert.equal(slashTokenAt('// comment', 5), null, 'a line comment is not a command')
    assert.equal(slashTokenAt('/* block', 4), null, 'a block comment is not a command')
    assert.equal(slashTokenAt('/usr/local', 10), null, 'a PATH is not a command')
    assert.equal(slashTokenAt('run C:/tools/x', 13), null, 'a WINDOWS path is not a command')
    assert.equal(slashTokenAt('/mo', 2), null, 'the caret must be at the END of the token')
    assert.equal(slashTokenAt('plain text', 5), null, 'prose has no token')
  }

  // 3. The @ token: a path, up to an unescaped space.
  {
    assert.deepEqual(atTokenAt('@src/ma', 6), { start: 1, end: 7, token: 'src/ma' }, 'a path token is found, without the @')
    assert.equal(atTokenAt('email@x', 7), null, 'an @ inside a word is not a path')
    const spaced = atTokenAt('@my\\ file.ts', 12)
    assert.equal(spaced?.token, 'my file.ts', 'an escaped space does not end the path')
    assert.equal(atTokenAt('@a b', 2)?.token, 'a', 'an unescaped space ends the path')
  }

  // 4. Ranking: the best match first, and recency breaks ties.
  {
    const ranked = rankCommands('mo', COMMANDS)
    assert.equal(ranked[0]?.value, '/model', 'the best match is first')
    assert.equal(ranked[0]?.kind, 'command')

    // Recency is a tie-break, never an override: a command that does not
    // match the query never surfaces, however often it was used.
    const withRecent = rankCommands('st', COMMANDS, ['/status', '/stats'])
    assert.ok(withRecent.some(item => item.value === '/status'), 'a recent command still matches')
    const notMatching = rankCommands('mo', COMMANDS, ['/status'])
    assert.ok(!notMatching.some(item => item.value === '/status'), 'a recent command that does not match never surfaces')

    // Among equals, the one used most recently comes first.
    const tie = rankCommands('st', COMMANDS, ['/stats'])
    assert.equal(tie[0]?.value, '/stats', 'the most recent of two equals comes first')
  }

  // 5. File ranking: the file name counts as much as the whole path.
  {
    const files = ['factory/harness/screen.ts', 'factory/harness/completion.ts', 'README.md']
    const ranked = rankFiles('completion', files)
    assert.equal(ranked[0]?.value, 'factory/harness/completion.ts', 'the file name match wins')
    assert.equal(rankFiles('zzz', files).length, 0, 'no match is no candidates')
    const fuzzy = rankFiles('scr', files)
    assert.equal(fuzzy[0]?.value, 'factory/harness/screen.ts', 'scr finds screen.ts')
  }

  // 5b. DIRECTORIES: pi's rule (MIT) — a folder is a candidate, it carries a
  // trailing `/`, and it wins over the files inside it while the operator is
  // still choosing the folder.
  {
    const files = ['factory/', 'factory/harness/screen.ts']
    const dir = rankFiles('factory', files)
    assert.equal(dir[0]?.value, 'factory/', 'the directory comes first')
    assert.equal(dir[0]?.kind, 'dir', 'the directory is a directory, not a file')
    // A folder whose name does not match never pollutes the list.
    const file = rankFiles('screen', files)
    assert.equal(file[0]?.value, 'factory/harness/screen.ts', 'the file still wins for its own name')
    assert.equal(file.length, 1, 'an unrelated directory is not offered')

    // Acceptance puts the trailing slash in and NO trailing space: the caret
    // lands after the slash, ready for the next path segment.
    const state = completionFor('@factory', 8, { commands: COMMANDS, files: () => files })!
    assert.equal(acceptedText('@factory', state), '@factory/', 'the directory keeps its slash')
  }

  // 6. The engine: a line-start command opens a PANEL.
  {
    const state = completionFor('/mo', 3, { commands: COMMANDS, files: () => [] })
    assert.ok(state, 'there is a completion')
    assert.equal(state?.panel, true, 'a line-start command opens the panel')
    assert.equal(state?.items[0]?.value, '/model')
    assert.equal(state?.start, 0)
    assert.equal(state?.end, 3)
    assert.equal(state?.exact, false, 'a partial command is not exact')
  }

  // 7. A mid-line command is GHOST TEXT, not a panel — qwen-code's rule.
  {
    const state = completionFor('please /mo', 10, { commands: COMMANDS, files: () => [] })
    assert.ok(state, 'there is a completion')
    assert.equal(state?.panel, false, 'a mid-line command does not steal the screen')
    assert.equal(state?.ghost, 'del', 'the ghost is the rest of the name')
  }

  // 8. A COMPLETE command ghosts its ARGUMENT HINT.
  {
    const state = completionFor('/tasks', 6, { commands: COMMANDS, files: () => [] })
    assert.equal(state?.exact, true, 'the typed text IS the command')
    assert.equal(state?.ghost, '<id>', 'the ghost says what the command wants')
    const noHint = completionFor('/help', 5, { commands: COMMANDS, files: () => [] })
    assert.equal(noHint?.ghost, '', 'a command with no argument has no ghost')
  }

  // 9. The clamp: an active index can never point past the list. This is the
  // B176 bug in a new hat.
  {
    const state = completionFor('/s', 2, { commands: COMMANDS, files: () => [] })!
    assert.ok(state.items.length > 1, 'there is more than one candidate')
    const stale = clampActive({ ...state, active: 99 })
    assert.equal(stale.active, state.items.length - 1, 'the active index is clamped to the list')
    const empty = clampActive({ ...state, items: [], active: 3 })
    assert.equal(empty.active, 0, 'an empty list has no active item')
  }

  // 10. Movement WRAPS at both ends: a list you can leave by pressing Up is
  // a list with a dead edge.
  {
    const state = completionFor('/s', 2, { commands: COMMANDS, files: () => [] })!
    const down = moveActive(state, 1)
    assert.equal(down.active, 1)
    const back = moveActive(down, -1)
    assert.equal(back.active, 0)
    const upFromTop = moveActive(back, -1)
    assert.equal(upFromTop.active, state.items.length - 1, 'Up from the first wraps to the last')
    const downFromLast = moveActive(upFromTop, 1)
    assert.equal(downFromLast.active, 0, 'Down from the last wraps to the first')
  }

  // 11. Acceptance replaces the token and keeps the rest of the draft.
  {
    const state = completionFor('/mo', 3, { commands: COMMANDS, files: () => [] })!
    assert.equal(acceptedText('/mo', state), '/model ', 'the command is inserted with a space')
    const withTail = completionFor('/mo and then some', 3, { commands: COMMANDS, files: () => [] })!
    assert.equal(acceptedText('/mo and then some', withTail), '/model and then some', 'the rest of the draft survives')
    // A file acceptance does not add a space — the path is the whole value.
    const fileState = completionFor('@src/ma', 7, { commands: COMMANDS, files: () => ['src/main.ts'] })!
    assert.equal(acceptedText('@src/ma', fileState), '@src/main.ts', 'the path replaces the path')
    // The ghost acceptance replaces the token with the whole name.
    const ghost = completionFor('please /mo', 10, { commands: COMMANDS, files: () => [] })!
    assert.equal(acceptedGhostText('please /mo', ghost), 'please /model', 'the ghost completes the name')
  }

  // 12. The @ completion runs even after a slash command — qwen-code checks
  // the @ first, and so does the engine.
  {
    const state = completionFor('/model @scr', 10, { commands: COMMANDS, files: () => ['src/screen.ts'] })
    assert.equal(state?.items[0]?.kind, 'file', 'the @ wins inside a slash command')
  }

  // 13. The candidate list is bounded, so a huge command set cannot make the
  // overlay enormous.
  {
    const many: CommandSpec[] = []
    for (let i = 0; i < 500; i++) many.push({ name: `/cmd${i}`, desc: 'x' })
    const state = completionFor('/cmd', 4, { commands: many, files: () => [] })!
    assert.ok(state.items.length <= COMPLETION_LIMIT, 'the list is capped')
  }

  // 14. Nothing is offered for prose.
  {
    assert.equal(completionFor('just a request', 13, { commands: COMMANDS, files: () => [] }), null, 'prose has no completion')
    assert.equal(completionFor('', 0, { commands: COMMANDS, files: () => [] }), null, 'an empty draft has no completion')
  }

  console.log('COMPLETION TEST: PASS (fuzzy scoring, slash + @ tokens, ranking, recency, ghost text, clamp, wrap, acceptance, bounds)')
}

void main()

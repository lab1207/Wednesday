/**
 * A whole SESSION, replayed — the guard for "the screen shows something that is
 * not the state".
 *
 * Everything else in this suite checks one screen at a time. This one walks a
 * realistic sequence and asserts, at every step, that the terminal surface
 * equals the frame the screen believes it painted. That is the invariant behind
 * every report of "it's frozen" or "why is this text still here": the operator
 * cannot tell a stale pixel from a live one, so a stale pixel *is* a freeze.
 *
 * The sequence is the one an operator actually performs after a run fails:
 *
 *   stream a task -> a run fails with diagnostics -> approve -> a SECOND request
 *   -> approve again -> open the command plate -> close it -> resize
 *
 * Both approvals are the REAL `Screen.askApproval`, driven with real keystrokes.
 * That path had no coverage at all: `dispatch-test.ts` stubs `approve` to always
 * reject, so "the second approval after a failed run" - reported as "I can't
 * select yes, it's frozen" - was never executed by any test.
 *
 *   npx tsx factory/harness/session-test.ts
 */
import assert from 'node:assert/strict'
import { stdin } from 'node:process'

import { Screen, eventMessage, initialState, runSelect, type SelectOption } from './screen.js'
import { replay, visibleGrid, visibleOf } from './replay.js'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const DIALOG = {
  title: 'Ready to run',
  body: [
    'Fix: hi',
    'Where: C:\\Users\\operator',
    'Verify: npm test',
    '',
    'Approval permits workspace changes. This preview is not a sandbox.',
  ].join('\n'),
  prompt: 'Run it? [y/N] — y runs, n/Esc cancels',
}

const COMMANDS: SelectOption[] = [
  { title: '/help', desc: 'what every key does', value: '/help' },
  { title: '/tasks', desc: 'recent tasks', value: '/tasks' },
  { title: '/exit', desc: 'leave the session', value: '/exit' },
]

async function main(): Promise<void> {
  const w = 100
  const h = 30
  let text = ''
  const out = {
    columns: w, rows: h, isTTY: true,
    write: (chunk: string) => { text += chunk; return true },
  } as unknown as NodeJS.WriteStream
  const screen = new Screen(out, w, h)
  const state = initialState('WEDNESDAY', 'mode live · laguna-xs-2.1:free')
  state.composerLabel = 'laguna-xs-2.1:free'
  state.side = { title: 'session', tokens: 0, limit: 13312 }
  screen.enter()
  screen.render(state)

  let stale = 0
  let checkpoints = 0

  /**
   * The terminal must equal the frame. `overlayOpen` is excluded deliberately:
   * a plate is painted OVER the frame on purpose, so comparing against the bare
   * frame there would report correct behaviour as stale.
   */
  const assertSurfaceMatchesFrame = (label: string): void => {
    if (screen.overlayOpen()) return
    checkpoints += 1
    const surface = replay(text, w, h)
    const want = visibleGrid(screen.painted(), w, h)
    const bad: string[] = []
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const shown = surface[r]![c]!
        const expected = want[r]?.[c] ?? ' '
        if (shown !== expected && bad.length < 4) bad.push(`r${r}c${c} ${JSON.stringify(shown)} vs ${JSON.stringify(expected)}`)
        else if (shown !== expected) stale += 1
      }
    }
    assert.equal(bad.length, 0, `stale content after ${label}: ${bad.join('; ')}`)
  }

  const listenersAt = (): number => stdin.listenerCount('data')

  // ── a task streams, then fails ────────────────────────────────────────────
  for (const ev of ['task.created', 'task.started', 'agent.started', 'agent.completed']) {
    screen.push(state, eventMessage(ev))
    screen.render(state)
    assertSurfaceMatchesFrame(ev)
  }
  screen.notify(state, 'reading workspace…')
  screen.render(state)
  assertSurfaceMatchesFrame('progress')
  for (const ev of ['task.blocked', 'task.failed']) screen.push(state, eventMessage(ev))
  screen.push(state, { text: 'diagnostics: architect failed: NVIDIA_API_KEY is not set', tone: 'red' })
  screen.render(state)
  assertSurfaceMatchesFrame('a failed run')
  assert.equal(listenersAt(), 0, 'a finished run leaves no stdin listener behind')

  // ── first approval, answered yes ──────────────────────────────────────────
  const first = screen.askApproval(state, { ...DIALOG })
  await wait(20)
  assertSurfaceMatchesFrame('the first approval open')
  stdin.emit('data', 'y')
  assert.equal(
    await Promise.race([first, wait(500).then(() => 'HUNG')]),
    true,
    'the first approval answers y',
  )
  await wait(20)
  screen.render(state)
  assertSurfaceMatchesFrame('the first approval answered')
  assert.equal(listenersAt(), 0, 'answering an approval detaches its input')

  // ── the retry, which is what was reported as frozen ───────────────────────
  screen.notify(state, 'reading workspace…')
  screen.render(state)
  assertSurfaceMatchesFrame('the retry progress')
  const second = screen.askApproval(state, { ...DIALOG })
  await wait(20)
  assertSurfaceMatchesFrame('the second approval open')
  stdin.emit('data', 'y')
  assert.equal(
    await Promise.race([second, wait(500).then(() => 'HUNG')]),
    true,
    'a SECOND approval after a failed run still answers y - the reported freeze',
  )
  await wait(20)
  screen.render(state)
  assertSurfaceMatchesFrame('the second approval answered')
  assert.equal(listenersAt(), 0, 'and it detaches cleanly too')

  // ── a rejected approval, for the other direction ──────────────────────────
  const third = screen.askApproval(state, { ...DIALOG })
  await wait(20)
  stdin.emit('data', '\x1b')
  assert.equal(
    await Promise.race([third, wait(500).then(() => 'HUNG')]),
    false,
    'Esc rejects',
  )
  await wait(20)
  screen.render(state)
  assertSurfaceMatchesFrame('a rejected approval')

  // ── the plate, and a resize ───────────────────────────────────────────────
  const plate = runSelect(out, w, h, 'Commands', COMMANDS, () => screen.frame(state), '', screen)
  await wait(20)
  stdin.emit('data', '\x1b')
  await Promise.race([plate, wait(300)])
  await wait(20)
  screen.render(state)
  assertSurfaceMatchesFrame('the plate closed')

  // ── drift: the terminal moved under the app ───────────────────────────────
  // The reported ghost: the console left the page a row off, the diff kept
  // rewriting only the rows it believed changed, and the previous frame's
  // armed-cancel row survived above the live armed-run row — "double yes yes".
  // No app can see a terminal that moved, so the gate is held to the property
  // it CAN keep: the moment it moves again, every row is rewritten and the
  // surface equals the frame.
  const drift = (row: number, col: number, cells: string): void => {
    // Bytes the app never wrote, exactly as a console that moved leaves the
    // screen: cells to dirty in rows the diff counts as settled.
    text += `\x1b[${row};${col}H${cells}`
  }

  const fourth = screen.askApproval(state, { ...DIALOG })
  await wait(20)
  assertSurfaceMatchesFrame('the fourth approval open')
  drift(12, 3, '@@@@')
  drift(24, 40, 'STALE ROW')
  // Arrows, not Tab: the focus move must be provably a render, or the check
  // below would pass because nothing repainted, not because the gate healed.
  // Hermes' gate moves the `▸` vertically (↑ arms run, ↓ returns to deny).
  stdin.emit('data', '\x1b[A')
  await wait(20)
  assertSurfaceMatchesFrame('a focus move after the terminal drifted')
  stdin.emit('data', '\x1b[B')
  await wait(20)
  assertSurfaceMatchesFrame('a second focus move')
  stdin.emit('data', '\x1b')
  assert.equal(
    await Promise.race([fourth, wait(500).then(() => 'HUNG')]),
    false,
    'Esc still rejects after a drift',
  )
  await wait(20)
  assertSurfaceMatchesFrame('the gate closed after a drift')

  // ── the idle heal: a quiet screen is repainted in full ────────────────────
  // Reaching past `private` on purpose: the real window is 2s and sleeping it
  // out would slow the suite for no extra coverage — the property under test
  // is the heal, not the timer.
  ;(screen as unknown as { lastPaintAt: number }).lastPaintAt = Date.now() - 60_000
  drift(6, 3, '####')
  screen.render(state)
  assertSurfaceMatchesFrame('the idle heal')

  // ── a resize ─────────────────────────────────────────────────────────────
  // A terminal that changes size has already dealt with its own overflow: the
  // columns that fell outside the window are gone, not stale. Replaying the
  // whole history against the new size would therefore compare the app against a
  // history the terminal never had - that is a fault in the model, not in the
  // renderer, and modelling it wrongly is exactly how a "fix" gets written
  // against a fiction.
  //
  // So across a resize the app is held to the invariant that IS its own: it
  // must never ADDRESS a cell outside the terminal. That is checked on the byte
  // stream, with no grid and no assumption about what the terminal kept.
  const assertNoWriteOutsideTerminal = (label: string): void => {
    const overflow: string[] = []
    for (const m of text.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
      const row = Number(m[1])
      const col = Number(m[2])
      if (row > out.rows || col > out.columns) overflow.push(`${row};${col}`)
    }
    assert.equal(overflow.length, 0, `after ${label}, ${overflow.length} write(s) addressed outside ${out.columns}x${out.rows}: ${overflow.slice(0, 4).join(' ')}`)
  }

  const resizeTerminal = (nw: number, nh: number): void => {
    out.columns = nw
    out.rows = nh
    // The terminal's own surface is not ours to reconstruct, so the history is
    // dropped here and the check below reads only what the app wrote after.
    text = ''
    screen.resize(nw, nh)
    screen.render(state)
  }
  resizeTerminal(72, 20)
  assertNoWriteOutsideTerminal('shrinking to 72x20')
  resizeTerminal(132, 40)
  assertNoWriteOutsideTerminal('growing to 132x40')
  // A split pane is a normal way to work, not an error to correct by overdrawing.
  resizeTerminal(96, 30)
  screen.render(state)
  assertNoWriteOutsideTerminal('a split pane at 96x30')

  // ── and the meter is drawn ONCE ───────────────────────────────────────────
  const surface = replay(text, out.columns, out.rows).map(r => r.join(''))
  // Hermes' status meter replaced the side rail. The invariant is the same one
  // the rail check protected: the live surface carries exactly one copy of it,
  // so a stale repaint or a double paint shows up here.
  const frameLines = screen.painted().map(visibleOf)
  assert.ok(frameLines.some(l => l.includes('✦')), 'the status meter is present at this width')
  const meterRows = surface.filter(l => /^ ✦ /.test(l))
  assert.equal(meterRows.length, 1, `the meter draws exactly once (got ${meterRows.length})`)
  assert.match(meterRows[0]!, /✦ laguna/, 'and it names the model')

  assert.equal(stale, 0, `${stale} stale cell(s) across ${checkpoints} checkpoints`)
  screen.exit()
  console.log(`SESSION TEST: PASS (${checkpoints} checkpoints, terminal always matched the frame, both approvals answered after a failed run, the gate heals a drifted terminal)`)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

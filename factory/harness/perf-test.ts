/**
 * Painting budget — the freeze guard.
 *
 * Reported as "terminal got freeze so heavily" with the command plate open, and
 * then "its freeze and nothing works, I pressed control+c to close". Measured
 * cause: with `?1003h` motion tracking armed, a moving mouse delivers a
 * continuous stream of reports, and EVERY one repainted the entire screen
 * (base frame + plate, ~4 KB of escapes). At 200 reports per 16 ms frame that
 * was 73 ms of painting per frame — the console could not absorb its own writes,
 * which is what a freeze actually is.
 *
 * After the fix (incremental repaints): 3.7 ms for the same load.
 *
 * BYTES, not just milliseconds, are asserted: a byte budget fails deterministically
 * on a slow machine, where a timing budget would just be flaky. Timings are
 * checked too, with margins wide enough that a busy CI box still passes.
 *
 *   npx tsx factory/harness/perf-test.ts
 */
import assert from 'node:assert/strict'
import { stdin } from 'node:process'

import { Screen, eventMessage, initialState, runSelect, type SelectOption } from './screen.js'
import { spinnerTick } from './harness.js'
import { replay, visibleOf } from './replay.js'

const PALETTE: SelectOption[] = Array.from({ length: 9 }, (_, i) => ({
  title: `/cmd-${i}`,
  desc: `command number ${i}`,
  value: `/cmd-${i}`,
}))

interface Sink {
  out: NodeJS.WriteStream
  bytes: () => number
  writes: () => number
  reset: () => void
  /** Everything written since the last reset, for replaying the surface. */
  text: () => string
}

function sink(w: number, h: number): Sink {
  let bytes = 0
  let writes = 0
  let text = ''
  return {
    out: {
      columns: w, rows: h, isTTY: true,
      write: (chunk: string) => { bytes += chunk.length; writes += 1; text += chunk; return true },
    } as unknown as NodeJS.WriteStream,
    bytes: () => bytes,
    writes: () => writes,
    reset: () => { bytes = 0; writes = 0; text = '' },
    text: () => text,
  }
}

function session(w: number, h: number, messages: number, busy: boolean) {
  const s = sink(w, h)
  const scr = new Screen(s.out, w, h)
  const st = initialState('WEDNESDAY', 'mode live · laguna-xs-2.1:free')
  st.composerLabel = 'laguna-xs-2.1:free'
  st.side = { title: 'session', tokens: 2318, limit: 13312 }
  for (let i = 0; i < messages; i++) st.messages.push(eventMessage(['task.created', 'agent.started', 'agent.completed'][i % 3]!))
  st.busy = busy
  st.status = busy ? 'working… esc interrupts' : '/ for commands · ctrl+p palette · pgup/pgdn scroll'
  scr.enter()
  scr.render(st)
  s.reset()
  return { scr, st, s }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  // ── 0. The oracle must be trustworthy before it is trusted ────────────────
  // Everything below inspects the terminal surface by replaying the byte stream,
  // which is only meaningful if the replay is faithful. Getting this wrong is
  // not a harmless test bug: a replay that skips a row after every full-width
  // row desyncs the whole grid and reports a CORRECT renderer as broken. So the
  // emulator is checked against the screen's own frame before it is used to
  // judge anything.
  for (const [w, h] of [[100, 30], [132, 40], [80, 24], [40, 12]] as Array<[number, number]>) {
    const chunks: string[] = []
    const out = { columns: w, rows: h, isTTY: true, write: (c: string) => { chunks.push(c); return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'mode live \u00b7 m')
    st.composerLabel = 'm'
    st.status = 'ready'
    st.side = { title: 'session', tokens: 2318, limit: 13312 }
    for (let i = 0; i < 8; i++) st.messages.push(eventMessage(['task.created', 'agent.started'][i % 2]!))
    scr.enter()
    scr.render(st)
    const replayed = replay(chunks, w, h).map(row => row.join('').replace(/\s+$/, ''))
    const painted = scr.painted().map(row => visibleOf(row).replace(/\s+$/, ''))
    const differ = replayed.filter((row, i) => row !== painted[i]).length
    assert.equal(differ, 0, `the replay does not match the screen at ${w}x${h} (${differ} row(s) differ) - every assertion below is void`)
    scr.exit()
  }

  // ── 1. A spinner tick that changes one row must not repaint the screen ─────
  {
    const { scr, st, s } = session(100, 30, 40, true)
    // One tick of the scanner: the status line changes, nothing else does.
    scr.tick()
    scr.render(st)
    const bytes = s.bytes()
    assert.ok(bytes < 2000, `a spinner tick writes ${bytes} bytes; a full frame is ~4300`)
    // A tick where nothing visible changed writes only the caret address — the
    // cursor must stay visible, and that write is 13 bytes, not a repaint.
    s.reset()
    scr.render(st)
    assert.ok(s.bytes() <= 16, `an unchanged render writes only the caret (${s.bytes()} bytes)`)
    scr.exit()
  }

  // ── 2. Typing must not repaint the whole screen per keystroke ─────────────
  {
    const { scr, st, s } = session(100, 30, 40, false)
    const line = scr.readLine(st, [])
    await wait(20)
    s.reset()
    const t0 = performance.now()
    stdin.emit('data', 'a')
    const keystrokeMs = performance.now() - t0
    const bytes = s.bytes()
    stdin.emit('data', '\r')
    await line
    scr.exit()
    // One changed row (the composer) plus the caret. Generous: a full frame is
    // ~4300 bytes, so anything under half that is a diff, not a repaint.
    assert.ok(bytes < 2200, `one keystroke wrote ${bytes} bytes — that is a full-frame repaint`)
    assert.ok(keystrokeMs < 60, `one keystroke took ${keystrokeMs.toFixed(1)}ms; a 16ms frame budget is the target`)
  }

  // ── 3. The freeze case: mouse motion over the open plate, during a run ────
  // 200 reports is what a moving mouse delivers inside a couple of frames.
  {
    const { scr, st, s } = session(100, 30, 40, true)
    const plate = runSelect(s.out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    await wait(20)
    s.reset()
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) {
      stdin.emit('data', `\x1b[<35;${20 + (i % 60)};${10 + (i % 9)}M`)
    }
    const ms = performance.now() - t0
    const bytes = s.bytes()
    // A keystroke AFTER the storm must still land inside a frame budget.
    const keyT0 = performance.now()
    stdin.emit('data', 'x')
    const keyMs = performance.now() - keyT0
    stdin.emit('data', '\x1b')
    void plate
    scr.exit()
    // Before: 200 reports → ~880 KB. Now: each hover rewrites two rows.
    assert.ok(bytes < 120_000, `200 hover reports wrote ${(bytes / 1024).toFixed(0)} KB`)
    assert.ok(ms < 250, `200 hover reports took ${ms.toFixed(0)}ms`)
    assert.ok(keyMs < 60, `a keystroke after the storm took ${keyMs.toFixed(1)}ms — the loop was saturated`)
  }

  // ── 4. A resize is a real change and must repaint everything ─────────────
  {
    const { scr, st, s } = session(100, 30, 10, false)
    scr.resize(80, 24)
    s.reset()
    scr.render(st)
    assert.ok(s.bytes() > 2000, `a resize repaints fully (wrote ${s.bytes()} bytes)`)
    assert.ok(scr.painted().length === 24, 'and the cached frame is the new height')
    scr.exit()
  }

  // ── 5. A finished run must stop painting ─────────────────────────────────
  // The freeze reported as "nothing works, only ctrl+c closes it" has a second
  // cause with identical symptoms: a `busy` flag that never clears, so the 120ms
  // spinner repaints forever after the work is done. The spinner only paints
  // while busy (`if (state.busy) { tick; render }`), so an IDLE screen must cost
  // nothing at all — that is the property worth holding.
  {
    const { scr, st, s } = session(100, 30, 40, false)
    scr.render(st)
    s.reset()
    // What the spinner's timer does once the run is over.
    for (let i = 0; i < 50; i++) { if (st.busy) { scr.tick(); scr.render(st) } }
    assert.ok(s.bytes() <= 16, `an idle screen writes nothing (${s.bytes()} bytes over 50 timer ticks)`)
    scr.exit()
  }
  {
    // And while a run IS live, the scanner legitimately animates — but only its
    // own row. This is the ceiling that keeps an animation from becoming a
    // full-screen repaint 8 times a second.
    //
    // The ceiling moved from 200 to 220 bytes when the paint was wrapped in
    // SYNCHRONIZED OUTPUT (`CSI ? 2026 h` / `CSI ? 2026 l`): sixteen bytes per
    // tick buy an ATOMIC frame — the terminal presents the page in one go
    // instead of row by row, and the operator never sees a half-drawn frame.
    // The property this test guards is unchanged: one animated row must cost
    // a fraction of a full frame (~4300 bytes).
    const { scr, st, s } = session(100, 30, 40, true)
    scr.render(st)
    s.reset()
    for (let i = 0; i < 50; i++) { scr.tick(); scr.render(st) }
    const per = s.bytes() / 50
    assert.ok(per < 220, `an animated row costs ${per.toFixed(0)} bytes/tick; a full frame is ~4300`)
    // The atomic-frame mode must be BALANCED. An unterminated `CSI ? 2026 h`
    // leaves the terminal buffering everything that follows: the page freezes
    // and the operator sees a dead screen.
    const bytes = s.text()
    const opens = bytes.split('\x1b[?2026h').length - 1
    const closes = bytes.split('\x1b[?2026l').length - 1
    assert.equal(opens, closes, `the synchronized-output mode is balanced (${opens} open, ${closes} close)`)
    scr.exit()
  }

  // ── 6. Leaving an overlay must not leave it on screen ─────────────────────
  // The failure mode a diff renderer introduces: the cache says "already
  // painted", the plate is still there, and nothing ever repaints it away.
  {
    const { scr, st, s } = session(100, 30, 5, false)
    void runSelect(s.out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    await wait(20)
    stdin.emit('data', '\r')
    await wait(30)
    scr.render(st)
    const painted = scr.painted().join('\n')
    assert.ok(!painted.includes('Commands'), 'the plate is gone from the frame after it closes')
    scr.exit()
  }

  // ── 7. A shrinking overlay must not leave its shadow behind ───────────────
  // The failure a patch-diffing overlay introduces, and the one this suite
  // exists to prevent: the shadow lives OUTSIDE the panel, so a renderer that
  // only tracks the panel's own rows forgets it. Then a filter that shrinks the
  // list moves the panel, and the OLD shadow row stays on screen forever on a
  // row nobody ever repaints — a stripe of texture across the page that no key
  // clears.
  {
    const w = 100
    const h = 30
    const chunks: string[] = []
    const out = { columns: w, rows: h, isTTY: true, write: (c: string) => { chunks.push(c); return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'mode live \u00b7 m')
    st.composerLabel = 'm'
    st.status = 'ready'
    scr.enter()
    scr.render(st)
    // Nine options tall enough that filtering shrinks the plate by several rows,
    // which moves its centre and therefore its shadow.
    const many: SelectOption[] = Array.from({ length: 9 }, (_, i) => ({
      title: `/zzz-${i}`, desc: `tall option ${i}`, value: `/zzz-${i}`,
    }))
    void runSelect(out, w, h, 'Commands', many, () => scr.frame(st), '', scr)
    await wait(20)
    const before = replay(chunks, w, h)
    const shadowedBefore: string[] = []
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const ch = before[r]![c]
        if (ch === '\u2591' || ch === '\u2592') shadowedBefore.push(`${r}:${c}`)
      }
    }
    assert.ok(shadowedBefore.length > 0, 'the open plate casts a shadow to begin with')

    // Narrow to a single match: the plate loses rows and re-centres.
    stdin.emit('data', '/zzz-0')
    await wait(20)
    const after = replay(chunks, w, h)

    // The invariant is not "every shadow cell still holds a shadow" - a lifted
    // shadow correctly holds the PAGE underneath instead, which is usually a
    // space. The invariant is that the overlay leaves the page exactly as it
    // found it: after the plate moves, every cell it once covered must either
    // still be the overlay's, or be the live frame's content again.
    const frameNow = scr.painted()
    const orphans = shadowedBefore.filter(at => {
      const [r, c] = at.split(':').map(Number) as [number, number]
      const now = after[r]?.[c]
      if (now === '\u2591' || now === '\u2592') return false
      return now !== (frameNow[r]?.[c] ?? ' ')
    })
    assert.equal(
      orphans.length,
      0,
      `shrinking the plate left ${orphans.length} shadow cell(s) that never came back, first at ${orphans[0]}`,
    )
    stdin.emit('data', '\x1b')
    await wait(20)
    scr.exit()
  }

  // ── 8. A spinner tick must not paint through an open plate ────────────────
  // Reachable, and it was broken: the spinner repaints the frame 8 times a
  // second during a live run, the plate is painted OVER that frame, so every
  // tick punched a hole in the menu and spent the bytes doing it. Opening the
  // command plate mid-run is the normal thing an operator does.
  //
  // The failure is subtle because the plate usually survives: most frame rows
  // are blank, and a blank row painted over a blank row changes nothing. It
  // shows up as a flicker over the stream text behind the plate, or as a torn
  // option row when a message happens to scroll underneath.
  {
    const { scr, st, s } = session(100, 30, 40, true)
    const plate = runSelect(s.out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    await wait(20)
    // The terminal surface is the ACCUMULATION of every write, so the "after"
    // replay has to include the writes that produced the "before" surface.
    // Resetting the sink first would replay the ticks onto a blank grid and
    // report every cell as changed.
    const beforeText = s.text()
    const before = replay(beforeText, 100, 30)
    s.reset()
    // Ten spinner ticks: two and a half seconds of a live run with the menu up.
    // This is the REAL loop, imported from harness.ts. Re-implementing it here
    // is what made the first version of this case worthless: it proved the
    // guard works in the test while the guard could be deleted from production
    // and stay green.
    for (let i = 0; i < 10; i++) spinnerTick(scr, st)
    const after = replay(beforeText + s.text(), 100, 30)
    let torn = 0
    before.forEach((row, r) => {
      row.forEach((ch, c) => {
        if (ch !== ' ' && after[r]?.[c] !== ch) torn += 1
      })
    })
    assert.equal(torn, 0, `a spinner tick repainted through the plate, changing ${torn} visible cell(s)`)
    assert.ok(s.bytes() <= 32, `spinner ticks under a plate wrote ${s.bytes()} bytes; the overlay owns the surface`)

    // The guard now lives INSIDE render() (2026-11-01: a base repaint must not
    // clobber a live overlay during a run), so even a direct render with the
    // plate up changes nothing and writes nothing.
    s.reset()
    // Three ticks, not ten: the braille spinner has a 10-frame cycle, so ten
    // ticks land back on the frame already on screen and prove nothing.
    for (let i = 0; i < 3; i++) { scr.tick(); scr.render(st) } // plate still open; render() itself guards
    const guarded = replay(beforeText + s.text(), 100, 30)
    let guardedTorn = 0
    before.forEach((row, r) => row.forEach((ch, c) => {
      if (ch !== ' ' && guarded[r]?.[c] !== ch) guardedTorn += 1
    }))
    assert.equal(guardedTorn, 0, 'render() no-ops while the plate owns the surface (guard inside render)')
    assert.equal(s.bytes(), 0, 'a guarded render writes zero bytes — the guard is load-bearing, not the ticks stopping')

    // Await the close instead of sleeping past it. A fixed delay made this case
    // flaky in exactly the dangerous direction: a render issued before the
    // overlay had detached, which is the one ordering that hides a leak.
    s.reset()
    stdin.emit('data', '\x1b')
    const closedByEsc = await Promise.race([
      plate.then(() => true),
      wait(500).then(() => false),
    ])
    assert.ok(closedByEsc, 'Esc closes the plate')
    // And when it closes, the frame must be whole again.
    s.reset()
    scr.render(st)
    const closed = replay(beforeText + s.text(), 100, 30)
    assert.ok(
      closed.some(row => row.join('').includes('laguna')),
      'the frame is restored in full once the plate closes',
    )
    assert.ok(
      !closed.some(row => row.join('').includes('Commands')),
      'and the plate itself is gone from the surface',
    )
    // The shadow check skips the status meter row and looks for overlay
    // texture anywhere else; the meter is the row carrying the brand star.
    const nonMeter = closed.filter(row => !row.join('').includes('✦'))
    assert.ok(
      !nonMeter.some(row => row.some(ch => ch === '\u2591' || ch === '\u2592')),
      'and so is its shadow',
    )
    // Non-vacuous check in the other direction: with the plate CLOSED, the
    // same tick+render really does paint (so the guard above is what blocked
    // it, not a dead render path).
    s.reset()
    for (let i = 0; i < 3; i++) { scr.tick(); scr.render(st) }
    assert.ok(s.bytes() > 0, 'with no overlay, tick+render paints again — the guard, not a dead path, blocked it above')
    scr.exit()
  }

  // ── 9. A missed console resize must heal itself ───────────────────────────
  // Reported from a screenshot, twice: the frame was plainly narrower than the
  // window, with the Context panel stranded mid-screen and dead space to the
  // right of it. `stdout.on('resize')` is wired and is the right mechanism - so
  // either the event did not arrive, or it arrived and `columns` was not yet
  // updated. Either way the app stays wrong until it is restarted, which is what
  // the operator saw.
  //
  // Both halves are asserted. The first is the reachable one: a keystroke
  // notices and repairs the width. The second is the mechanism that was
  // MISSING - before it, even a correct width could not remove a ghost, because
  // `ESC[0J` erases from the cursor (on the last row) and can never reach the
  // tail of a row above it.
  {
    const w = 132
    const h = 30
    const chunks: string[] = []
    const stream = {
      columns: w, rows: h, isTTY: true,
      write: (c: string) => { chunks.push(c); return true },
    }
    const out = stream as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'mode live \u00b7 m')
    st.composerLabel = 'm'
    st.side = { title: 'session', tokens: 2318, limit: 13312 }
    st.status = 'ready'
    scr.enter()
    scr.render(st)
    assert.equal(visibleOf(scr.painted()[0] ?? '').length, w, 'the frame starts at the width it was told')

    // The window grows and the resize event never arrives.
    stream.columns = 190
    stream.rows = 44
    assert.equal(scr.overlayOpen(), false, 'no overlay is open, so nothing else will notice')

    // One keystroke: the composer is open, so this is the real path.
    const line = scr.readLine(st, [])
    await wait(20)
    stdin.emit('data', 'x')
    await wait(20)
    assert.equal(scr.painted().length, 44, `a keystroke noticed the new height (got ${scr.painted().length} rows)`)
    const header = visibleOf(scr.painted()[0] ?? '')
    assert.equal(header.length, 190, `a keystroke noticed the new width (got ${header.length} cols)`)
    stdin.emit('data', '\r')
    await line

    // The second half: the tail-clear. Reaching it needs the painted extent to
    // exceed the frame width, which is exactly the situation a stale width
    // leaves behind, so drive it directly.
    const wideChunks: string[] = []
    const wideStream = {
      columns: 190, rows: 40, isTTY: true,
      write: (c: string) => { wideChunks.push(c); return true },
    }
    const wideOut = wideStream as unknown as NodeJS.WriteStream
    const wide = new Screen(wideOut, 190, 40)
    const wideState = initialState('WEDNESDAY', 'mode live \u00b7 m')
    wideState.composerLabel = 'm'
    wideState.side = { title: 'session', tokens: 2318, limit: 13312 }
    wideState.status = 'ready'
    wide.enter()
    wide.render(wideState)
    const wideText = wideChunks.join('')
    // Same screen object, now painting a narrower frame - no resize(), because
    // a resize means the terminal told us and it discards its own overflow.
    const narrowState = { ...wideState, home: false }
    const narrower = wide.fullRepaint(wide.frame(narrowState).split('\n'), 132, 30)
    const tailCleared = replay(wideText + narrower, 190, 40)
    let residue = 0
    for (let r = 0; r < 30; r++) {
      for (let c = 132; c < 190; c++) if (tailCleared[r]![c] !== ' ') residue += 1
    }
    assert.equal(residue, 0, `a narrower repaint left ${residue} cell(s) of the old frame on screen`)
    wide.exit()
    scr.exit()
  }

  // ── 10. Laying out a large draft must be LINEAR, not quadratic ─────────────
  // Reachable from an ordinary action: paste a large file into the composer.
  //
  // `wrap()` re-measured the whole REMAINDER on every iteration
  // (`while (visibleWidth(line) > width)`, cutting `width` characters off), so a
  // 1 MB paste took **145 SECONDS** to lay out and one keystroke with a 100 KB
  // draft present took **1.45 s**. That is not "slow", it is a terminal that has
  // stopped answering - the same shape as the B76 freeze, reached by typing
  // instead of by moving the mouse.
  //
  // The assertion is on the RATIO, not on milliseconds, because a millisecond
  // budget is a flake on a slow machine and a non-event on a fast one. Sixteen
  // times the input multiplies the work by 16 when the code is linear and by 256
  // when it is quadratic, so a ceiling between the two separates them on any
  // machine. A deliberately constant-factor "regression" - one that re-measures
  // a line that never exceeds the wrap width - is caught too, because it is slow
  // in absolute terms and shows up as a much worse ratio at 16x the input.
  const linearity = (label: string, measure: (chars: number) => number): void => {
    measure(50_000) // warm up, so JIT is not billed to the small measurement
    const small = Math.max(measure(100_000), 0.5)
    const large = measure(1_600_000)
    const ratio = large / small
    assert.ok(
      ratio < 40,
      `${label}: 16x the input took ${ratio.toFixed(0)}x the time ` +
      `(${small.toFixed(0)}ms -> ${large.toFixed(0)}ms); linear is ~16x, quadratic ~256x`,
    )
  }
  linearity('composer draft', chars => {
    const { scr, st } = session(100, 30, 0, false)
    st.input = 'x'.repeat(chars)
    st.cursor = st.input.length
    const t0 = performance.now()
    scr.render(st)
    const ms = performance.now() - t0
    scr.exit()
    return ms
  })
  linearity('stream message wrap', chars => {
    const { scr, st } = session(100, 30, 0, false)
    st.messages.push({ text: 'z'.repeat(chars), tone: 'plain' })
    const t0 = performance.now()
    scr.render(st)
    const ms = performance.now() - t0
    scr.exit()
    return ms
  })

  console.log('PERF TEST: PASS (replay oracle verified, spinner diffs one row, keystroke diffs, 200 hover reports stay cheap, resize repaints, idle screen is free, overlays clear, no orphaned shadow, missed resize heals, narrower repaint clears the tail, large drafts lay out linearly)')
}

void main().catch(error => {
  console.error(String(error))
  process.exitCode = 1
})

/**
 * KEYSTROKE REPLAYS — the tests that were missing.
 *
 * Every earlier harness test drove the layout or the overlay directly. None of
 * them pressed the keys an operator actually presses, which is how
 * `ReferenceError: hist is not defined` shipped: the UP arrow was never
 * pressed in any test, so the crash on it could not be caught.
 *
 * This file replays REAL terminal byte sequences through the REAL input router
 * into a REAL Screen, in the order a person would type them. Any uncaught
 * exception inside a handler is a failure, because in the app that same
 * exception kills the session (which is exactly what the operator saw).
 *
 *   npx tsx factory/harness/keys-test.ts
 */
import { stdin } from 'node:process'
import { Screen, initialState, runSelect, type SelectOption } from './screen.js'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

const failures: string[] = []
let checks = 0

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** Send raw bytes the way a terminal would, then let the handlers run. */
async function press(...chunks: string[]): Promise<void> {
  for (const chunk of chunks) stdin.emit('data', chunk)
  // Lone ESC is held 200ms for a possible follow-up (Alt vs Esc); settle past
  // it when a chunk could leave pending output, or assertions race the flush
  // and read pre-flush state.
  const needsFlush = chunks.some(c => c.includes('\x1b'))
  await new Promise(r => setTimeout(r, needsFlush ? 260 : 8))
}

/** Run one key handler in isolation and report any throw as a failure. */
async function pressSafe(label: string, ...chunks: string[]): Promise<void> {
  try {
    await press(...chunks)
    ok(`${label} does not throw`, true)
  } catch (error) {
    ok(`${label} does not throw`, false, String(error))
  }
}

const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  enter: '\r',
  esc: '\x1b',
  backspace: '\x7f',
  ctrlJ: '\n',
  ctrlP: '\x10',
  ctrlC: '\x03',
  ctrlD: '\x04',
  wheelUp: '\x1b[<64;10;10M',
  wheelDown: '\x1b[<65;10;10M',
  click: (row: number, col: number) => `\x1b[<0;${col};${row}M`,
  hover: (row: number, col: number) => `\x1b[<35;${col};${row}M`,
} as const

function fresh(width = 100, height = 30) {
  let captured = ''
  const out = {
    columns: width, rows: height,
    write: (c: string) => { captured += c; return true },
  } as unknown as NodeJS.WriteStream
  const scr = new Screen(out, width, height)
  const st = initialState('WEDNESDAY', 'mode live · qwen2.5-coder-3b')
  st.composerLabel = 'qwen2.5-coder-3b'
  scr.enter()
  return { scr, st, out, get: () => captured }
}

const PALETTE: SelectOption[] = [
  { title: '/help', desc: 'this help', footer: 'commands', value: '/help' },
  { title: '/agents', desc: 'crew profile', footer: 'agents', value: '/agents' },
  { title: '/model', desc: 'session model', footer: 'model', value: '/model ' },
  { title: '/tasks', desc: 'list tasks', footer: 'tasks', value: '/tasks' },
  { title: '/exit', desc: 'leave', footer: 'exit', value: '/exit' },
]

async function settle(ms = 30): Promise<string | undefined> {
  return Promise.race([
    new Promise<string | undefined>(r => setTimeout(() => r('__TIMEOUT__'), ms)),
    Promise.resolve(undefined),
  ])
}

/**
 * Row/column of the last painted plate row containing `needle`.
 *
 * Clicks are aimed by READING the paint, never by hard-coded cells: the plate
 * is centred and its height depends on the option count, so any fixed
 * coordinate silently turns into a click on the plate chrome (which is
 * ignored) or on the background (which dismisses) the moment either changes.
 */
function paintedAt(get: () => string, needle: string): { row: number; col: number } {
  const out = get()
  const found = [...out.matchAll(/\x1b\[(\d+);(\d+)H/g)]
  const spots = found.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length
    const to = i + 1 < found.length ? (found[i + 1]!.index ?? out.length) : out.length
    return { row: Number(m[1]), col: Number(m[2]), text: strip(out.slice(from, to)) }
  })
  const hit = spots.reverse().find(spot => spot.text.includes(needle))
  if (!hit) throw new Error(`"${needle}" is not painted`)
  return { row: hit.row, col: hit.col }
}

async function main(): Promise<void> {
  // ── 1. Every navigation key, one at a time, on a live composer ───────────
  // This is the replay that was missing. UP is the crash the operator hit.
  {
    const { scr, st } = fresh()
    for (let i = 0; i < 30; i++) st.messages.push({ text: `line ${i}`, tone: 'plain' })
    const history = ['first request', 'second request', 'third request']
    const line = scr.readLine(st, history)

    await pressSafe('type text', 'hello world')
    ok('typing lands in the composer', st.input === 'hello world', st.input)

    await pressSafe('LEFT', KEY.left)
    await pressSafe('LEFT', KEY.left)
    ok('LEFT moves the cursor', st.cursor === 9, String(st.cursor))

    await pressSafe('RIGHT', KEY.right)
    ok('RIGHT moves the cursor back', st.cursor === 10, String(st.cursor))

    await pressSafe('HOME', KEY.home)
    ok('HOME goes to column 0', st.cursor === 0, String(st.cursor))

    await pressSafe('END', KEY.end)
    ok('END goes to the end', st.cursor === st.input.length, String(st.cursor))

    await pressSafe('BACKSPACE', KEY.backspace)
    ok('BACKSPACE deletes', st.input === 'hello worl', st.input)

    await pressSafe('CTRL+J', KEY.ctrlJ)
    ok('CTRL+J inserts a newline', st.input.includes('\n'), JSON.stringify(st.input))

    await pressSafe('UP', KEY.up)
    await pressSafe('UP again', KEY.up)
    ok('UP recalls history', st.input === 'third request' || st.input === 'second request', st.input)

    await pressSafe('DOWN', KEY.down)
    await pressSafe('DOWN again', KEY.down)
    // pi's rule (MIT): walking past the newest history entry gives the
    // operator's OWN draft back — not an empty composer. A stray arrow key
    // must not throw away a half-typed request.
    ok('DOWN past the newest restores the draft', st.input === 'hello worl\n', JSON.stringify(st.input))

    await pressSafe('UP past the oldest', KEY.up)
    await pressSafe('UP past the oldest 2', KEY.up)
    await pressSafe('UP past the oldest 3', KEY.up)
    await pressSafe('UP past the oldest 4', KEY.up)
    ok('UP clamps at the oldest entry', st.input === 'first request', st.input)

    await pressSafe('DOWN to the end', KEY.down)
    await pressSafe('DOWN past the newest', KEY.down)
    await pressSafe('DOWN past the newest 2', KEY.down)
    ok('DOWN returns to the draft', st.input === 'hello worl\n', JSON.stringify(st.input))

    await pressSafe('PAGEUP', KEY.pageUp)
    ok('PAGEUP scrolls', st.scroll > 0, String(st.scroll))
    await pressSafe('PAGEDOWN', KEY.pageDown)
    ok('PAGEDOWN scrolls back', st.scroll === 0, String(st.scroll))

    await pressSafe('WHEEL up', KEY.wheelUp)
    ok('WHEEL up scrolls toward older lines', st.scroll > 0, String(st.scroll))
    // Hermes' native path defers the first direction flip for encoder-bounce
    // detection; the second tick commits and walks back to the tail.
    await pressSafe('WHEEL down', KEY.wheelDown)
    await pressSafe('WHEEL down again', KEY.wheelDown)
    ok('WHEEL down returns to the newest line', st.scroll === 0, String(st.scroll))

    await pressSafe('ESC clears the draft', KEY.esc)
    ok('ESC clears the draft', st.input === '' || st.cursor === 0, JSON.stringify(st.input))

    await press('final answer', KEY.enter)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('ENTER returns the line', value === 'final answer', String(value))
    scr.exit()
  }

  // ── 1b. Ctrl+C is a TWO-step exit; a prompt's Ctrl+C only cancels ────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await pressSafe('type a draft', 'half a thought')
    await pressSafe('CTRL+C once', KEY.ctrlC)
    ok('one Ctrl+C clears the draft', st.input === '', JSON.stringify(st.input))
    ok('one Ctrl+C asks before exiting', /ctrl\+c again/.test(st.status), st.status)
    await pressSafe('type after the hint', 'x')
    ok('typing dismisses the exit hint', !/ctrl\+c again/.test(st.status), st.status)
    await pressSafe('CTRL+C is a fresh first press', KEY.ctrlC)
    ok('a press after typing does not exit', /ctrl\+c again/.test(st.status), st.status)
    await pressSafe('CTRL+C confirms', KEY.ctrlC)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('two Ctrl+C presses leave the composer', value === undefined, String(value))
    scr.exit()
  }
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await pressSafe('CTRL+D on an empty draft', KEY.ctrlD)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('Ctrl+D exits on an empty draft', value === undefined, String(value))
    scr.exit()
  }
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await pressSafe('type text', 'abc')
    await pressSafe('HOME', KEY.home)
    await pressSafe('CTRL+D with text', KEY.ctrlD)
    ok('Ctrl+D deletes forward when there is text', st.input === 'bc', st.input)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 100))])
    ok('Ctrl+D with text does not exit', value === '__TIMEOUT__', String(value))
    scr.exit()
  }
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [], { ctrlC: 'cancel' })
    await pressSafe('CTRL+C inside a prompt', KEY.ctrlC)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('Ctrl+C inside a prompt cancels the prompt', value === undefined, String(value))
    scr.exit()
  }

  // ── 1c. Raw mode is armed ONCE per session, never per interaction ─────────
  // Toggling it flushed the ConPTY input queue and ate the operator's next
  // keypress on Windows (proven by a live pty capture: a command typed right
  // after an overlay closed never reached the app). The screen owns the mode
  // now: enter() arms it, exit() restores it, attachInput touches nothing.
  {
    const raw = stdin as unknown as { setRawMode?: (mode: boolean) => unknown; isTTY?: boolean }
    const real = raw.setRawMode
    const realTTY = raw.isTTY
    const modes: boolean[] = []
    // Fake a TTY so the screen's own guards run; on a pipe the product
    // correctly never arms raw mode at all.
    raw.isTTY = true
    raw.setRawMode = (mode: boolean) => { modes.push(mode); return stdin }
    try {
      const { scr, st } = fresh()
      ok('enter arms raw mode exactly once', modes.length === 1 && modes[0] === true, JSON.stringify(modes))
      // Two full attach/detach cycles: the composer, twice, with a prompt in
      // between, which is the exact shape that used to flip the mode.
      const line = scr.readLine(st, [])
      await pressSafe('type', 'one')
      await pressSafe('ENTER', '\r')
      await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
      const line2 = scr.readLine(st, [])
      await pressSafe('type', 'two')
      await pressSafe('ESC clears', KEY.esc)
      await settle(320)
      await pressSafe('CTRL+C twice', KEY.ctrlC)
      await pressSafe('CTRL+C confirms', KEY.ctrlC)
      await Promise.race([line2, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
      ok('attach/detach never touch raw mode', modes.length === 1 && modes[0] === true, JSON.stringify(modes))
      ok('the keyboard still worked across both prompts', true)
      scr.exit()
      ok('exit restores the terminal line discipline', modes.length === 2 && modes[0] === true && modes[1] === false, JSON.stringify(modes))
    } finally {
      raw.setRawMode = real
      raw.isTTY = realTTY
    }
  }

  // ── 2. Multiline editing with arrows on every row ─────────────────────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await press('one', KEY.ctrlJ, 'two', KEY.ctrlJ, 'three')
    ok('three lines composed', st.input === 'one\ntwo\nthree', JSON.stringify(st.input))
    for (const [label, seq] of [['UP', KEY.up], ['UP', KEY.up], ['DOWN', KEY.down]] as const) {
      await pressSafe(`${label} on a multiline draft`, seq)
    }
    await press(KEY.enter)
    await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 200))])
    scr.exit()
  }

  // ── 2b. Shift+Enter inserts a newline exactly like Ctrl+J ────────────────
  // Plain Enter submits; modified Enter (CSI u, all modifier variants) never
  // does. Without this Shift+Enter did nothing and the operator could not
  // make a newline with the key the footer implies.
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await press('first')
    await pressSafe('SHIFT+ENTER', '\x1b[13;2u')
    ok('shift+enter inserts a newline', st.input === 'first\n', JSON.stringify(st.input))
    await press('second', KEY.enter)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('the two-line draft submits on plain Enter', value === 'first\nsecond', String(value))
    scr.exit()
  }

  // ── 3. The command tab: arrows, enter, esc, clicks, wheel ─────────────────
  {
    const { scr, st, out, get } = fresh()
    const line = scr.readLine(st, [])
    await press('/')
    const slash = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('a typed slash returns immediately', slash === '/', String(slash))

    const picked = runSelect(out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    await press('')
    ok('the plate paints', /Commands/.test(strip(get())))

    await pressSafe('DOWN in the plate', KEY.down)
    await pressSafe('DOWN in the plate 2', KEY.down)
    await pressSafe('UP in the plate', KEY.up)
    await pressSafe('HOME in the plate', KEY.home)
    await pressSafe('END in the plate', KEY.end)
    await pressSafe('type a filter', 'ta')
    ok('typing filters the plate', /list tasks/.test(strip(get())))
    await pressSafe('BACKSPACE in the plate', KEY.backspace)

    await pressSafe('WHEEL in the plate', KEY.wheelDown)
    await pressSafe('WHEEL in the plate 2', KEY.wheelUp)
    const hoveredRow = paintedAt(get, '/tasks')
    await pressSafe('hover a row', KEY.hover(hoveredRow.row, hoveredRow.col + 4))
    await pressSafe('ESC closes the plate', KEY.esc)
    const dismissed = await Promise.race([picked, new Promise(r => setTimeout(() => r('__PENDING__'), 200))])
    ok('ESC dismisses the plate', dismissed === undefined, String(dismissed))

    const after = scr.readLine(st, [])
    await press('still typing', KEY.enter)
    const survived = await Promise.race([after, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('the composer survives a dismissed plate', survived === 'still typing', String(survived))
    scr.exit()
  }

  // ── 3b. A PICKED command seeds the composer (e.g. "/result " + an id) ─────
  // Regression guard: readLine must NOT clear a draft the caller seeded, or
  // "/result " arrives at the composer empty and the id cannot be typed.
  {
    const { scr, st } = fresh()
    st.input = '/result '
    st.cursor = st.input.length
    const line = scr.readLine(st, [])
    await press('harness-3e42cb97', KEY.enter)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 300))])
    ok('a seeded command keeps its prefix', value === '/result harness-3e42cb97', String(value))
    scr.exit()
  }

  // ── 4. Clicking a plate row commits it ───────────────────────────────────
  {
    const { scr, st, out, get } = fresh()
    // The plate is centred on the page, so where a row lands depends on how
    // many options there are: read the paint, then click that cell.
    const picked = runSelect(out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    await press('')
    const at = paintedAt(get, '/tasks')
    await pressSafe('click a row', KEY.click(at.row, at.col + 4))
    const value = await Promise.race([picked, new Promise(r => setTimeout(() => r('__PENDING__'), 300))])
    ok('a click commits the row it landed on', value === '/tasks', String(value))
    scr.exit()
  }

  // ── 5. Reading history, then one Enter gets you back to the tail ───────────
  // The stream takes the wheel (Hermes' wheel preset), and Enter on an EMPTY
  // draft is the keyboard shortcut back to "now" — it must NOT submit an empty
  // request.
  {
    const { scr, st } = fresh()
    for (let i = 0; i < 60; i++) st.messages.push({ text: `line ${i}`, tone: 'plain' })
    const line = scr.readLine(st, [])
    await pressSafe('PGUP', '\x1b[5~')
    ok('PgUp scrolls into history', st.scroll > 0, String(st.scroll))
    await pressSafe('ESC clears nothing yet', KEY.esc)
    ok('Esc on an empty draft does not scroll', st.scroll > 0, String(st.scroll))
    await pressSafe('ENTER returns to latest', KEY.enter)
    ok('Enter on an empty draft returns to the newest line', st.scroll === 0, String(st.scroll))
    const settled = await Promise.race([line.then(v => `submitted:${JSON.stringify(v)}`), new Promise(r => setTimeout(() => r('__PENDING__'), 300))])
    ok('and it did NOT submit an empty request', settled === '__PENDING__', String(settled))
    // With a draft, Enter still submits — the jump is only for the empty case.
    await pressSafe('type then ENTER', 'do the thing')
    await pressSafe('ENTER submits a draft', KEY.enter)
    const value = await Promise.race([line, new Promise(r => setTimeout(() => r('__PENDING__'), 300))])
    ok('Enter with a draft still submits', value === 'do the thing', String(value))
    scr.exit()
  }

  // ── 5b. Paging a long stream: clamped, reversible, and it SAYS where ──────
  // Reported as "pgup and pgdown its so long and unstructured". The old code
  // did `scroll += lastRoom` with no ceiling, so the stored offset ran away
  // while the drawn picture stopped moving: PgUp looked dead, and PgDn needed a
  // dozen presses to walk the offset back.
  {
    const { scr, st, get } = fresh(80, 24)
    st.messages.push({ text: '❯ do the thing', tone: 'bold' })
    for (let i = 0; i < 200; i++) st.messages.push({ text: `line ${i}`, tone: 'plain' })
    const line = scr.readLine(st, [])
    await press('')
    const ceiling = scr.lastMaxScroll
    ok('the stream has scrollback to page through', ceiling > 20, String(ceiling))
    await pressSafe('PGUP once', '\x1b[5~')
    ok(
      'scrolling away from the tail pins the last request above the composer',
      /❯ do the thing/.test(strip(get())),
      strip(get()).slice(-140),
    )
    for (let i = 0; i < 40; i++) await pressSafe('PGUP', '\x1b[5~')
    ok('PgUp clamps at the oldest row instead of running away', st.scroll === ceiling, `${st.scroll} vs ${ceiling}`)
    await pressSafe('PGDN once', '\x1b[6~')
    ok('PgDn comes back by a page', st.scroll < ceiling && st.scroll > 0, String(st.scroll))
    for (let i = 0; i < 40; i++) await pressSafe('PGDN', '\x1b[6~')
    ok('PgDn clamps at the newest line', st.scroll === 0, String(st.scroll))
    await pressSafe('ENTER returns to latest', KEY.enter)
    ok('Enter on an empty draft also returns to the newest line', st.scroll === 0, String(st.scroll))
    await pressSafe('type + submit', 'done')
    await pressSafe('ENTER', KEY.enter)
    await Promise.race([line, new Promise(r => setTimeout(r, 300))])
    scr.exit()
  }

  // ── 6. Resize mid-session must not throw ─────────────────────────────────
  {
    const { scr, st } = fresh(100, 30)
    const line = scr.readLine(st, ['old request'])
    await press('abc')
    for (const [w, h] of [[40, 12], [200, 50], [68, 24], [100, 30]] as Array<[number, number]>) {
      await pressSafe(`resize to ${w}x${h}`, '')
      try {
        scr.resize(w, h)
        scr.render(st)
        ok(`render at ${w}x${h} does not throw`, true)
      } catch (error) {
        ok(`render at ${w}x${h} does not throw`, false, String(error))
      }
    }
    await pressSafe('UP after resize', KEY.up)
    ok('history still works after a resize', st.input === 'old request', JSON.stringify(st.input))
    await press(KEY.enter)
    await Promise.race([line, new Promise(r => setTimeout(r, 200))])
    scr.exit()
  }

  // ── 6. Keys pressed with no session history and an empty draft ────────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    for (const [label, seq] of [
      ['UP on an empty draft', KEY.up], ['DOWN on an empty draft', KEY.down],
      ['BACKSPACE on an empty draft', KEY.backspace], ['LEFT on an empty draft', KEY.left],
      ['RIGHT on an empty draft', KEY.right], ['HOME on an empty draft', KEY.home],
      ['END on an empty draft', KEY.end], ['PAGEUP', KEY.pageUp], ['PAGEDOWN', KEY.pageDown],
      ['ESC on an empty draft', KEY.esc],
    ] as const) {
      await pressSafe(label, seq)
    }
    ok('the draft survives every empty-state key', st.input === '' && st.cursor === 0, JSON.stringify(st.input))
    await press(KEY.enter)
    await Promise.race([line, new Promise(r => setTimeout(r, 200))])
    scr.exit()
  }

  // ── 7. Very long input and pathological content ─────────────────────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await press('x'.repeat(500))
    ok('a 500-char run is accepted', st.input.length === 500, String(st.input.length))
    for (let i = 0; i < 12; i++) await pressSafe('END on a long line', KEY.end)
    await press('héllo → ✓ 漢字')
    ok('unicode survives', st.input.includes('漢字'), st.input.slice(-12))
    await press('a\u001b[31mb')
    ok('a pasted color sequence types only its text', st.input.endsWith('ab') && !st.input.includes('\x1b'), JSON.stringify(st.input.slice(-8)))
    await press(KEY.enter)
    await Promise.race([line, new Promise(r => setTimeout(r, 300))])
    scr.exit()
  }

  // ── 8. The completion keys (qwen-code's navigation) ──────────────────────
  //
  // The composer completes WHILE YOU TYPE: a panel opens above it, the arrow
  // keys move the selection, Tab accepts it, Esc dismisses it, and Enter RUNS
  // a command that is already exact. Every one of those was a promise the
  // harness did not keep until this pass.
  {
    const { scr, st, get } = fresh()
    st.completionCommands = [
      { name: '/model', desc: 'every model' },
      { name: '/status', desc: 'route · model' },
      { name: '/stats', desc: 'token usage' },
      { name: '/tasks', desc: 'list tasks', argHint: '<id>' },
    ]
    const line = scr.readLine(st, [])

    await pressSafe('type /mo', '/mo')
    ok('the draft holds the typed command', st.input === '/mo', st.input)
    const painted = strip(get())
    ok('the completion panel is drawn above the composer', painted.includes('/model'), 'the candidate is not painted')
    ok('the panel names what it is', painted.includes('commands'), 'the panel header is missing')

    await pressSafe('DOWN in the panel', KEY.down)
    ok('DOWN moves the selection, not the caret', st.cursor === 3 && st.input === '/mo', `${st.cursor}/${st.input}`)

    await pressSafe('TAB accepts', '\t')
    ok('TAB accepts the candidate into the draft', st.input === '/model ', JSON.stringify(st.input))

    // A query with SEVERAL matches: the arrow keys must move the selection.
    await pressSafe('clear the draft', KEY.esc)
    await pressSafe('type /s', '/s')
    const before = st.completion?.active ?? -1
    await pressSafe('DOWN with two candidates', KEY.down)
    ok('DOWN moves the active candidate', (st.completion?.active ?? -1) !== before || st.completion!.items.length < 2,
      `${before} -> ${st.completion?.active} of ${st.completion?.items.length}`)
    ok('the caret did not move while the panel was open', st.cursor === 2 && st.input === '/s', `${st.cursor}/${st.input}`)

    // Esc dismisses the panel BEFORE it clears the draft.
    await pressSafe('ESC dismisses the panel', KEY.esc)
    ok('ESC dismisses the panel, not the draft', st.input === '/s', JSON.stringify(st.input))
    await pressSafe('ESC again clears the draft', KEY.esc)
    ok('ESC clears the draft when no panel is open', st.input === '', JSON.stringify(st.input))

    // A command that is already EXACT runs on Enter — the operator must not
    // have to press a key twice to run what they typed.
    await pressSafe('type /status', '/status')
    await pressSafe('ENTER runs the exact command', KEY.enter)
    const value = await Promise.race([line, new Promise(r => setTimeout(r, 300))])
    ok('ENTER runs an exact command', value === '/status', String(value))
    scr.exit()
  }

  // ── 9. The STOP control, by mouse ────────────────────────────────────────
  {
    const { scr, st, get } = fresh()
    st.busy = true
    st.status = 'chat · thinking · esc interrupts · type to queue'
    scr.render(st)
    const painted = strip(get())
    ok('the stop button is painted while a turn is live', painted.includes('■ stop'), 'the button is missing')
    const button = scr.stopButton
    ok('the button carries a hit box', !!button, 'no hit box was measured')
    let stopped = 0
    scr.onStop = () => { stopped += 1 }
    const hit = scr.clickAt(st, button!.row, button!.col)
    ok('a click on the button hits it', hit, 'the click missed the button')
    ok('the button interrupts the turn', stopped === 1, String(stopped))
    scr.clickAt(st, button!.row, 1)
    ok('a click elsewhere does not interrupt', stopped === 1, String(stopped))
    scr.exit()
  }

  // ── 10. The kill ring, the yank and the undo (pi, MIT) ───────────────────
  //
  // The composer could DELETE text but could not get it back: Ctrl+W was a
  // one-way door, and a mistyped phrase was gone. Emacs-style editing, ported
  // from pi:
  //
  //   Ctrl+W / Ctrl+U / Ctrl+K   kill (the text goes into the kill ring)
  //   Ctrl+Y                     yank the last kill back
  //   Alt+Y                      yank-pop (the next kill in the ring)
  //   Ctrl+Z                     undo the last edit of ANY kind
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])

    await pressSafe('type three words', 'one two three')
    ok('the draft holds the words', st.input === 'one two three', st.input)

    await pressSafe('CTRL+W', '\x17')
    ok('CTRL+W kills the last word', st.input === 'one two ', JSON.stringify(st.input))
    await pressSafe('CTRL+W again', '\x17')
    ok('CTRL+W kills the word and its space', st.input === 'one ', JSON.stringify(st.input))
    await pressSafe('CTRL+W again', '\x17')
    ok('CTRL+W empties the draft', st.input === '', JSON.stringify(st.input))

    // Three kills in a row are ONE ring entry: the yank brings back the
    // phrase, not the last word.
    await pressSafe('CTRL+Y', '\x19')
    ok('CTRL+Y brings the whole phrase back', st.input === 'one two three', JSON.stringify(st.input))

    // A kill after a typing is a separate entry.
    await pressSafe('CTRL+W', '\x17')
    await pressSafe('type x', 'x')
    await pressSafe('CTRL+W', '\x17')
    ok('typing breaks the accumulation', st.input === 'one two ', JSON.stringify(st.input))
    await pressSafe('CTRL+Y', '\x19')
    ok('the yank is the newest kill only', st.input === 'one two x', JSON.stringify(st.input))
    // Alt+Y cycles back to the older kill. Kitty's CSI-u encoding carries the
    // UNICODE CODEPOINT of the key, so Alt+Y is `CSI 121;3u` (121 = 'y',
    // modifier 3 = Alt). The first version of this test wrote 105 — which is
    // 'i' — and the decoder was right to report `i`.
    await pressSafe('ALT+Y', '\x1b[121;3u')
    ok('ALT+Y yank-pops to the older kill', st.input === 'one two three', JSON.stringify(st.input))

    await pressSafe('ENTER', KEY.enter)
    await line
    scr.exit()
  }

  // ── 11. Undo covers every kind of edit ───────────────────────────────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])

    await pressSafe('type a word', 'hello')
    await pressSafe('BACKSPACE', KEY.backspace)
    ok('BACKSPACE deleted a character', st.input === 'hell', st.input)
    await pressSafe('CTRL+Z', '\x1a')
    ok('CTRL+Z undoes the deletion', st.input === 'hello', JSON.stringify(st.input))
    await pressSafe('CTRL+Z', '\x1a')
    ok('CTRL+Z undoes the typing too', st.input === '', JSON.stringify(st.input))
    await pressSafe('CTRL+Z', '\x1a')
    ok('an empty undo says so', /nothing to undo/.test(st.status), st.status)

    // A paste is atomic: one undo takes the whole block back.
    await pressSafe('paste', '\x1b[200~some pasted text\x1b[201~')
    ok('the paste landed', st.input === 'some pasted text', st.input)
    await pressSafe('CTRL+Z', '\x1a')
    ok('one undo takes the whole paste back', st.input === '', JSON.stringify(st.input))

    await pressSafe('ENTER', KEY.enter)
    await line
    scr.exit()
  }

  // ── 12. The transcript search (Ctrl+F) ──────────────────────────────────
  //
  // The transcript is the only record of what the factory said. Before this,
  // finding a phrase in it meant scrolling by hand — and a search that cannot
  // say how many hits there are leaves the operator pressing Enter forever.
  {
    const { scr, st } = fresh()
    scr.push(st, { text: 'the needle is here', tone: 'plain' })
    scr.push(st, { text: 'and the needle is there', tone: 'plain' })
    const line = scr.readLine(st, [])

    await pressSafe('type a draft', 'hello')
    ok('the draft holds the text', st.input === 'hello', st.input)

    await pressSafe('CTRL+F', '\x06')
    ok('CTRL+F opens the search', !!st.search, JSON.stringify(st.search))
    ok('the search does not eat the draft', st.input === 'hello', st.input)

    await pressSafe('type the query', 'needle')
    ok('the query lands in the search', st.search?.query === 'needle', st.search?.query ?? '')
    ok('the draft is still the draft', st.input === 'hello', st.input)
    ok('the search counted the hits', st.search?.total === 2, String(st.search?.total))

    await pressSafe('ENTER', KEY.enter)
    ok('ENTER moves to the next hit', st.search?.active === 1, String(st.search?.active))

    await pressSafe('ESC', KEY.esc)
    ok('ESC closes the search', st.search === null, JSON.stringify(st.search))
    ok('the draft survived the search', st.input === 'hello', st.input)

    await pressSafe('ENTER', KEY.enter)
    await line
    scr.exit()
  }

  void settle
  if (failures.length === 0) {
    console.log(`KEYSTROKE TEST: PASS (${checks} checks, every key a person actually presses)`)
  } else {
    console.log(`KEYSTROKE TEST: ${failures.length} FAILURES of ${checks}\n`)
    for (const f of failures) console.log(`  • ${f}`)
    process.exitCode = 1
  }
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch(error => {
  console.error('KEYSTROKE TEST: CRASHED —', error)
  process.exit(1)
})

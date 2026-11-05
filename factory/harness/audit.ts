/**
 * TUI GEOMETRY AUDIT — finds alignment bugs mechanically.
 *
 * Screenshots are how the bugs were REPORTED; this is how they get FOUND.
 * Every invariant the layout promises is checked across a matrix of terminal
 * sizes and screen states, so a regression shows up as a failing assertion
 * rather than as "something looks off" in a screenshot.
 *
 *   npx tsx factory/harness/audit.ts
 *
 * Exit code is non-zero when any check fails, so it can gate a stop.
 */
import { COMPOSER_HINTS, SELECT_ROW_MARK, Screen, initialState, overlayFromRows, visibleWidth, bootSplashRows, eventMessage, selectLines, selectSection, type SelectOption } from './screen.js'
import { renderHelp } from './help.js'
import { gatePlateRows, gatePlateRowsFor } from './plate.js'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

interface Failure { check: string; detail: string }
const failures: Failure[] = []
const passes: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes.push(name)
  else failures.push({ check: name, detail })
}

/** Render one state at one size and return the stripped frame rows. */
function render(
  size: [number, number],
  build: (scr: Screen, st: ReturnType<typeof initialState>) => void,
): string[] {
  const [w, h] = size
  const out = { columns: w, rows: h, isTTY: true, write: () => true } as unknown as NodeJS.WriteStream
  const scr = new Screen(out, w, h)
  const st = initialState('WEDNESDAY', 'mode live · qwen2.5-coder-3b')
  st.composerLabel = 'qwen2.5-coder-3b'
  build(scr, st)
  // Repaints are incremental (only changed rows reach the terminal), so the byte
  // stream is a patch. `painted()` is the whole frame as the screen has it —
  // which is what a layout invariant is actually about.
  return scr.painted().map(strip)
}
const SIZES: Array<[number, number]> = [
  // DEGENERATE first, and these are not hypothetical: dragging a window edge
  // reports a run of tiny intermediate sizes before the final one, so an
  // ordinary resize briefly asks for a one-column frame. `fitWidth` used to
  // answer ANY width under 8 with an 80-column fallback, so a 1x1 window was
  // handed an 80x24 frame - more cells than the terminal has, which a terminal
  // answers by scrolling the page out from under the operator. The frame now
  // honours the real size and every row is clipped to it as the last step, so
  // these sizes are ordinary rather than exceptional.
  [1, 1], [2, 2], [4, 4], [6, 3], [8, 4], [12, 6], [3, 40], [16, 8],
  // Genuinely small next: a 24-column window is a split pane on a laptop, and
  // it is where fixed-length English and un-truncated padding used to break the
  // frame. Small sizes are not an edge case, they are a normal way to work.
  [24, 10], [28, 12], [32, 14], [36, 16],
  [40, 18], [44, 20], [60, 18], [68, 24], [80, 24],
  [100, 30], [120, 32], [132, 40], [160, 44], [200, 50],
]

/**
 * Sizes where a composer box can exist at all: three rows of header, three of
 * box and one of status, plus enough columns for the box's own width floor.
 *
 * Below this the frame is still CORRECT - exactly `h` rows, nothing over-width -
 * it simply has no room for a prompt. Asserting a closed box at 1x1 would be
 * asserting that a thing which cannot exist, does; and the previous behaviour
 * (clamping every width under 8 up to 80) meant those sizes were never really
 * tested anyway, they were tested at 80. Every previously-audited size - the
 * smallest was 24x10 - is far above this line, so no coverage is lost.
 */
const COMPOSER_SIZES = SIZES.filter(([w, h]) => w >= 16 && h >= 10)

/**
 * Sizes where fixed-content surfaces (the splash, the help plate) can be drawn
 * at all. Their widest row is 14 columns; below that they cannot fit, and
 * asserting they do would be asserting the impossible. 20 columns is well under
 * the narrowest size this audit covered before the degenerate sizes were added
 * (24x10), so no coverage is lost.
 */
const CONTENT_SIZES = SIZES.filter(([w]) => w >= 20)

/**
 * Sizes where the approval card can show its whole argument. It is the widest
 * fixed surface in the app - a sentence about what approval permits, plus both
 * buttons - so it needs real room. 24x10 is exactly the narrowest size this audit
 * covered before the degenerate sizes were added, so nothing is lost.
 */
const DIALOG_SIZES = SIZES.filter(([w, h]) => w >= 24 && h >= 10)

/** Sizes where a bordered plate can exist: 5 columns of rails, 6 rows of chrome. */
const PLATE_SIZES = SIZES.filter(([w, h]) => w >= 12 && h >= 8)


const STATES: Array<[string, (scr: Screen, st: ReturnType<typeof initialState>) => void]> = [
  ['home', (scr, st) => { st.home = true; st.side = null; st.status = ''; scr.render(st) }],
  ['home+narrow', (scr, st) => { st.home = true; st.status = ''; st.input = 'add a regression test for the token refresh path'; st.cursor = st.input.length; scr.render(st) }],
  ['home+rail', (scr, st) => { st.home = true; st.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }; st.status = ''; scr.render(st) }],
  ['home+typed', (scr, st) => { st.home = true; st.status = ''; st.input = 'add a regression test for the token refresh path'; st.cursor = st.input.length; scr.render(st) }],
  ['stream', (scr, st) => {
    st.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }
    for (const m of ['task.created', 'agent.started', 'agent.completed', 'verification.started', 'task.completed']) {
      st.messages.push(eventMessage(m))
    }
    st.status = COMPOSER_HINTS
    scr.render(st)
  }],
  ['stream+busy', (scr, st) => {
    st.side = { title: 'fix login leak', tokens: 870, limit: 13312 }
    st.busy = true
    st.status = 'working… esc interrupts'
    scr.render(st)
  }],
  ['stream+crew', (scr, st) => {
    st.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }
    st.busy = true
    st.crew = [
      { role: 'planner', phase: 'done' },
      { role: 'coder', phase: 'working', detail: 'write_file', startedAt: Date.now() - 12_000 },
      { role: 'tester', phase: 'verifying', detail: 'npm test', startedAt: Date.now() - 4_000 },
      { role: 'reviewer', phase: 'reviewing', startedAt: Date.now() - 1_000 },
    ]
    st.status = 'working… esc interrupts'
    scr.render(st)
  }],
  ['stream+dialog', (scr, st) => {
    st.dialog = { title: 'Ready to run', body: 'Fix: the login leak\nWhere: C:\\wednesday\nVerify: npm test', prompt: 'Run it? [y/N]' }
    scr.render(st)
  }],
  ['stream+toast', (scr, st) => { st.toast = 'local proxy upstream changed'; st.status = 'ready'; scr.render(st) }],
  ['multiline', (scr, st) => { st.input = 'first line\nsecond line\nthird'; st.cursor = st.input.length; scr.render(st) }],
  ['scrolled', (scr, st) => {
    for (let i = 0; i < 60; i++) st.messages.push({ text: `line ${i}`, tone: 'plain' })
    st.scroll = 12
    scr.render(st)
  }],
]

/** Look a state up by name: indexes silently retarget when a state is added. */
const stateByName = (name: string): (typeof STATES)[number][1] => {
  const found = STATES.find(([label]) => label === name)
  if (!found) throw new Error(`audit state not found: ${name}`)
  return found[1]
}

// ── A. every frame is exactly the terminal size ─────────────────────────────
// Frames are exactly h rows: homeFrame builds h rows, the stream path slices
// to h. Fewer rows would mean a short write (stale rows behind); more rows
// would scroll the terminal.
for (const size of SIZES) {
  for (const [name, build] of STATES) {
    const rows = render(size, build)
    const [w, h] = size
    const bad = rows.filter(r => visibleWidth(r) !== w)
    check(
      `rows are exactly ${w} cols (${name} @ ${w}x${h})`,
      bad.length === 0,
      bad.length ? `${bad.length} row(s): widths ${[...new Set(bad.map(r => visibleWidth(r)))].join(',')}` : '',
    )
    check(
      `row count is exactly ${h} (${name} @ ${w}x${h})`,
      rows.length === h,
      `got ${rows.length}`,
    )
  }
}

// ── B. the composer box is a closed rectangle ───────────────────────────────
// Top rail, body rows and bottom rail must all be the SAME width, or the
// right-hand corners do not line up (the reported "line error").
for (const size of COMPOSER_SIZES) {
  for (const [name, build] of [['home', stateByName('home')], ['stream', stateByName('stream')], ['multiline', stateByName('multiline')]] as const) {
    const rows = render(size, build)
    const [w] = size
    // The LAST rounded box is the composer. Home also draws the banner in the
    // same `╭…╮` grammar, and the old `findIndex` measured the banner instead —
    // a false pass that only showed up once the banner existed.
    const top = rows.findLastIndex(r => r.includes('╭'))
    if (top < 0) continue
    const bottom = rows.findLastIndex(r => r.includes('╰'))
    if (bottom < 0) { check(`composer bottom rail found (${name} @ ${w})`, false); continue }
    // The box is CENTRED on home and flush-left on the stream view, so every
    // measurement is taken from the box's own left edge. Rows are padded to the
    // full terminal width, so `.length` measures the terminal, not the box.
    const left = rows[top]!.indexOf('╭')
    // Box width = left border to the CLOSING CORNER of the top rail. The bottom
    // rail's last column is the context `┃` when a rail is present, so it is
    // not the authority for the box edge.
    const topRight = rows[top]!.lastIndexOf('╮')
    const bottomRight = rows[bottom]!.lastIndexOf('╯')
    const boxWidth = topRight - left + 1
    const widths = new Set<number>()
    widths.add(boxWidth)
    widths.add(bottomRight - left + 1)
    const badRight: number[] = []
    for (let i = top + 1; i < bottom; i++) {
      const rightCol = left + boxWidth - 1
      const ch = rows[i]![rightCol]
      if (ch !== '│') badRight.push(i)
    }
    check(
      `composer rails share one width (${name} @ ${w})`,
      widths.size === 1,
      `top ${[...widths][0]} vs bottom rail — corners cannot line up`,
    )
    check(
      `composer right border is continuous (${name} @ ${w})`,
      badRight.length === 0,
      `${badRight.length} body row(s) break at column ${left + boxWidth - 1}`,
    )
    check(
      `composer left border is continuous (${name} @ ${w})`,
      rows.slice(top, bottom + 1).every(r => r[left] === '╭' || r[left] === '│' || r[left] === '╰'),
      'left border broken',
    )
  }
}

// ── C. the home page is full-width, Hermes grammar ──────────────────────────
// Hermes' banner and prompt span the terminal; there is no centred column.
// Every non-blank row starts at column 0 (a frame rule, a panel rail, a prompt
// mark, or wrapped prose). A stray indent means the old centred layout leaked
// back in.
for (const size of COMPOSER_SIZES) {
  for (const [name, build] of [['home', stateByName('home')], ['home+typed', stateByName('home+typed')]] as const) {
    const rows = render(size, build)
    const [w] = size
    // The composer is its own grammar: wrapped input rows align two cells in,
    // under the text after `❯ `. They are not a leaked centred column.
    const promptAt = rows.findIndex(r => r.includes('❯'))
    const closeAt = rows.findIndex((r, i) => i > promptAt && /^─+$/.test(r.trimEnd()))
    // The wordmark above the banner is bitmap art: its rows legitimately begin
    // with spaces that belong to the glyphs. Art is only exempt ABOVE the
    // banner (or anywhere when no banner fit), never inside the content.
    const bannerTop = rows.findIndex(r => /^[╭╔]/.test(r))
    const stray = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.trim().length > 0)
      .filter(({ r, i }) => {
        const first = r.search(/\S/)
        if (first === 0) return false
        if (/[█▀▄▖▗▘▝▙▛▜▟]/.test(r) && (bannerTop < 0 || i < bannerTop)) return false
        // The wordmark's caption is part of the same centred art block: it is
        // deliberately indented to sit under the bitmap, and nothing else on
        // the page is allowed to drift off column 0.
        if (/^·.*·$/.test(r.trim()) && r.includes('small open models')) return false
        if (promptAt >= 0 && i >= promptAt && i < closeAt) return false
        // The status meter is the one row with a one-cell lead-in:
        // ` ✦ model · ctx 28% · 1m`. Everything else is flush left.
        return !/^ ✦/.test(r)
      })
    check(
      `home content is flush left (${name} @ ${w})`,
      stray.length === 0,
      stray.length ? `rows ${stray.map(s => s.i).join(',')} start indented` : '',
    )
  }
}

// ── D. the caret sits after the prompt mark ─────────────────────────────────
for (const size of COMPOSER_SIZES) {
  for (const [name, build] of [['home', stateByName('home')], ['stream', stateByName('stream')]] as const) {
    const [w, h] = size
    let captured = ''
    const out = { columns: w, rows: h, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'mode live')
    st.composerLabel = 'qwen2.5-coder-3b'
    build(scr, st)
    const m = /\x1b\[(\d+);(\d+)H\x1b\[\?25h/.exec(captured)
    if (!m) { check(`caret addressed (${name} @ ${w})`, false); continue }
    const row = Number(m[1])
    const col = Number(m[2])
    const frameRows = scr.painted().map(strip)
    const promptAt = frameRows.findIndex(r => r.includes('❯'))
    check(
      `caret row is the prompt input line (${name} @ ${w})`,
      promptAt >= 0 && row === promptAt + 1,
      `caret row ${row}, prompt row ${promptAt + 1}`,
    )
    check(
      `caret column follows the prompt mark (${name} @ ${w})`,
      col === 3,
      `caret col ${col}`,
    )
  }
}

// ── E. no side rail; the meter carries the ledger ──────────────────────────
for (const size of COMPOSER_SIZES) {
  const [w] = size
  const rows = render(size, stateByName('home+rail'))
  check(`no side rail on the home page (${w})`, rows.every(r => !r.includes('┃')), 'a rail row survived')
  const home = render(size, stateByName('home'))
  // The meter opens with the brand star, one leading cell in (its old `⚡`
  // badge is gone: emoji are pictographs on Windows Terminal, not glyphs).
  check(`the meter is drawn (${w})`, home.some(r => /^ ✦ /.test(strip(r))), 'no meter row')
}

// ── F. the gate plate only uses safe quadrant blocks ─────────────────────────
{
  const safe = /^[\u2580\u2584\u2588\u258c\u2590\u2596-\u259f ]+$/
  const plate = gatePlateRows({ TERM: 'xterm-256color' })
  check('plate glyphs are quadrant-safe', plate.every(r => safe.test(strip(r))),
    plate.map(r => strip(r)).find(r => !safe.test(r))?.slice(0, 40) ?? '')
  check('plate rows are uniform width', new Set(plate.map(r => visibleWidth(strip(r)))).size === 1,
    [...new Set(plate.map(r => visibleWidth(strip(r))))].join(','))
  for (const cols of [20, 30, 44, 52, 60, 80, 120]) {
    const cropped = gatePlateRowsFor(cols, { TERM: 'xterm-256color' })
    const widths = [...new Set(cropped.map(r => visibleWidth(strip(r))))]
    check(`plate crops to exactly ${Math.min(cols, 52)} cols`, widths.length === 1 && widths[0] === Math.min(cols, 52),
      widths.join(','))
  }
}

// ── G. boot splash and /help transcript fit their width ─────────────────────
for (const size of CONTENT_SIZES) {
  const [w] = size
  for (const row of bootSplashRows(w)) {
    check(`splash row fits ${w}`, visibleWidth(strip(row)) <= w, `${visibleWidth(strip(row))} > ${w}`)
  }
  const helpFixture: Array<[string, string]> = [['/help', 'this help'], ['/exit', 'leave']]
  const helpOut = renderHelp(w, helpFixture, [{ title: 'Help', names: ['/help', '/exit'] }], [['--test "c"', 'verify']])
  for (const row of helpOut) {
    check(`help row fits ${w}`, row.text.length <= w, `${row.text.length} > ${w}: ${row.text}`)
  }
}

// ── H. the command plate is a closed, centred, bounded panel ────────────────
// The plate used to be a bare block of text floating above the composer: no
// border, an opencode amber wash for the active row, and pinned to the bottom
// of the window. Those are three separate "it does not go with our UI" reports,
// so all three are now mechanical checks at every size.
const PLATE_OPTIONS: SelectOption[] = [
  selectSection('Session'),
  { title: '/help', desc: 'this help', footer: 'commands', value: '/help' },
  { title: '/model', desc: 'show or select session model', footer: 'model', value: '/model ' },
  { title: '/tasks', desc: 'list persisted tasks', footer: 'tasks', value: '/tasks' },
  { title: '/health', desc: 'factory health', footer: 'health', value: '/health' },
  { title: '/agents', desc: 'crew profile', footer: 'agents', value: '/agents' },
  { title: '/exit', desc: 'leave the session', footer: 'exit', value: '/exit' },
]
// A bordered plate needs five columns for its rails plus a gutter each side, and
// six rows for its chrome. Below that it cannot exist without overflowing, and
// `runSelect` now declines to open rather than draw one that does not fit - so
// there is nothing to assert here.
for (const size of PLATE_SIZES) {
  const [w, h] = size
  // Mirrors runSelect/selectLines. The old `Math.max(20, panel)` here matched a
  // floor that no longer exists - and that floor was the bug: it made the plate
  // WIDER than a narrow terminal instead of narrower.
  const panel = Math.max(1, Math.min(w - 6, Math.max(34, Math.floor(w * 0.62))))
  const outer = Math.max(1, panel)
  for (const [label, filter, active] of [['all', '', 0], ['last', '', 99], ['filtered', 'ta', 1], ['none', 'zzz', 0]] as const) {
    // The select marker is stripped when the row is painted (plateRow), so the
    // audit has to strip it too — otherwise every "row" is 5 columns too wide
    // and no width assertion means anything.
    const rows = selectLines('Commands', PLATE_OPTIONS, filter, active, panel, h)
      .map(r => strip(r.startsWith(SELECT_ROW_MARK) ? r.slice(SELECT_ROW_MARK.length) : r))
    const at = `${label} @ ${w}x${h}`
    check(`plate fits the height (${at})`, rows.length <= h, `${rows.length} rows > ${h}`)
    check(`plate rows share one width (${at})`, new Set(rows.map(r => visibleWidth(r))).size === 1 && visibleWidth(rows[0]!) === outer,
      `widths ${[...new Set(rows.map(r => visibleWidth(r)))].join(',')} expected ${outer}`)
    check(`plate fits the width (${at})`, rows.every(r => visibleWidth(r) <= w), `widest ${Math.max(...rows.map(r => visibleWidth(r)))} > ${w}`)
    if (rows.length < 2) { check(`plate is framed (${at})`, false, 'no rows'); continue }
    check(`plate top rail closes (${at})`, rows[0] === `╭${'─'.repeat(outer - 2)}╮`, `got "${rows[0]!.slice(0, 12)}…" (${rows[0]!.length})`)
    check(`plate bottom rail closes (${at})`, rows[rows.length - 1] === `╰${'─'.repeat(outer - 2)}╯`, `got "${rows[rows.length - 1]!.slice(0, 12)}…"`)
    check(`plate body rows are closed (${at})`, rows.slice(1, -1).every(r => r.startsWith('│') && r.endsWith('│')), 'a body row is not framed')
    const carets = rows.filter(r => r.includes('›'))
    check(`exactly one selected row (${at})`, carets.length === (label === 'none' ? 0 : 1), `${carets.length} rows carry the caret`)
    // Placement is the overlay's job, so ask the overlay: the plate must be
    // centred on the page (straddling the middle), never parked on the
    // composer at the bottom, and always inside the window.
    const place = overlayFromRows(selectLines('Commands', PLATE_OPTIONS, filter, active, panel, h), panel, w, h)
    check(`plate is centred on the page (${at})`, place.top === Math.floor((h - rows.length) / 2), `top ${place.top}, expected ${Math.floor((h - rows.length) / 2)}`)
    check(`plate stays inside the window (${at})`, place.top >= 0 && place.top + rows.length <= h, `rows ${place.top}..${place.top + rows.length} in ${h}`)
    check(`plate is horizontally centred (${at})`, outer <= w && place.left === Math.floor((w - outer) / 2), `left ${place.left}, outer ${outer} in ${w}`)
  }
}

// ── I. the approval gate names both choices and the armed one ───────────────
for (const size of DIALOG_SIZES) {
  const [w] = size
  const rows = render(size, stateByName('stream+dialog'))
  const card = rows.join('\n')
  check(`approval gate shows both choices (${w})`, /1\. Run once/.test(card) && /2\. Deny/.test(card), 'a choice is missing')
  check(`approval gate explains Enter (${w})`, /↑\/↓.*Enter/.test(card) || /Enter confirm/.test(card), 'the keys are not spelled out')
  check(`approval gate is a double-ruled warn panel (${w})`, rows.some(r => r.startsWith('╔')) && card.includes('⚠ approval required'), 'no Hermes-style panel')
  check(`approval gate fits ${w}`, rows.every(r => visibleWidth(r) <= w), 'a row overflows')
}

// ── report ──────────────────────────────────────────────────────────────────
const total = passes.length + failures.length
if (failures.length === 0) {
  console.log(`TUI AUDIT: PASS (${total} checks across ${SIZES.length} sizes x ${STATES.length} states)`)
} else {
  console.log(`TUI AUDIT: ${failures.length} FAILURES of ${total} checks\n`)
  const byKind = new Map<string, string[]>()
  for (const f of failures) {
    const key = f.check.replace(/\d+/g, 'N')
    if (!byKind.has(key)) byKind.set(key, [])
    byKind.get(key)!.push(`${f.check}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  for (const [kind, list] of byKind) {
    console.log(`• ${kind}  (${list.length})`)
    for (const item of list.slice(0, 4)) console.log(`    ${item}`)
    if (list.length > 4) console.log(`    … and ${list.length - 4} more`)
  }
  process.exitCode = 1
}

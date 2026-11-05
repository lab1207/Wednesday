/**
 * TUI DESIGN BOARD — every screen the harness can draw, rendered through the
 * REAL code paths (Screen class, runSelect drawing, tui.ts classic printers)
 * into one HTML file. No mock-ups: if a frame looks wrong here, the CLI looks
 * wrong there.
 *
 *   npx tsx factory/harness/preview.ts [out.html]
 *
 * Default output: wednesday-theme/generated/tui-design.html — the GENERATED
 * board. wednesday-theme/tui-design.html is the hand-authored "Nevermore"
 * design record and is never written by this script; the two are different
 * artifacts and overwriting the record loses work.
 *
 * Design there, then the frame builders in this file are the port list (each
 * frame = one screen).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  COMPOSER_HINTS, Screen, bootSplashRows, brandTodoRow, busyStatus, diffLines, diffRow, eventMessage, foldTool, frameRows, initialState, ironPanel, mdLine,
  roundBox, selectLines, selectSection, toastMark, wednesdayMark, wednesdayCompact, overlayFromRows, plateRow, sliceVisible, visibleWidth,
  type EventDetail, type ScreenState, type SelectOption, type ToolFold,
} from './screen'
import { gatePlateRows } from './plate'
import { banner, formatEvent, previewTitle, stageHeader, statusLine, taskCard } from './tui'
import { GLYPH } from './screen'
// The REAL lists, not copies: the palette and the help plate on this board must
// be the ones the CLI draws, or the board is a mock-up wearing a real path's
// clothes. (They used to be local copies, and they drifted: the board kept
// showing a sectioned palette with no /agents long after the CLI went flat.)
import { HELP_COMMANDS, HELP_FLAGS, HELP_GROUPS, PALETTE } from './harness'
import { renderHelp } from './help'

// ── ANSI → HTML ──────────────────────────────────────────────────────────────
const TONE_256: Record<string, string> = {
  '254': 'plain', '245': 'dim', '108': 'fg108', '203': 'fg203', '214': 'fg214', '98': 'fg98',
}

function openSpan(code: string): string {
  if (code === '0') return '</span>'
  // Gate rows emit `0;38;2;…` (reset + truecolor in one SGR). Strip the reset
  // prefix so the color branches below see a clean code.
  const clean = code.startsWith('0;') ? code.slice(2) : code
  const wash = /^fg(\d+);bg(\d+)$/.exec(clean)
  if (wash) return `<span class="fg${wash[1]} bg${wash[2]}">`
  const bgOnly = /^48;5;(\d+)$/.exec(clean)
  if (bgOnly) return `<span class="bg${bgOnly[1]}">`
  // Truecolor from the baked plate (gatePlateRows defaults to 38;2/48;2).
  // Without these branches every plate run fell through to plain spans and
  // the design board rendered the gate monochrome.
  const trueFg = /^1?;?38;2;(\d+);(\d+);(\d+)$/.exec(clean)
  if (trueFg) return `<span style="color:rgb(${trueFg[1]},${trueFg[2]},${trueFg[3]})${clean.startsWith('1;') ? ';font-weight:bold' : ''}">`
  const trueBg = /^48;2;(\d+);(\d+);(\d+)$/.exec(clean)
  if (trueBg) return `<span style="background:rgb(${trueBg[1]},${trueBg[2]},${trueBg[3]})">`
  if (clean === '1') return '<span class="b">'
  if (clean === '7') return '<span class="rev">'
  const m = /^1;38;5;(\d+)$/.exec(clean) ?? /^38;5;(\d+)$/.exec(clean)
  if (m) return `<span class="${TONE_256[m[1]!] ?? 'plain'}${clean.startsWith('1;') ? ' b' : ''}">`
  return `<span class="plain">`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ansiToHtml(chunk: string): string {
  let s = chunk
    .replace(/\x1b\[38;5;(\d+)m\x1b\[48;5;(\d+)m/g, (_m, fg: string, bg: string) => `\x1b[fg${fg};bg${bg}m`)
    .replace(/\x1b\[\?1049[hl]/g, '')
    .replace(/\x1b\[\?25[hl]/g, '')
    .replace(/\x1b\[\d+;\d+H/g, '')
    .replace(/\x1b\[H/g, '\n')
  let out = ''
  // SGR params are digits and semicolons ONLY. A greedy [A-Za-z0-9;]+ here
  // eats the first letters of the styled text (`\x1b[38;5;245m` + `mode`
  // captured "245mm"), silently deleting characters from every frame.
  const re = /\x1b\[(fg\d+;bg\d+|[0-9;]*)m/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index))
    out += openSpan(m[1]!)
    last = m.index + m[0].length
  }
  out += esc(s.slice(last))
  // Trailing blank rows are noise in a design board.
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** Render one Screen state and return the final frame as HTML. */
function screenFrame(build: (screen: Screen, state: ScreenState) => void, width = 100, height = 26): string {
  const chunks: string[] = []
  const fakeOut = { write: (c: string) => { chunks.push(c); return true } }
  const screen = new Screen(fakeOut as unknown as NodeJS.WriteStream, width, height)
  const state = initialState(wednesdayCompact(), 'mode live · qwen2.5-coder-3b')
  state.composerLabel = 'qwen2.5-coder-3b'
  state.side = { title: 'fix login leak', tokens: 0, limit: 0 }
  screen.enter()
  build(screen, state)
  screen.render(state)
  // Repaints are incremental: the full paint is followed by row patches, each
  // in its own write. Replay the WHOLE stream so later writes replace earlier
  // ones (see frameRows) — taking "the last frame" out of the stream picks a
  // single patch row, not the screen.
  return ansiToHtml(frameRows(chunks.join('')).join('\n'))
}

// ── Frame catalogue ───────────────────────────────────────────────────────────

/**
 * Composite a floating plate over an already-rendered frame, the way the
 * terminal does it: the background rows stay, the plate is written into its
 * own rows/columns. This is what "the background is still visible behind the
 * popup" looks like on paper.
 */
function composite(baseRows: string[], plateRows: string[], left: number, top: number, width: number, height: number, plateWidth: number): string {
  const rows = [...baseRows]
  while (rows.length < height) rows.push('')
  plateRows.forEach((raw, i) => {
    const row = top + i
    if (row < 0 || row >= rows.length) return
    const plate = plateRow(raw, plateWidth)
    const head = sliceVisible(rows[row]!, 0, left)
    const tail = sliceVisible(rows[row]!, left + visibleWidth(plate))
    rows[row] = head + plate + tail
  })
  return rows.slice(0, height).map(r => r.padEnd(width)).join('\n')
}

/** Frame showing a select plate floating over the live home screen. */
function overlayFrame(title: string, options: SelectOption[], filter: string, active: number, width = 100, height = 26): string {
  const chunks: string[] = []
  const fakeOut = { write: (c: string) => { chunks.push(c); return true } }
  const screen = new Screen(fakeOut as unknown as NodeJS.WriteStream, width, height)
  const state = initialState(wednesdayCompact(), 'mode live · qwen2.5-coder-3b')
  state.composerLabel = 'qwen2.5-coder-3b'
  state.side = { title: 'fix login leak', tokens: 0, limit: 0 }
  state.home = true
  state.input = '/'
  state.cursor = 1
  state.status = COMPOSER_HINTS
  screen.enter()
  screen.render(state)
  // The SAME geometry the product uses (runSelect → overlayFromRows): centred on
  // the page. This frame used to hard-code the old bottom-anchored arithmetic,
  // so the record showed a plate floating in a place the CLI never puts it.
  const panelWidth = Math.min(width - 6, Math.max(34, Math.floor(width * 0.62)))
  const plate = selectLines(title, options, filter, active, panelWidth, height)
  const place = overlayFromRows(plate, panelWidth, width, height)
  return ansiToHtml(composite(screen.lastFrame, plate, place.left, place.top, width, height, place.width))
}

/** Every frame: [number, name, what it is, html]. One entry = one screen. */
const frames: Array<[string, string, string, string]> = []

function add(id: string, name: string, note: string, html: string): void {
  frames.push([id, name, note, html])
}

// A. Home
add('A0', 'Boot splash (designed, not shown at startup)', 'The one screen with no composer and no status line, so every row goes to the name. The wordmark is a 5 × 8 bitmap table — data, not a typeface — painted with half-block cells so every sub-pixel lands square: the old table drew pixels as whole cells, twice as tall as wide, and every letter came out a stretched bar (redrawn 2026-10-16). At ≥110 columns it doubles by nearest neighbour — two cells per pixel, never a stretch; at 57–109 the standard 53-cell size rides; below 57 the crest carries the page rather than a clipped name. KEPT AS A FRAME, NOT AS STARTUP: painted by `enter()` and overwritten by the first real frame a tick later, it was a flash rather than an intro. Startup goes straight to A1.', ansiToHtml(bootSplashRows(120).join('\n')))

add('A1', 'Home', 'The start page: the wordmark — the 5 × 8 half-block table at 53 cells, its feet fading into one accent rule — the tagline, one centred composer, one split footer (workspace left · key hints right). Below 57 columns, or without vertical room, the crest carries the page instead. No rail until a session exists; the first request clears the page.', screenFrame((screen, state) => {
  state.home = true
  state.side = null
  state.status = ''
  screen.render(state)
}, 100, 30))

add('A1n', 'Home (narrow — crest fallback)', 'When the box cannot hold the wordmark (narrow terminal, or no vertical room), it is dropped whole and the crest — the house name and the tagline — carries the page: type, not art. A wordmark that has to be clipped is not the same picture.', screenFrame((screen, state) => {
  state.home = true
  state.side = null
  state.status = ''
  screen.render(state)
}, 44, 20))

add('A3', 'Help plate', '/help is advertised in the footer and in the palette, so it is a real screen: two columns, verbs left and flags right — rendered from the same HELP_COMMANDS/HELP_FLAGS rows the live plate uses.', ansiToHtml(
  [...ironPanel('Help', renderHelp(96, HELP_COMMANDS, HELP_GROUPS, HELP_FLAGS).map(row => row.text), 96)].join('\n'),
))

// I. The quadrant engine (baked plate + ASCII tier)
add('I1', 'Nevermore gate plate', 'The real artwork, sampled into terminal cells: one U+2596–U+259F glyph per cell with an independent foreground and background tone, so each cell is 2 × 2 sub-pixels and the plate is 104 × 28 at two tones each. Baked by scripts/bake-plate.py; the CLI ships no rasteriser.', ansiToHtml(gatePlateRows({ TERM: 'xterm-256color' }).join('\n')))

add('H1', 'ASCII tier', 'WEDNESDAY_GLYPHS=ascii forces the Tier-A twins. The colour system still applies — only the marks change.', ansiToHtml(
  [
    '  -- WEDNESDAY -- WEDNESDAY_GLYPHS=ascii · no ornamental coverage --',
    '',
    ...[
      '*', 'agent.ready (orchestrator)',
      '+', 'task.started (coder)',
      'o', 'verification.started (tester)',
      '~', 'repair.started',
      '=', 'task.completed',
      'x', 'task.failed',
      '>', 'awaiting approval',
      '#', 'task.archived',
      '.', 'idle',
    ].reduce<string[]>((rows, item, i, all) => {
      if (i % 2 === 0) rows.push(`  ${item}`)
      else rows[rows.length - 1] = `${rows[rows.length - 1]}  ${item}`
      return rows
    }, []),
    '',
    '  Every mark has a twin chosen so the line still parses.',
  ].join('\n'),
))

add('A2', 'Home (with context rail)', 'A home page that carries a session on a wide terminal: the body centres in the main column and the Context rail takes the right edge — the same `[body][┃][panel]` join the session view uses. The CLI\'s startup home has no session, so it renders as A1.', screenFrame((screen, state) => {
  state.home = true
  state.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }
  state.status = ''
  screen.render(state)
}))

// B. Composer states
add('B1', 'Composer (empty)', 'Placeholder row + hint line. The idle resting state.', screenFrame((screen, state) => {
  screen.push(state, { text: `${GLYPH.hand.ornamental} ask for anything — a bug, a file, a benchmark run`, tone: 'dim' })
  state.status = COMPOSER_HINTS
}))

add('B2', 'Composer (typed)', 'Draft echoed inside the box with the model tag on the top rail.', screenFrame((screen, state) => {
  screen.push(state, { text: 'add a regression test for the token refresh path in server/auth.js', tone: 'dim' })
  state.input = 'add a regression test for the token refresh path in server/auth.js'
  state.cursor = state.input.length
  state.status = 'return to run · esc clears the draft'
}))

add('B3', 'Composer (multi-line)', 'Ctrl+J inserts a newline; one box row per logical line.', screenFrame((screen, state) => {
  screen.push(state, { text: 'two requests queued — the first runs, the second waits its turn', tone: 'dim' })
  state.input = 'fix the login leak in server/auth.js\nthen run the full test suite and report'
  state.cursor = state.input.length
  state.status = 'return to run · ctrl+j newline'
}))

// C. Stream + plan
const EVENT_TAPE: Array<[string, string?, EventDetail?]> = [
  ['task.created'],
  ['agent.started', 'architect'],
  ['tool.called', 'architect', { tool: 'files.read' }],
  ['tool.called', 'architect', { tool: 'files.read' }],
  ['tool.called', 'architect', { tool: 'files.grep' }],
  ['agent.completed', 'architect'],
  ['agent.started', 'planner'],
  ['tool.called', 'planner', { tool: 'knowledge.search' }],
  ['agent.completed', 'planner'],
  ['agent.started', 'coder'],
  ['tool.called', 'coder', { tool: 'opencode.coding-agent', note: 'PASS' }],
  ['verification.started'],
  ['tool.called', 'verifier', { tool: 'verification.setup', note: 'PASS' }],
  ['tool.called', 'verifier', { tool: 'verification.test', note: 'PASS' }],
  ['tool.called', 'verifier', { tool: 'verification.test', note: 'PASS' }],
  ['tool.called', 'verifier', { tool: 'verification.test', note: 'FAIL' }],
  ['repair.started', undefined, { note: 'attempt 1' }],
  ['verification.completed'],
  ['review.completed', 'reviewer'],
  ['task.completed'],
]

add('C1', 'Stream (full run)', 'Every Factory event mapped to a rail row, in order. A tool row NAMES its tool and its outcome, and repeated identical calls fold into one row (`×3`) with the failure count kept - the full trail stays in /events. `/display quiet|normal|verbose` picks how much of this rail survives.', screenFrame((screen, state) => {
  // The fold replayed exactly as the live sink does it: same tool, same seat,
  // still the tail -> rewrite; anything else -> a new row.
  let fold: ToolFold | null = null
  let at = -1
  for (const [type, role, detail] of EVENT_TAPE) {
    if (type === 'tool.called') {
      const next = foldTool(fold, detail?.tool ?? 'tool', role ?? 'agent', detail?.note)
      fold = next.fold
      if (next.merged && at >= 0) state.messages[at] = next.row
      else { state.messages.push(next.row); at = state.messages.length - 1 }
      continue
    }
    fold = null
    state.messages.push(eventMessage(type, role, detail))
  }
  state.status = COMPOSER_HINTS
}))

add('C2', 'Plan (todos)', 'opencode todo-item grammar with the brand glyph vocabulary.', screenFrame((screen, state) => {
  state.messages.push({ text: '── plan', tone: 'cyan' })
  state.messages.push(brandTodoRow('done', 'architect read server/auth.js'))
  state.messages.push(brandTodoRow('done', 'planner found 3 findings'))
  state.messages.push(brandTodoRow('doing', 'coder rewriting lookupToken'))
  state.messages.push(brandTodoRow('todo', 'tester runs npm test'))
  state.messages.push(brandTodoRow('todo', 'reviewer scores the diff'))
  state.status = COMPOSER_HINTS
}))

add('C3', 'Working state', 'Scanner + rotating verb + "esc interrupts" — the verb turns over every ~1s (BUSY_VERBS), so the line reads alive, not hung. Live token count on the right.', screenFrame((screen, state) => {
  state.messages.push({ text: '── coder', tone: 'cyan' })
  state.messages.push({ text: `${GLYPH.hand.ornamental} read server/auth.js`, tone: 'plain' })
  state.messages.push({ text: `${GLYPH.hand.ornamental} edit server/auth.js (+3 −1)`, tone: 'plain' })
  state.messages.push(brandTodoRow('doing', 'coder rewriting lookupToken'))
  state.busy = true
  state.side = { title: 'fix login leak', tokens: 8421, limit: 13312 }
  screen.tick(); screen.tick(); screen.tick(); screen.tick(); screen.tick()
  state.status = busyStatus(screen.spinIndex, state.crew)
}))

add('C4', 'Result', 'Finished run: diff + one-line outcome with token cost.', screenFrame((screen, state) => {
  state.messages.push({ text: '── verification', tone: 'cyan' })
  state.messages.push({ text: `${GLYPH.skull.ornamental} task.failed (tester)`, tone: 'red' })
  for (const dl of diffLines(
    'function lookup(d, t) {\n  return null\n}\n',
    'function lookup(d, t) {\n  return d.tokens[t] ?? null\n}\n',
    'server/auth.js',
  )) {
    state.messages.push({ text: diffRow(dl.kind, dl.text), tone: 'plain' })
  }
  state.messages.push({ text: 'status: completed · 17,932 tokens · 2 repairs · 41s', tone: 'green' })
  state.side = { title: 'fix login leak', tokens: 17932, limit: 13312 }
  state.status = COMPOSER_HINTS
}))

add('C5', 'Failure', 'Verification could not be satisfied — the honest ending.', screenFrame((screen, state) => {
  state.messages.push({ text: '── verification', tone: 'cyan' })
  state.messages.push({ text: `${GLYPH.skull.ornamental} verification failed after 2 repairs`, tone: 'red' })
  state.messages.push({ text: 'node --test  ·  1 failing  ·  expected 200, got 401', tone: 'dim' })
  state.messages.push({ text: 'status: failed · 9,110 tokens · no artifact accepted', tone: 'red' })
  state.side = { title: 'fix login leak', tokens: 9110, limit: 13312 }
  state.status = COMPOSER_HINTS
}))

// D. Overlays
add('D1', 'Approval dialog', 'Task preview + one-question gate. Esc always rejects.', screenFrame((screen, state) => {
  state.messages.push({ text: 'fix the login leak in server/auth.js', tone: 'bold' })
  state.status = 'waiting for approval'
  state.dialog = {
    title: 'Ready to run',
    body: 'Fix: fix the login leak in server/auth.js\nWhere: C:\\wednesday\nVerify: npm test\nRole: backend · ts\nFiles: server/auth.js',
    prompt: 'Run it?',
  }
}))

// The `~sel~` markers are implementation debris (the design record says so on
// this very frame): they exist so a click can be mapped back to a row and are
// stripped by plateRow when painted. Rendering them into the record would put
// debris back into the thing that documents the design.
function plateOnly(rows: string[], width: number): string {
  return rows.map(row => plateRow(row, width)).join('\n')
}

add('D2', 'Command palette', 'Ctrl+P or a lone / — the plate up close: flat rows with their footers, the caret row marking what Enter takes, type to filter, esc cancels. G1 shows the same plate over the live screen at real terminal geometry.', ansiToHtml(
  plateOnly(selectLines('Commands', PALETTE, '', 1, 100, 20), 100),
))

add('D3', 'Model picker', 'The models this factory actually routes: the active route first, then the crew seats\' resolved models — described by the router\'s own model-card priors — and a custom escape. Selecting a route re-labels the composer and header; a seat opens the private prompt. The rows carry no env footers: at a 100-column terminal the real plate inner is 58, so a footer clipped mid-word — the plate says what each choice does, and the receipt after picking says where it landed.', ansiToHtml(
  plateOnly(selectLines('Select model', [
    selectSection('Route'),
    { title: 'qwen2.5-coder-3b-instruct', desc: 'code · active', value: 'a' },
    { title: 'DeepSeek-R1-Distill-Qwen-7B', desc: 'reasoning', value: 'b' },
    { title: 'Qwen2.5-VL-7B-Instruct', desc: 'vision', value: 'c' },
    { title: 'Enter a model id…', desc: 'custom route', value: 'd' },
    selectSection('Crew seats'),
    { title: 'planner', desc: 'DeepSeek-R1-Distill-Qwen-7B', value: 'e' },
    { title: 'coder', desc: 'Qwen2.5-Coder-3B-Instruct', value: 'f' },
    { title: 'vision', desc: 'Qwen2.5-VL-7B-Instruct', value: 'g' },
  ], '', 1, 100, 24), 100),
))

// E. Chrome details
add('E1', 'Toast', 'Transient violet notice, cleared on the next pushed message.', screenFrame((screen, state) => {
  screen.push(state, { text: `${GLYPH.hand.ornamental} the crew route reconnected`, tone: 'plain' })
  state.toast = 'local proxy upstream changed'
  state.status = COMPOSER_HINTS
}))

add('E2', 'Scrolled history', 'PgUp lifts the stream; the status line reports how far.', screenFrame((screen, state) => {
  for (const [type, role] of EVENT_TAPE.slice(0, 6)) state.messages.push(eventMessage(type, role))
  state.scroll = 4
  state.status = '/ for commands'
}))

add('E3', 'Narrow terminal (no Context rail)', 'Below ~63 columns there is no room for a 40-column main column beside the rail, so the rail is dropped whole — never squeezed into a lookalike. The stream keeps its full width.', screenFrame((screen, state) => {
  for (const mark of wednesdayMark()) screen.push(state, { text: mark, tone: 'plain' })
  state.messages.push({ text: 'add a regression test for the token refresh path', tone: 'dim' })
  state.input = 'add a regression test for the token refresh path'
  state.cursor = state.input.length
  state.status = COMPOSER_HINTS
}, 56, 20))

add('E4', 'Exit / resume card', 'Ctrl+C leaves a card: where the session lives and how to come back.', screenFrame((screen, state) => {
  state.side = null
  for (const mark of wednesdayMark()) screen.push(state, { text: mark, tone: 'plain' })
  screen.push(state, { text: '', tone: 'dim' })
  screen.push(state, { text: 'Session    harness-3e42cb97', tone: 'dim' })
  screen.push(state, { text: 'Continue   wednesday --repl', tone: 'dim' })
  screen.push(state, { text: 'Inspect    /result harness-3e42cb97', tone: 'dim' })
  state.status = ''
}))

add('E5', 'Panels (components)', 'Reusable boxes: rounded (opencode dialog) and iron (brand plate).', ansiToHtml(
  [...roundBox('Task preview', ['Objective: fix the login leak', 'Verify: npm test'], 46),
   '',
   ...ironPanel('Factory health', ['gateway  OK', 'dsh      WARN', 'hermes   OK'], 46)].join('\n'),
))

add('E6', 'Line wrap', 'A long event line wraps at the rail and the continuation keeps the rail — words break at spaces, never mid-word (the B92/B93 prose-integrity rule), and the rail survives every wrapped row.', screenFrame((screen, state) => {
  screen.push(state, { text: 'read packages/factory-harness/src/screen-renderer/panel/approvals.ts and check the composer wrap behaviour', tone: 'dim' })
  state.status = COMPOSER_HINTS
}))

// G. Floating plates over the live screen (opencode: background stays visible)
add('G1', 'Command tab (/ typed)', 'Typing / floats the bordered command plate, centred on the page, over the live screen. The header, composer and footer stay visible; the active row carries a violet › in the margin (design frame G1) and the plate tracks the active row when the list is taller than the window.', overlayFrame('Commands', PALETTE, '', 1))
add('G2', 'Command tab (filtered)', 'Typing after the slash filters in place — /ta lands on /tasks.', overlayFrame('Commands', PALETTE, 'ta', 0))
add('G3', 'Select agent', 'The agent plate: the crew profile picker plus the live seat resolution — what each role routes to right now, with set/default provenance; a seat opens the private prompt.', overlayFrame('Select agent', [
  selectSection('Crew profiles'),
  { title: 'trio', desc: 'planner + coder + vision (default)', value: 'trio' },
  { title: 'duo', desc: 'planner + coder, vision cleared', value: 'duo' },
  selectSection('One model'),
  { title: 'solo', desc: 'one model fills every role', value: 'solo' },
  selectSection('Seats now'),
  { title: 'planner', desc: 'DeepSeek-R1-Distill-Qwen-7B', footer: 'default', value: 'seat:FACTORY_CREW_PLANNER_MODEL' },
  { title: 'coder', desc: 'Qwen2.5-Coder-3B-Instruct', footer: 'default', value: 'seat:FACTORY_CREW_CODER_MODEL' },
  { title: 'vision', desc: 'Qwen2.5-VL-7B-Instruct', footer: 'default', value: 'seat:FACTORY_CREW_VISION_MODEL' },
], '', 1))

// F. Classic (non-TTY) mode
add('F1', 'Classic banner', 'Piped / --classic run: no alt screen, plain stream.', ansiToHtml(
  `${banner()}\n\n${previewTitle()}\n\n${taskCard({
    id: 'harness-3e42cb97',
    workspace: 'C:\\wednesday',
    objective: 'fix the login leak in server/auth.js',
    role: 'backend',
    stack: 'TypeScript, Python',
    constraints: ['do not change the public API'],
    requiredFiles: [],
    verification: { testCommands: ['npm test'] },
  } as never)}\n`,
))

add('F2', 'Classic stage log', 'Same run, line-based: stage header + one event line each.', ansiToHtml(
  [EVENT_TAPE.slice(0, 6).map(([type, role]) => (role ? `${stageHeader(role)}\n${formatEvent(type, role)}` : formatEvent(type))).join('\n')].join('\n'),
))

add('F3', 'Classic status lines', 'Result block: per-line status with ok/fail colouring.', ansiToHtml(
  ['-- tests passed --', ...['status: completed', 'artifact: server/auth.js', 'repair: 1 pass']].map((l, i) => statusLine(l, i !== 0)).join('\n'),
))

// ── Assemble ──────────────────────────────────────────────────────────────────
const css = `
:root{color-scheme:dark}
body{background:#07070c;color:#ece6da;font-family:Consolas,Menlo,monospace;margin:0;padding:32px 40px 80px}
header{border-bottom:1px solid #2b2340;padding-bottom:18px;margin-bottom:8px;max-width:1180px}
h1{font-family:Georgia,serif;color:#b9a8e8;font-size:22px;letter-spacing:.14em;margin:0 0 6px}
header p{color:#8a819c;font-size:13px;line-height:1.6;margin:4px 0;max-width:900px}
header code{color:#ffb84d}
.toc{columns:3;font-size:12.5px;color:#7f7696;margin:14px 0 0}
.toc a{color:#9a90b0;text-decoration:none}
section{margin:26px 0 0}
h2{font-family:Georgia,serif;color:#b9a8e8;font-size:13px;letter-spacing:.14em;margin:0 0 2px;text-transform:uppercase}
.note{color:#6f6786;font-size:12px;margin:0 0 8px}
pre{background:#060609;border:1px solid #2b2340;border-radius:8px;padding:16px 18px;line-height:1.5;overflow-x:auto;margin:0;
  font-size:12.6px;box-shadow:0 0 0 1px rgba(139,111,212,.06), 0 12px 30px rgba(0,0,0,.45)}
.b{font-weight:bold}.dim{color:#777}.red{color:#ff6470}.green{color:#7fb069}.yellow{color:#ffb84d}.cyan{color:#6fd3e0}
.plain{color:#d8d8dc}.rev{background:#8b6fd4;color:#100a1e}
.fg108{color:#7fb069}.bg22{background:rgba(127,176,105,.14)}
.fg203{color:#ff6470}.bg52{background:rgba(176,21,40,.16)}
.fg98{color:#8b6fd4}.bg235{background:#141020}
.fg107{color:#7fb069}.fg237{color:#2b2340}.bg237{background:#141020}
.fg245{color:#9a90b0}.fg254{color:#ece6da}.fg214{color:#ffb84d}
.fg75{color:#7fb8e8}.fg232{color:#07070c}.bg215{background:#ffb84d}.bg98{background:#8b6fd4}
.fg74{color:#4f9fb8}.fg222{background:#ffb84d}
`

const toc = frames.map(([id, name]) => `<a href="#${id.toLowerCase()}">${id} · ${name}</a>`).join('')
const body = frames.map(([id, name, note, html]) =>
  `<section id="${id.toLowerCase()}"><h2>${id} — ${name}</h2><p class="note">${note}</p><pre>${html}</pre></section>`,
).join('\n')

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Wednesday TUI — design board</title><style>${css}</style></head><body>
<header>
  <h1>${GLYPH.rose.ornamental} WEDNESDAY TUI — DESIGN BOARD</h1>
  <p>Every screen the CLI can draw, rendered by the real code paths in
  <code>factory/harness/screen.ts</code> + <code>tui.ts</code> — not mock-ups.
  Design here: change the frame builders in <code>factory/harness/preview.ts</code>
  (or restyle <code>screen.ts</code>) and regenerate with
  <code>npx tsx factory/harness/preview.ts</code>. I port the same change into the CLI —
  the CLI is the source of truth, this file is the review surface.</p>
  <p>Frames: <code>A</code> splash/home/help · <code>B</code> composer · <code>C</code> stream/plan/working/result ·
  <code>D</code> overlays · <code>E</code> chrome · <code>F</code> classic non-TTY mode ·
  <code>G</code> command tab · <code>H</code> ASCII tier · <code>I</code> quadrant plate.</p>
  <p>Design record: <code>wednesday-theme/tui-design.html</code> (hand-authored, never written by this
  script). This file is the generated copy of what the CLI actually draws.</p>
  <p class="toc">${toc}</p>
</header>
${body}
</body></html>`

const out = process.argv[2] ?? join(process.cwd(), 'wednesday-theme', 'generated', 'tui-design.html')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html, 'utf8')
console.log(`generated design board written: ${out} (${frames.length} screens)`)

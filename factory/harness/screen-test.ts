import { stdin } from 'node:process'
import assert from 'node:assert/strict'
import { renderHelp } from './help.js'
import { Screen, activeRail, type SelectOption, activityMessage, bootSplashRows, chatLiveRow, COMPOSER_HINTS, crewStripRows, crewUpdate, decodeInput, dialogButtons, mouseArm, mouseDisarm, overlayFromRows, parseMouse, parsePatch, runAdvisories, runSelect, brandTodoRow, clipVisible, padVisible, visibleWidth, wednesdayCompact, diffLines, diffRow, diffTone, eventMessage, frameRows, GLYPH, glyph, gitBranch, hexTo256, initialState, ironPanel, link, locationLabel, mdLine, moveCursorRow, panelBg, parseGitHead, roundBox, scannerFrame, selectLines, selectMatching, selectSection, foldTool, busyStatus, toastMark, todoRow, toolRow, wednesdayMark, BRAND_HEX, hudPlate, hudLine, type CrewRow } from './screen.js'
import { wordmarkRows, markFor, supportsOrnamental } from './marks.js'
import { tesseractRows } from './cube.js'
import { GATE_COLS, GATE_ROWS, gatePlateRows, gatePlateRowsFor } from './plate.js'
import { THEME, luminance } from './theme.js'
import { recordUsage, usageDiff, usageSnapshot } from '../model-router/usage.js'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

/** Await with a timeout: a hung overlay must FAIL, never hang the suite. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race([promise, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), ms))])
}

function fakeOut(width: number, height: number): { out: NodeJS.WriteStream; get: () => string } {
  let captured = ''
  const out = {
    columns: width,
    rows: height,
    // `isTTY` defaults to true here: this harness drives the REAL drawing path,
    // and the mouse-reporting modes are written only on a TTY, so a fake stream
    // that claims to be one is what lets those modes be asserted at all.
    isTTY: true,
    write: (chunk: string) => { captured += chunk; return true },
  } as unknown as NodeJS.WriteStream
  return { out, get: () => captured }
}

/**
 * The cursor state a byte stream leaves behind, and every position at which
 * the cursor was VISIBLE.
 *
 * The frame is written from the home position, so a cursor that stays visible
 * while it lands sits in the top-left corner. That is the "blinking artifact"
 * the operator reported on the home page: every repaint re-parks the cursor at
 * (1,1) and restarts the terminal's own blink timer, nine times a second.
 *
 * @returns the positions where the cursor was visible while the stream ran.
 */
function visibleCursorPositions(stream: string): Array<{ row: number; col: number }> {
  let visible = false
  let row = 1
  let col = 1
  const seen: Array<{ row: number; col: number }> = []
  const record = (): void => {
    if (visible) seen.push({ row, col })
  }
  const token = /\x1b\[(\?25[lh])|(?:\x1b\[(\d+);(\d+)H)|(?:\x1b\[(\d+)H)|(?:\x1b\[H)/g
  let match: RegExpExecArray | null
  while ((match = token.exec(stream)) !== null) {
    if (match[1] === '?25h') {
      visible = true
      record()
    } else if (match[1] === '?25l') {
      visible = false
    } else if (match[2] !== undefined) {
      row = Number(match[2])
      col = Number(match[3])
      record()
    } else if (match[4] !== undefined) {
      row = Number(match[4])
      col = 1
      record()
    } else {
      row = 1
      col = 1
      record()
    }
  }
  return seen
}

async function main(): Promise<void> {
  // eventMessage mapping — the decode key from wednesday-theme/tui-design.html,
  // in Hermes' tool-row grammar: `┊ {mark} {subject:12} {action} · {detail}`.
  // One mark per event, and the tone travels with the mark rather than being
  // restated per branch (see factory/harness/marks.ts). Pipeline lifecycle rows
  // put their STAGE in the subject column (`2 build`), because the run's
  // progress is the fact the operator needs mid-build.
  assert.deepEqual(eventMessage('task.completed'), { text: '┊ ❀ task         completed', tone: 'green' })
  assert.deepEqual(eventMessage('agent.completed', 'coder'), { text: '┊ ❀ 2 build      done · coder', tone: 'green' })
  assert.deepEqual(eventMessage('task.failed'), { text: '┊ ☠ task         failed', tone: 'red' })
  assert.deepEqual(eventMessage('repair.started'), { text: '┊ ✧ 4 repair     working', tone: 'yellow' })
  assert.deepEqual(eventMessage('agent.started', 'coder'), { text: '┊ ✿ 2 build      working · coder', tone: 'dim' })
  assert.deepEqual(eventMessage('verification.started'), { text: '┊ ◉ 3 verify     working', tone: 'cyan' })
  assert.deepEqual(eventMessage('agent.ready'), { text: '┊ ❦ agent        ready', tone: 'cyan' })
  assert.deepEqual(eventMessage('tool.called', 'coder'), { text: '┊ ☞ tool         called · coder', tone: 'yellow' })
  // A seat that DIED still reports `agent.completed` — the orchestrator has no
  // `agent.failed` event — so the verdict rides in the payload. The row used
  // to say `done` in GREEN over a failed seat, which is what made the operator
  // ask whether the whole run was invented (operator, 2026-11-04).
  assert.deepEqual(
    eventMessage('agent.completed', 'coder', { note: 'FAIL', status: 'failed' }),
    { text: '┊ ✖ 2 build      FAILED · coder', tone: 'red' },
  )
  assert.deepEqual(
    eventMessage('agent.completed', 'coder', { note: 'ABORT', status: 'aborted' }),
    { text: '┊ † 2 build      ABORTED · coder', tone: 'dim' },
  )

  // Live activity (operator, 2026-11-04: "stream the reasoning, the file
  // changes, the commands — so I can see what is happening"). Reasoning and
  // talk are ONE row per seat and carry the newest words; a tool call and a
  // file write are facts of their own.
  assert.deepEqual(
    activityMessage('reasoning', 'planner', { kind: 'reasoning', text: 'checking the repo' }),
    { text: '┊ ✧ 1 plan       thinking · planner · checking the repo', tone: 'yellow' },
  )
  assert.deepEqual(
    activityMessage('text', 'coder', { kind: 'text', text: 'I will write the file now' }),
    { text: '┊ ❦ 2 build      saying · coder · I will write the file now', tone: 'cyan' },
  )
  assert.deepEqual(
    activityMessage('tool', 'coder', { kind: 'tool', tool: 'bash', detail: 'npm test', status: 'completed' }),
    { text: '┊ ☞ 2 build      bash · coder · npm test', tone: 'yellow' },
  )
  assert.deepEqual(
    activityMessage('file', 'coder', { kind: 'file', detail: 'src/index.ts', status: 'created' }),
    { text: '┊ ☾ 2 build      wrote · coder · src/index.ts', tone: 'dim' },
  )
  // The tail is the newest words, never a wall: a long reasoning stream shows
  // its end, not its beginning. The ellipsis marks the omitted head.
  {
    const long = activityMessage('reasoning', 'coder', { kind: 'reasoning', text: 'x'.repeat(400) })
    assert.ok(long.text.includes('…'), 'a long reasoning tail is marked as clipped')
    assert.ok(long.text.includes('x'.repeat(20)), 'and it keeps the newest words')
  }
  // A tool call NAMES its tool: the family becomes the subject, the rest the
  // action, and the one-word outcome rides at the end. This is the row that
  // replaced five identical `tool called` lines with something readable.
  assert.deepEqual(
    eventMessage('tool.called', 'verifier', { tool: 'verification.test', note: 'PASS' }),
    { text: '┊ ☞ verification test · verifier · PASS', tone: 'yellow' },
  )
  // Same event with no tool in the payload degrades to the old row: the bus is
  // authoritative, so the renderer never invents a tool name.
  assert.deepEqual(eventMessage('tool.called', 'coder', {}), { text: '┊ ☞ tool         called · coder', tone: 'yellow' })
  // A run of identical calls folds, and the failure count survives the fold —
  // six checks of which one failed is one fact, not six rows of noise.
  assert.deepEqual(
    toolRow('verification.test', 'verifier', 6, 0, 'PASS'),
    { text: '┊ ☞ verification test ×6 · verifier · PASS', tone: 'yellow' },
  )
  assert.deepEqual(
    toolRow('verification.test', 'verifier', 6, 1, 'PASS'),
    { text: '┊ ☞ verification test ×6 · verifier · 1 FAIL', tone: 'red' },
  )
  // The fold rule, separately from where the row lives: same tool + same seat
  // merges, anything else starts a new row. A FAIL joining a passing run turns
  // the whole row red, because one failed check is the fact worth seeing.
  const first = foldTool(null, 'verification.test', 'verifier', 'PASS')
  assert.equal(first.merged, false)
  assert.equal(first.fold.count, 1)
  assert.equal(first.row.text, '┊ ☞ verification test · verifier · PASS')
  const second = foldTool(first.fold, 'verification.test', 'verifier', 'PASS')
  assert.equal(second.merged, true)
  assert.equal(second.fold.count, 2)
  assert.equal(second.row.text, '┊ ☞ verification test ×2 · verifier · PASS')
  const failing = foldTool(second.fold, 'verification.test', 'verifier', 'FAIL')
  assert.equal(failing.fold.count, 3)
  assert.equal(failing.fold.failed, 1)
  assert.equal(failing.row.text, '┊ ☞ verification test ×3 · verifier · 1 FAIL')
  assert.equal(failing.row.tone, 'red')
  assert.equal(foldTool(failing.fold, 'verification.setup', 'verifier').merged, false, 'a different tool breaks the run')
  assert.equal(foldTool(failing.fold, 'verification.test', 'coder').merged, false, 'a different seat breaks the run')
  // The row names WHAT the call touched, and the fold treats that as part of
  // its identity: two test commands are two facts, not `verification.test ×2`.
  assert.equal(
    toolRow('verification.test', 'verifier', 1, 0, 'PASS', 'npm test -- --run').text,
    '┊ ☞ verification test · verifier · npm test -- --run · PASS',
  )
  const cmdA = foldTool(null, 'verification.test', 'verifier', 'PASS', 'npm test')
  assert.equal(foldTool(cmdA.fold, 'verification.test', 'verifier', 'PASS', 'npm run build').merged, false, 'a different command never folds')
  assert.equal(foldTool(cmdA.fold, 'verification.test', 'verifier', 'PASS', 'npm test').merged, true, 'the same command still folds')
  assert.ok(toolRow('verification.test', 'verifier', 1, 0, undefined, 'x'.repeat(200)).text.length < 110, 'a long command is clipped on the row')
  // An event nobody designed a mark for still gets the row prefix and the
  // column, never a silent bare line.
  assert.deepEqual(eventMessage('session.note'), { text: '┊ · session      note', tone: 'plain' })

  // The crew dock (Hermes' agents panel): pure fold over Factory events, and a
  // renderer that collapses on a short window. The fold is asserted directly —
  // the live path and the dock must agree about who is working.
  const crew: CrewRow[] = []
  crewUpdate(crew, 'task.created')
  assert.equal(crew.length, 0, 'a new run starts with an empty dock')
  crewUpdate(crew, 'agent.started', 'planner')
  crewUpdate(crew, 'tool.called', 'planner', 'read_file')
  crewUpdate(crew, 'agent.completed', 'planner')
  crewUpdate(crew, 'verification.started', 'tester')
  assert.equal(crew.length, 2, 'two seats are tracked')
  assert.equal(crew[0]!.phase, 'done', 'a finished seat stays visible')
  assert.equal(crew[0]!.detail, 'read_file', 'the last concrete tool survives')
  assert.equal(crew[1]!.phase, 'verifying', 'verification has its own phase')
  // A seat that FAILED is not a finished seat. `agent.completed` carries the
  // verdict, so the dock must read it instead of painting a green tick over a
  // model that never answered.
  {
    const failedDock: CrewRow[] = []
    crewUpdate(failedDock, 'agent.started', 'coder')
    crewUpdate(failedDock, 'agent.completed', 'coder', 'failed', 'failed')
    assert.equal(failedDock[0]!.phase, 'failed', 'a seat that died is red in the dock, not green')
  }
  const dockState = initialState('Wednesday', 'live')
  dockState.crew = crew
  const dock = strip(crewStripRows(dockState, 100, 40, Date.now()).join('\n'))
  assert.match(dock, /▾ 1 live agent/, 'the header counts live seats, not finished ones')
  assert.match(dock, /✓ planner\s+done/, 'a done seat keeps its verdict glyph')
  assert.match(dock, /◉ tester\s+verifying/, 'a verifying seat is distinguishable')
  const collapsedDock = strip(crewStripRows(dockState, 100, 24, Date.now()).join('\n'))
  assert.equal(collapsedDock.split('\n').length, 1, 'a short window gets the collapsed dock')
  assert.match(collapsedDock, /tester/, 'the collapsed dock names the live seat')
  assert.match(busyStatus(0, crew), /· tester/, 'the activity line names the live seat too')
  crewUpdate(crew, 'tool.called', 'tester', 'npm test')
  const dockBusy = strip(crewStripRows(dockState, 100, 40, Date.now()).join('\n'))
  assert.match(dockBusy, /tester\s+working · npm test/, 'and the dock says WHAT the seat is doing')
  crewUpdate(crew, 'task.failed')
  assert.equal(crew[1]!.phase, 'failed', 'a failed run flips live seats, not finished ones')
  assert.equal(crew[0]!.phase, 'done', 'a seat that already finished keeps its verdict')
  for (const row of crewStripRows(dockState, 40, 40, Date.now())) {
    assert.ok(strip(row).length <= 40, 'a dock row fits a narrow terminal')
  }

  // layout at fixed size
  const { out, get } = fakeOut(40, 14)
  const screen = new Screen(out, 40, 14)
  const state = initialState('Wednesday', 'live | model-x')
  state.composerLabel = 'model-x'
  screen.enter()
  screen.push(state, { text: 'hello run', tone: 'plain' })
  state.input = 'fix it'
  state.cursor = 6
  state.status = 'ready'
  screen.render(state)
  // Repaints are incremental, so the byte stream is a PATCH, not a frame. The
  // authoritative full frame is what the screen has on it.
  const plain = strip(screen.painted().join('\n'))
  assert.match(plain, /hello run/)
  // Hermes prompt grammar: two rules and a lit `❯` on the input row.
  assert.match(plain, /❯ fix it/)
  // The meter names the model answering, with the brand mark and no
  // pictographs: `⚡ 0% │ ☤ model │ [░░] 0% │ 1m 20s │ ⏲ 0s` said one idea three
  // times and rendered as coloured emoji (operator report, 2026-11-04).
  assert.match(plain, /✦ model-x/)
  assert.ok(!/[⚡☤⏲⏱]/.test(plain), 'the meter carries no emoji')
  // No emoji-presentation glyph may reach the terminal at all: Windows
  // Terminal renders U+1F000+, U+26A1, U+23F1/2 and any VS-16 pair as a
  // COLOURED IMAGE, which breaks the violet-on-black rule (operator report,
  // 2026-11-04: "flash emuji ... looks os bad"). The house vocabulary
  // (❦ ✿ ◉ ✧ ❀ ☠ ☞ ✖ ☾ ✦ †) is text-presentation, one cell, and stays.
  const EMOJI_IMAGE = /[\u{1F000}-\u{1FAFF}\u{26A1}\u{23F1}\u{23F2}\u{FE0F}]/u
  assert.equal(plain.match(EMOJI_IMAGE), null, 'the stream carries no emoji-presentation glyph')
  assert.ok(!plain.includes('┃'), 'stream rows are plain, not a side-rail quote')
  assert.ok(!plain.includes('❦'), 'no opencode header mark on the stream view')
  for (const line of plain.split('\n')) assert.ok(visibleWidth(line) <= 40, `line over width: ${line}`)

  // dialog overlay
  state.dialog = { title: 'Task preview', body: 'Objective: demo', prompt: 'Run this task? [y/N]' }
  screen.render(state)
  const withDialog = strip(get())
  assert.match(withDialog, /Task preview/)
  // Body lines are label/value columns (D1), not "Label: value" prose.
  assert.match(withDialog, /Objective\s+demo/)
  assert.match(withDialog, /Run this task\? \[y\/N\]/)
  // Hermes approval grammar: a double-ruled warn panel, numbered choices under
  // a `▸` cursor, and one hint row naming every key.
  assert.match(withDialog, /╔═+╗/, 'the gate is a double-ruled panel')
  assert.match(withDialog, /⚠ approval required/, 'and names itself like Hermes')
  assert.match(withDialog, /1\. Run once/, 'the run choice is numbered')
  assert.match(withDialog, /▸ 2\. Deny/, 'the armed row is the deny row by default')
  assert.match(withDialog, /↑\/↓.*Enter.*1\/2.*Esc/, 'the hint names the keys')
  assert.ok(
    !/\[ N \]|\[ Y \]/.test(withDialog),
    'the old bracket buttons are gone',
  )

  // ── B92: prose is never sliced into a fake label ────────────────────────────
  // Reported from a screenshot of the real approval card:
  //     Approval p ermits workspace changes. This previ ew is not a sandbox.
  // A word cut in half, the fragment dimmed as if it were a field name.
  //
  // The audit could not see this because it checks WIDTHS and this broke none —
  // every line still fit; the text was simply mangled. So the assertion here is
  // on WORDS: the exact body the harness ships, checked for intact phrases.
  {
    const REAL_BODY = [
      'Fix: fix the login leak',
      'Where: C:\\Users\\operator',
      'Verify: npm test',
      'Approval permits workspace changes. This preview is not a sandbox.',
    ].join('\n')
    for (const [w2, h] of [[120, 40], [100, 30], [80, 24], [60, 18], [44, 16]] as Array<[number, number]>) {
      const st = initialState('WEDNESDAY', 'mode live · laguna-xs-2.1:free')
      st.side = { title: 'session', tokens: 0, limit: 13312 }
      const scr = new Screen({
        columns: w2, rows: h, isTTY: true,
        write: () => true,
      } as unknown as NodeJS.WriteStream, w2, h)
      scr.enter()
      st.dialog = { title: 'Ready to run', body: REAL_BODY, prompt: 'Run it? [y/N] — y runs, n/Esc cancels' }
      scr.render(st)
      const painted = strip(scr.painted().join('\n'))
      scr.exit()

      // The signature of B92: a word broken across the label column.
      assert.ok(
        !/Approval\s+p\s+ermits/.test(painted) && !/previ\s+ew\s+is/.test(painted),
        `at ${w2}x${h} a prose line was split mid-word:\n${painted}`,
      )
      // And the real assertion: the sentences survive with their words WHOLE.
      //
      // The oracle strips the rails first. They are not decoration to skip —
      // at 100 columns the Context rail sits between the two wrapped rows, so
      // the joined frame reads "…not a ┃ sandbox." and a naive whole-phrase
      // match fails on a card that is actually correct. Stripping the rail and
      // collapsing runs of space leaves the sentence as the operator reads it.
      // A wrap between words still passes; a split inside one does not.
      const flat = painted.replace(/[\u2503\u2502\u2551]/g, '').replace(/\s+/g, ' ')
      assert.match(flat, /Approval permits workspace changes\./, `at ${w2}x${h} the prose sentence is mangled`)
      assert.match(flat, /This preview is not a sandbox\./, `at ${w2}x${h} the second sentence is mangled`)
      // The real fields still get their label column, so the fix did not just
      // flatten everything.
      assert.match(flat, /Fix\s+fix the login leak/, `at ${w2}x${h} label columns are gone`)
      assert.match(flat, /Where\s+C:\\Users\\operator/, `at ${w2}x${h} the Where field lost its column`)
    }
  }

  // D1 layout discipline: the question sits after the fields — it used to sit
  // above them, asking the operator to approve a preview they could not see yet
  // — and the numbered choices follow it, with the key hints once below them.
  {
    const st = initialState('WEDNESDAY', 'mode live')
    const scr = new Screen({
      columns: 100, rows: 30, isTTY: true, write: () => true,
    } as unknown as NodeJS.WriteStream, 100, 30)
    scr.enter()
    st.dialog = {
      title: 'Ready to run',
      body: 'Fix: fix the login leak\nWhere: C:\\wednesday\nVerify: npm test',
      prompt: 'Run it?',
    }
    scr.render(st)
    const rows = strip(scr.painted().join('\n')).split('\n')
    scr.exit()
    const at = (needle: string): number => rows.findIndex(row => row.includes(needle))
    const field = at('fix the login leak')
    const question = at('Run it?')
    const choices = at('1. Run once')
    const hint = at('quick pick')
    assert.ok(field >= 0 && question > field, 'the question comes after the fields it is about')
    assert.ok(choices > question, 'and directly above the choices that answer it')
    assert.ok(hint > choices, 'the key hints sit once, below the choices')
  }

  // clipping keeps the tail
  state.dialog = null
  for (let i = 0; i < 60; i++) screen.push(state, { text: `line-${i}`, tone: 'plain' })
  const clipped = strip(screen.painted().join('\n'))
  assert.match(clipped, /line-59/)
  assert.ok(!clipped.includes('line-0'), 'head must scroll out of view')

  // Hermes prompt grammar: a rule above and below the input row, no box.
  const promptRows = clipped.split('\n').map(row => row.trimEnd())
  const inputAt = promptRows.findIndex(row => row.includes('❯ fix it'))
  assert.ok(inputAt > 0, 'the prompt row is on screen')
  assert.match(promptRows[inputAt - 1] ?? '', /^─+$/, 'a rule sits above the prompt')
  assert.match(promptRows[inputAt + 1] ?? '', /^─+$/, 'a rule sits below the prompt')
  // The floating plate still uses the rounded box.
  const box = roundBox('Task preview', ['Objective: demo'], 40)
  assert.equal(box.length, 3)
  assert.ok(strip(box[0] ?? '').startsWith('╭─ Task preview'))
  for (const line of box) assert.ok(strip(line).length <= 40)

  // restyle grammar: scanner, toast (rails/mark covered on the plain frame)
  // Hermes' spinner: one braille cell, ten frames, cycling at 120ms.
  const scan0 = scannerFrame(0)
  assert.equal(scan0.length, 1)
  assert.ok('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.includes(scan0), 'the spinner is a braille frame')
  assert.notEqual(scannerFrame(0), scannerFrame(1), 'scanner moves every frame')
  assert.equal(scannerFrame(0), scannerFrame(10), 'scanner cycles every 10 frames per Hermes')
  const toastState = initialState('Wednesday', 'meta')
  const toastScreen = new Screen(fakeOut(70, 24).out, 70, 24)
  toastScreen.notify(toastState, 'proxy reconnected')
  assert.equal(toastState.toast, 'proxy reconnected')
  toastScreen.push(toastState, { text: 'next', tone: 'plain' })
  assert.equal(toastState.toast, null, 'push clears the toast')

  // phase-A pieces: todo rows, mark, markdown tint, diff, cursor rows
  assert.deepEqual(todoRow('done', 'x'), { text: '[✓] x', tone: 'green' })
  assert.deepEqual(todoRow('doing', 'x'), { text: '[•] x', tone: 'yellow' })
  assert.deepEqual(todoRow('todo', 'x'), { text: '[ ] x', tone: 'dim' })
  // The mark is TYPE, not block art: the old three-row "W" read as a corrupted
  // glyph run at terminal size. The house rose carries the name instead.
  assert.equal(wednesdayMark().length, 2, 'mark is the name line plus the tagline')
  assert.match(strip(wednesdayMark()[0]!), /WEDNESDAY/, 'the mark names the product')
  assert.ok(!/[█▀▄]/.test(strip(wednesdayMark().join(''))), 'no block-art noise in the mark')
  assert.ok(visibleWidth(strip(wednesdayMark()[0]!)) < 20, 'the mark stays narrow')
  assert.equal(wednesdayCompact(), 'WEDNESDAY')
  // Brand glyph vocabulary: the decode key from the design board. Every mark
  // carries its own tone and a distinct Tier-A twin.
  assert.deepEqual(GLYPH.rose, { ornamental: '❦', ascii: '*', tone: 'cyan' })
  assert.ok(Object.values(GLYPH).every(g => g.ornamental !== g.ascii), 'every glyph has a distinct fallback')
  assert.equal(glyph('moon', false), '.', 'ASCII fallback path works')
  // Generic dingbats carry no meaning (decode-key rule 2) — none may appear.
  assert.ok(
    !Object.values(GLYPH).some(g => '◆◇◈○●'.includes(g.ornamental) || '◆◇◈○●'.includes(g.ascii)),
    'no generic dingbat in the vocabulary',
  )
  // Every mark's ASCII twin stays parseable in a log (decode-key rule 3).
  assert.deepEqual(brandTodoRow('done', 'x'), { text: '[❀] x', tone: 'green' })
  assert.deepEqual(brandTodoRow('doing', 'x'), { text: '[✧] x', tone: 'yellow' })
  assert.ok(strip(mdLine('## Title')).length > 0)
  assert.notEqual(strip(mdLine('`code`')), '`code`', 'code spans retint')
  const dl = diffLines('a\nb\n', 'a\nc\n', 'f.ts')
  assert.ok(dl.some(l => l.kind === 'del' && l.text.includes('b')))
  assert.ok(dl.some(l => l.kind === 'add' && l.text.includes('c')))
  assert.equal(diffTone('add'), 'green')
  assert.equal(diffTone('del'), 'red')
  const bigOld = Array.from({ length: 300 }, (_, i) => `old-${i}`).join('\n')
  const bigNew = Array.from({ length: 300 }, (_, i) => `new-${i}`).join('\n')
  assert.ok(diffLines(bigOld, bigNew, 'big.ts').some(l => l.kind === 'hunk' && l.text.includes('too large')))
  // `git diff` output is already a diff: file headers are dropped, git's own
  // prefix decides the kind, and a context line keeps its leading space so the
  // column still lines up.
  const patch = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 111..222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,2 +1,2 @@',
    ' const keep = 1',
    '-const gone = 2',
    '+const here = 3',
  ].join('\n')
  const parsed = parsePatch(patch)
  assert.ok(parsed.some(l => l.kind === 'hunk' && l.text === '@@ -1,2 +1,2 @@'), 'the hunk header survives')
  assert.ok(parsed.some(l => l.kind === 'add' && l.text === '+const here = 3'), 'an added line keeps its prefix')
  assert.ok(parsed.some(l => l.kind === 'del' && l.text === '-const gone = 2'), 'a removed line keeps its prefix')
  assert.ok(parsed.some(l => l.kind === 'same' && l.text === '  const keep = 1'), 'context keeps its column (marker + git prefix)')
  assert.ok(!parsed.some(l => l.text.includes('index 111')), 'file headers never become diff rows')
  assert.ok(!parsed.some(l => l.text.startsWith('+++')), 'the +++ header cannot read as an added line')
  assert.ok(!parsed.some(l => l.text.startsWith('--- a/')), 'the --- header cannot read as a removed line')
  assert.equal(parsed.length, 4, 'header lines are dropped, not styled')
  const caret = { input: 'ab\ncde', cursor: 5 }
  assert.equal(moveCursorRow(caret, -1), true)
  assert.equal(caret.cursor, 2, 'column sticks moving up')
  assert.equal(moveCursorRow(caret, -1), false, 'top edge falls back to history')

  // ANSI-aware layout math: escapes must not count as visible columns
  assert.equal(visibleWidth('\x1b[38;5;98mabc\x1b[0m'), 3)
  assert.equal(padVisible('\x1b[38;5;98mabc\x1b[0m', 6).replace(ANSI, '').length, 6)
  assert.equal(clipVisible('\x1b[38;5;98mabcdef\x1b[0m', 3).replace(ANSI, '').length, 3)
  // styled message lines still fit the terminal width
  const styledFab = fakeOut(40, 14)
  const styled = new Screen(styledFab.out, 40, 14)
  const styledState = initialState('W', 'm')
  styled.push(styledState, { text: 'planner finished with a very long summary that must wrap inside the rail', tone: 'yellow' })
  styled.render(styledState)
  // Repaints are ADDRESSED writes now (per-row, with a tail clear), so the byte
  // stream is a patch, not a frame. `painted()` is the authoritative frame -
  // that decision was made in B76 and these three sites were left behind,
  // which is how a layout regression could hide behind a green suite.
  const styledLast = strip(styled.painted().join('\n'))
  assert.ok(
    styledLast.split('\n').every(row => row.length <= 40),
    'a styled long line wraps inside the rail instead of overflowing',
  )
  assert.match(styledLast, /planner finished/, 'the wrapped content survives')

  // extended surface tokens carry their 256-color codes
  assert.ok(panelBg('x').includes(`48;5;${THEME.surface}`))
  assert.ok(activeRail('x').includes(`38;5;${THEME.accent}`))
  assert.ok(link('x').includes(`38;5;${THEME.glass}`))
  assert.ok(diffRow('add', '+x').includes(`48;5;${THEME.diffAdd}`))
  assert.ok(diffRow('del', '-x').includes(`48;5;${THEME.diffDel}`))
  assert.ok(diffRow('hunk', '@@').includes(`48;5;${THEME.surface}`))
  // The terminal is monochrome violet on black (operator decision 2026-11-04):
  // every chromatic token must be a violet-family index. The old assertion
  // compared the brand illustration hexes to the UI tokens; those hexes are
  // still the web/brand palette, but the TUI deliberately does not use them.
  const VIOLET = new Set([
    53, 54, 55, 56, 57, 90, 91, 92, 93, 98, 99,
    104, 105, 134, 135, 140, 141, 146, 147,
    164, 165, 170, 171, 176, 177, 182, 183,
  ])
  const chromatic: Array<[string, number]> = [
    ['accent', THEME.accent],
    ['blood', THEME.blood],
    ['bloodInk', THEME.bloodInk],
    ['amber', THEME.amber],
    ['sage', THEME.sage],
    ['glass', THEME.glass],
    ['diffAdd', THEME.diffAdd],
    ['diffDel', THEME.diffDel],
  ]
  for (const [name, code] of chromatic) {
    assert.ok(VIOLET.has(code), `${name} (${code}) is in the violet family`)
  }
  // Meaning still survives without hue: the alarm is hotter than the done ink.
  assert.notEqual(THEME.bloodInk, THEME.sage, 'alarm and done are distinct violet steps')
  assert.equal(hexTo256(BRAND_HEX.nevermore), THEME.accent)
  assert.ok(ironPanel('Panel', ['body'], 40).length === 4, 'iron panel frames the body')
  assert.equal(toastMark(), glyph('twinkle'), 'toast uses a brand light mark')

  // scroll offset reveals older lines; the sticky prompt and the right-edge
  // scrollbar are Hermes' two "you are reading history" signals.
  const tall = fakeOut(70, 24)
  const big = new Screen(tall.out, 70, 24)
  const bigState = initialState('Wednesday', 'meta')
  big.enter()
  big.push(bigState, { text: '❯ fix the login leak', tone: 'bold' })
  for (let i = 0; i < 30; i++) big.push(bigState, { text: `row-${i}`, tone: 'plain' })
  bigState.scroll = 10
  big.render(bigState)
  const scrolled = strip(big.painted().join('\n'))
  assert.ok(!scrolled.includes('row-29'), 'scrolled view hides the tail')
  assert.match(scrolled, /row-10/)
  assert.match(scrolled, /❯ fix the login leak/, 'the sticky prompt names the request you scrolled away from')
  assert.match(scrolled, /█/, 'the scrollbar draws a thumb')
  assert.match(scrolled, /│/, 'the scrollbar draws its track')
  big.exit()

  // 3b. Sticky follow (Hermes' stickyScroll): at the tail new output follows;
  //     scrolled up, the reader keeps the same rows. This is what makes the
  //     wheel usable DURING a run instead of being yanked back by every event.
  {
    const follow = fakeOut(80, 24)
    const fs = new Screen(follow.out, 80, 24)
    const fst = initialState('Wednesday', 'meta')
    fs.enter()
    fs.push(fst, { text: '❯ first request', tone: 'bold' })
    for (let i = 0; i < 40; i++) fs.push(fst, { text: `event ${i}`, tone: 'plain' })
    fst.scroll = 8
    fs.render(fst)
    const before = fs.painted().map(strip)
    const first = before.find(row => row.includes('event '))?.trim() ?? ''
    assert.ok(first.length > 0, 'the scrolled view has transcript rows')
    const offset = fst.scroll
    fs.push(fst, { text: 'event during a live run', tone: 'plain' })
    const after = fs.painted().map(strip)
    assert.ok(fst.scroll > offset, 'new output grows the offset while scrolled up')
    assert.ok(after.some(row => row.trim() === first), 'the same row stays on screen')
    // At the tail the view follows again.
    fst.scroll = 0
    fs.render(fst)
    fs.push(fst, { text: 'tail event', tone: 'plain' })
    assert.equal(fst.scroll, 0, 'at the tail the view follows new output')
    fs.exit()
  }

  // 3c. The wheel works while a run is live (watchRun owns the keyboard then).
  {
    const run = fakeOut(80, 24)
    const rs = new Screen(run.out, 80, 24)
    const rst = initialState('Wednesday', 'meta')
    for (let i = 0; i < 40; i++) rs.push(rst, { text: `event ${i}`, tone: 'plain' })
    const stop = rs.watchRun(rst, () => {}, () => {})
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\x1b[<64;10;10M')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(rst.scroll > 0, 'the wheel scrolls during a live run')
    stop()
    rs.exit()
  }
  screen.exit()
  // Usage accounting feeds the panel: tokens grow across calls in one run.
  const before = usageSnapshot()
  recordUsage('local', 'crew-coder', 1200, 800)
  recordUsage('local', 'crew-coder', 200, 100)
  const delta = usageDiff(before, usageSnapshot())
  assert.ok(delta.reduce((sum, r) => sum + r.completionTokens, 0) === 900, 'completion tokens accumulate')
  assert.ok(delta.reduce((sum, r) => sum + r.promptTokens, 0) === 1400, 'prompt tokens accumulate')

  // Meter: token accounting and the context bar live in the status line now
  // (Hermes grammar), and narrow terminals drop segments instead of clipping.
  const wide = fakeOut(120, 20)
  const wideScreen = new Screen(wide.out, 120, 20)
  const wideState = initialState('W', 'm')
  wideState.side = { title: 'fix login leak', tokens: 409723, limit: 1053184 }
  wideScreen.push(wideState, { text: 'hello', tone: 'plain' })
  wideScreen.render(wideState)
  const widePlain = strip(wideScreen.painted().join('\n'))
  // One pressure readout, not three: `ctx 400.1K/1028.5K 39%` replaced the
  // `⚡ 39%` badge AND the `[███░░] 39%` bar, which said the same thing twice.
  assert.match(widePlain, /ctx 400\.1K\/1028\.5K 39%/, 'the meter shows pressure once, with its percentage')
  assert.ok(!widePlain.includes('░'), 'no duplicate bar and no emoji meter glyphs')
  assert.ok(!widePlain.includes('┃'), 'no side rail: the meter carries the ledger')

  const narrow = fakeOut(50, 20)
  const narrowScreen = new Screen(narrow.out, 50, 20)
  const narrowState = initialState('W', 'm')
  narrowState.side = { title: 'fix login leak', tokens: 409723, limit: 1053184 }
  narrowScreen.push(narrowState, { text: 'hello', tone: 'plain' })
  narrowScreen.render(narrowState)
  const narrowPlain = strip(narrowScreen.painted().join('\n'))
  assert.ok(!narrowPlain.includes('ctx '), 'the context segment is dropped whole when it cannot fit')
  for (const line of narrowPlain.split('\n')) assert.ok(visibleWidth(line) <= 50, 'narrow rows never overflow')

  // The meter's model segment is segment 0. Narrowing the meter once wrote the
  // shortened model into segment 1 — the ctx slot — so the context reading
  // vanished and the `☤` pictograph came back (operator screenshot,
  // 2026-11-04). The model is abbreviated; the ctx reading survives.
  {
    const mid = fakeOut(52, 20)
    const midScreen = new Screen(mid.out, 52, 20)
    const midState = initialState('W', 'm')
    midState.crewLabel = 'local/some-extremely-long-model-name-that-will-not-fit'
    midState.side = { title: 'session', tokens: 409723, limit: 1053184 }
    midScreen.push(midState, { text: 'hello', tone: 'plain' })
    midScreen.render(midState)
    const midPlain = strip(midScreen.painted().join('\n'))
    const meter = midPlain.split('\n').find(row => row.trimStart().startsWith('✦ ')) ?? ''
    assert.ok(meter, 'the meter row is on the frame')
    assert.ok(!midPlain.includes('☤'), 'the meter never brings the ☤ pictograph back')
    assert.match(meter, /ctx 400\.1K\/1028\.5K 39%/, 'the ctx reading survives the model being shortened')
    assert.ok(
      !meter.includes('some-extremely-long-model-name'),
      'the model id is abbreviated, never cut mid-word',
    )
    assert.match(meter, /…/, 'an ellipsis marks the abbreviation')
    assert.ok(visibleWidth(meter) <= 52, 'the narrowed meter still fits its width')
  }

  // Frame discipline: every row is padded to the full width and the tail
  // is cleared, so a shorter frame can never leave stale rows behind.
  assert.ok(plain.split('\n').every(line => visibleWidth(line) === 40), 'rows pad to full width')
  // A full repaint must leave NOTHING of the previous frame anywhere. Asserting
  // for `ESC[0J` was asserting for a mechanism that cannot do this job: it
  // erases from the cursor - which sits on the LAST row - so it can never reach
  // a row above it. The property is that every row is explicitly overwritten.
  //
  // A FRESH screen, so the write under inspection is a first paint and not a
  // later incremental patch: the byte stream holds both, and slicing "the last
  // frame" out of it picks whichever came last.
  {
    const fresh = fakeOut(40, 14)
    const freshScreen = new Screen(fresh.out, 40, 14)
    freshScreen.enter()
    freshScreen.render(initialState('W', 'm'))
    const write = fresh.get().slice(fresh.get().indexOf('\x1b[H'))
    const addressed = new Set([...write.matchAll(/\x1b\[(\d+);1H/g)].map(m => Number(m[1])))
    const missing = Array.from({ length: 14 }, (_, i) => i + 1).filter(r => !addressed.has(r))
    assert.equal(missing.length, 0, `every row is explicitly overwritten; missing ${missing.join(',')}`)
    // ConPTY pending-wrap regression (2026-10-25): a row padded to exactly the
    // window width leaves the cursor past its last cell, and ConPTY then drops
    // the next row's address and runs the text on - the meter row swallowed
    // the composer's first `─`, the rail swallowed `❯`, and the bottom of the
    // home page arrived as a one-column staircase at 120x36 and 80x24. The
    // paint therefore disables autowrap for its duration, restores it from
    // home, and never moves between rows with a newline.
    assert.ok(fresh.get().includes('\x1b[?7l\x1b[H'), 'autowrap is off before the first row is addressed')
    assert.ok(fresh.get().includes('\x1b[H\x1b[?7h'), 'autowrap is restored from home after the paint')
    assert.ok(!write.includes('\n'), 'a full repaint never moves between rows by newline')
    freshScreen.exit()
  }

  // The rows above are ADDRESSED, not newline-separated — and every frame
  // reader that split the stream on '\n' silently collapsed a whole screen
  // into one line (the design board drew blank boxes for a month). frameRows
  // is the one reader: assert a fresh paint decodes into one row per screen
  // row, each row keeping its painted content and no cursor debris.
  {
    const fresh = fakeOut(40, 14)
    const freshScreen = new Screen(fresh.out, 40, 14)
    freshScreen.enter()
    const st = initialState('W', 'm')
    st.home = true
    st.placeholder = 'Type something'
    freshScreen.render(st)
    const rows = frameRows(fresh.get())
    assert.equal(rows.length, 14, `frameRows decodes one row per screen row; got ${rows.length}`)
    assert.ok(strip(rows.join('\n')).includes('Type something'), 'decoded rows keep their content')
    assert.ok(!rows.join('').includes('\x1b[?25'), 'cursor codes are not glued onto rows')
    freshScreen.exit()
  }

  assert.match(get(), /\x1b\[\?1049l/)

  // Home-screen update banner: persistent while an update is available, toned,
  // clipped to width at every size (audit asserts zero over-width rows).
  {
    // wide screen: full message with both version names + the verb
    const up = fakeOut(100, 24)
    const upScreen = new Screen(up.out, 100, 24)
    upScreen.enter()
    const st = initialState('W', 'm')
    st.home = true
    st.updateNotice = 'Update available: 0.1.0-dev.2 → 0.1.0-dev.9 — type /update to install it'
    upScreen.render(st)
    const plain = strip(frameRows(up.get()).join(' | '))
    assert.ok(plain.includes('Update available: 0.1.0-dev.2 → 0.1.0-dev.9'), 'banner shows both version names on the home screen')
    assert.ok(plain.includes('/update'), 'banner names the verb to run')
    upScreen.exit()
    // narrow screen: banner clipped, never over width
    const narrow = fakeOut(40, 14)
    const narrowScreen = new Screen(narrow.out, 40, 14)
    narrowScreen.enter()
    const st3 = initialState('W', 'm')
    st3.home = true
    st3.updateNotice = st.updateNotice
    narrowScreen.render(st3)
    const rows = frameRows(narrow.get())
    assert.ok(strip(rows.join(' | ')).includes('Update available'), 'banner still visible when narrow')
    for (const line of rows) assert.ok(visibleWidth(strip(line)) <= 40, 'banner row over width')
    narrowScreen.exit()
    // no notice -> no banner
    const no = fakeOut(100, 24)
    const noScreen = new Screen(no.out, 100, 24)
    noScreen.enter()
    const st2 = initialState('W', 'm')
    st2.home = true
    noScreen.render(st2)
    assert.ok(!strip(frameRows(no.get()).join(' | ')).includes('Update available'), 'no notice, no banner')
    noScreen.exit()
  }

  // Mouse fixtures: a screen with no real stdout and a counter for reports.
  let hits = 0
  const mouseOut = fakeOut(80, 24)
  const mouseScreen = new Screen(mouseOut.out, 80, 24)

  // Palette drawing is pure and shared with the design board: title + esc,
  // filter hint, sections, hint footer, and the active row clamped in range.
  const palette = [
    selectSection('Session'),
    { title: '/help', desc: 'this help', footer: 'commands', value: '/help' },
    { title: '/tasks', desc: 'list tasks', footer: 'tasks', value: '/tasks' },
  ]
  const lines = selectLines('Commands', palette, '', 1, 100, 20)
  const plainLines = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(plainLines, /Commands\s+esc/, 'palette shows title and esc')
  assert.match(plainLines, /type to filter/)
  assert.match(plainLines, /Session/, 'section headers survive the filter')
  assert.match(plainLines, /↑\/↓ move · return select · esc cancel/)
  assert.ok(selectLines('Commands', palette, '', 99, 100, 20).length > 0, 'out-of-range active row does not throw')
  assert.equal(selectMatching(palette, 'task', 20).filter(o => o.section === undefined).length, 1, 'typed filter narrows rows')
  assert.equal(selectMatching(palette, 'zzz', 20).filter(o => o.section === undefined).length, 0, 'no match leaves sections only')
  {
    // The live plate must rank like a completion list, not preserve PALETTE
    // order. These two rows are the exact production trap: `/run`'s desc says
    // "preview" (contains "review") and `/update`'s says "newer" (contains
    // "new"), so substring-only matching ran the wrong command.
    const commands = [
      { title: '/update', desc: 'check npm; offer to install the pinned newer release', value: '/update' },
      { title: '/new', desc: 'start a fresh session', value: '/new' },
      { title: '/run', desc: 'preview and approve a queued/failed task', value: '/run ' },
      { title: '/review', desc: 'review the workspace diff', value: '/review' },
    ]
    assert.equal(selectMatching(commands, 'review', 20)[0]?.title, '/review', 'review ranks /review above /run')
    assert.equal(selectMatching(commands, 'new', 20)[0]?.title, '/new', 'new ranks /new above /update')
    assert.equal(selectMatching(commands, '/review', 20)[0]?.title, '/review', 'a leading slash does not change the rank')
  }

  // Mouse grammar (opencode: the pointer is part of the interface).
  // SGR/1006 reports are the only encoding we ask the terminal for.
  const press = parseMouse('\x1b[<0;40;12M')
  assert.ok(press, 'left press decodes')
  assert.equal(press!.button, 0)
  assert.equal(press!.x, 40)
  assert.equal(press!.y, 12)
  assert.equal(press!.press, true)
  assert.equal(press!.motion, false)
  const release = parseMouse('\x1b[<0;40;12m')
  assert.equal(release!.press, false, 'release decodes')
  const hover = parseMouse('\x1b[<35;7;3M')
  assert.equal(hover!.motion, true, 'motion flag decodes')
  assert.equal(hover!.button, -1, 'hover carries no button')
  const wheel = parseMouse('\x1b[<64;10;4M')
  assert.equal(wheel!.wheel, true, 'wheel tick decodes')
  assert.equal(parseMouse('a'), null, 'plain keys are not mouse reports')
  assert.equal(parseMouse('\x1b[A'), null, 'arrow keys are not mouse reports')

  // Overlay geometry: page-floating, centred, option rows hit-testable.
  const geo = overlayFromRows(['title', '~sel~one', '~sel~two', 'hint'], 50, 80, 24)
  assert.equal(geo.optionRows.length, 2, 'both option rows are hit-testable')
  assert.equal(geo.optionRows[0], 1)
  assert.equal(geo.optionRows[1], 2)
  assert.equal(geo.left, 15, 'a 50-wide plate centres in 80 columns')
  assert.ok(geo.top >= 0 && geo.top < 24, 'plate sits inside the page')

  // The input router is the single parser: one pass over a raw chunk must
  // split keys from mouse reports, in order, with no leftovers.
  //
  // Printable text arrives as RUNS, not one key per character: a paste is a
  // single multi-character sequence, and that is the only signal separating a
  // typed "/" (open the command tab) from a pasted "/usr/local/bin" (text).
  const mixed = decodeInput('ab\x1b[<0;10;5M\x1b[A\r\x7f\x10')
  assert.deepEqual(mixed.keys.map(k => k.name), ['ab', 'up', 'return', 'backspace', 'p'])
  assert.equal(mixed.keys.at(-1)!.ctrl, true, 'Ctrl+P carries the modifier (readline lost it on Windows)')
  assert.equal(mixed.mouse.length, 1, 'the mouse report is lifted out of the key stream')
  assert.equal(mixed.mouse[0]!.x, 10)

  // The bug that forced this router: readline typed the raw report into the
  // composer as text ("0;5;5M"). Nothing may leak now.
  const leaked = decodeInput('\x1b[<0;5;5M').keys.map(k => k.sequence).join('')
  assert.equal(leaked, '', 'a mouse click never produces characters')
  assert.equal(decodeInput('\x1b[A').keys[0]!.name, 'up', 'arrow keys survive the router')
  // A lone ESC cannot be decided from one read: it is held as pending and
  // flushed as Escape by the router's short timer (ESC-then-a-key is Alt).
  const loneEsc = decodeInput('\x1b')
  assert.equal(loneEsc.keys.length, 0, 'a trailing ESC waits for the next read')
  assert.equal(loneEsc.pending, '\x1b', 'the ESC is carried, not dropped')
  // The screen test asserts the new contract for a batched Esc + char.
  // Hermes binds no Alt chords in this harness, so swallowing both bytes was
  // pure loss — and the loss was real: a 39-byte chunk of `esc/model\r
  // esc/connect\r` (typed while the app was busy) shipped "model" and
  // "connect" to whatever plate was open, and Enter's escape hatch dispatched
  // "connect" as a REQUEST. So an ESC in a chunk now decodes as Escape and the
  // following bytes decode normally: the escape closes the plate, and the rest
  // is carried to the next input owner.
  const batched = decodeInput('\x1bx')
  assert.equal(batched.keys.length, 2, 'alt-shaped bytes decode, not vanish')
  assert.equal(batched.keys[0]!.name, 'escape', 'the ESC is Escape')
  assert.equal(batched.keys[1]!.name, 'x', 'the following byte still types')

  // The operator's bug: a report split across two reads typed `J0` into the
  // composer. Split reports must decode to nothing until complete.
  const half = decodeInput('\x1b[M0')
  assert.equal(half.keys.length, 0, 'half an X10 report yields no characters')
  assert.equal(half.pending, '\x1b[M0', 'half an X10 report is carried over')
  const rest = decodeInput(half.pending + '+%')
  assert.equal(rest.keys.length, 0, 'the completed X10 report yields no characters')
  assert.equal(rest.mouse.length, 1, 'and decodes to one mouse event')
  assert.equal(rest.mouse[0]!.x, 11)
  const halfSgr = decodeInput('\x1b[<0;4')
  assert.equal(halfSgr.keys.length, 0, 'half an SGR report yields no characters')
  assert.ok(halfSgr.pending.length > 0, 'half an SGR report is carried over')
  const sgrRest = decodeInput(halfSgr.pending + '2;16M')
  assert.equal(sgrRest.mouse.length, 1, 'the completed SGR report decodes')
  assert.equal(sgrRest.mouse[0]!.x, 42)
  assert.equal(decodeInput('\n').keys[0]!.name, 'j', 'Ctrl+J wins over LF (composer newline)')
  assert.equal(decodeInput('\r').keys[0]!.name, 'return')
  assert.equal(decodeInput('\x03').keys[0]!.ctrl, true, 'Ctrl+C is recognised from the byte')
  // Legacy X10 mouse (ESC [ M b x y, coords offset by 32). Windows console
  // hosts that ignore mode 1006 send this, and its bytes are printable —
  // the report was landing on screen as typed text.
  const x10 = decodeInput('\x1b[M0+%')
  assert.equal(x10.keys.length, 0, 'an X10 report never produces characters')
  assert.equal(x10.mouse.length, 1, 'an X10 report is decoded')
  assert.equal(x10.mouse[0]!.button, 0, 'left button')
  assert.equal(x10.mouse[0]!.x, 11, 'column is offset by 32')
  assert.equal(x10.mouse[0]!.y, 5, 'row is offset by 32')
  assert.equal(x10.mouse[0]!.press, true)
  const x10release = decodeInput('\x1b[M3+%')
  assert.equal(x10release.mouse[0]!.press, false, 'button 3 means released')
  assert.equal(x10release.mouse[0]!.button, -1)
  assert.equal(x10release.keys.length, 0)

  // Modified Enter (CSI u) is newline, never submit. Plain Enter arrives as
  // CR; every 13u variant is Shift/Ctrl/Alt+Enter asking for a new line.
  for (const seq of ['\x1b[13u', '\x1b[13;2u', '\x1b[13;5u']) {
    const d = decodeInput(seq)
    assert.equal(d.keys.length, 1, `${JSON.stringify(seq)} yields one key`)
    assert.equal(d.keys[0]!.name, 'newline', 'modified Enter is a newline key')
  }

  assert.equal(decodeInput('\x1b[6~').keys[0]!.name, 'pagedown')
  assert.equal(decodeInput('\x1b[5~').keys[0]!.name, 'pageup')
  assert.equal(decodeInput('\x1b[H').keys[0]!.name, 'home')
  assert.equal(decodeInput('\x1b[F').keys[0]!.name, 'end')

  void mouseScreen
  void hits

  // Overlay end-to-end (opencode grammar): the live screen stays painted
  // UNDERNEATH the plate, the plate floats CENTRED on the page, a click on a
  // row commits it, and a click on the background dismisses.
  //
  // Clicks are aimed by READING the painted plate, never by arithmetic: the
  // cursor-addressing escapes say exactly which cell each row landed in, so
  // this asserts "clicking where the row is drawn picks that row" and survives
  // any future change to the plate's height or anchoring.
  {
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live · test')
    st.composerLabel = 'test'
    scr.enter()
    scr.push(st, { text: 'home line', tone: 'plain' })
    const options = [
      { title: '/help', desc: 'this help', value: '/help' },
      { title: '/health', desc: 'meter', value: '/health' },
    ]
    /** Row/column of the last painted plate row containing `needle`. */
    const paintedAt = (needle: string): { row: number; col: number } => {
      const out = get()
      const re = /\x1b\[(\d+);(\d+)H/g
      const spots: Array<{ row: number; col: number; text: string }> = []
      const found = [...out.matchAll(/\x1b\[(\d+);(\d+)H/g)]
      found.forEach((m, i) => {
        const from = (m.index ?? 0) + m[0].length
        const to = i + 1 < found.length ? (found[i + 1]!.index ?? out.length) : out.length
        spots.push({ row: Number(m[1]), col: Number(m[2]), text: strip(out.slice(from, to)) })
      })
      const hit = spots.reverse().find(spot => spot.text.includes(needle))
      assert.ok(hit, `"${needle}" is on screen`)
      return { row: hit!.row, col: hit!.col }
    }

    const picked = runSelect(out, 100, 30, 'Commands', options, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    const painted = strip(get())
    assert.match(painted, /home line/, 'the background screen stays visible behind the plate')
    assert.match(painted, /Commands/, 'the plate title is drawn over it')
    assert.match(painted, /this help/, 'option rows are drawn')
    assert.match(painted, /╭─*╮/, 'the plate is a bordered panel, not a bare block of text')
    assert.match(painted, /╰─*╯/, 'and it has a bottom rail')
    assert.match(painted, /›/, 'the active row is marked with a caret, not an amber wash')
    // Centred, not stacked on the composer at the bottom of the window.
    const top = paintedAt('Commands').row
    const bottom = paintedAt('╰─').row
    assert.ok(top < 30 / 2 && bottom > 30 / 2, `the plate straddles the middle (rows ${top}..${bottom})`)
    assert.ok(bottom < scr.composerTop + 1, 'and it does not sit on the composer')

    const first = paintedAt('/help')
    stdin.emit('data', `\x1b[<0;${first.col + 4};${first.row}M`)
    assert.equal(await within(picked, 2000), '/help', 'a click on the first option commits it')

    const dismissed = runSelect(out, 100, 30, 'Commands', options, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\x1b[<0;5;5M')
    assert.equal(await within(dismissed, 2000), undefined, 'a click on the background dismisses')

    const hovered = runSelect(out, 100, 30, 'Commands', options, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = paintedAt('/health')
    stdin.emit('data', `\x1b[<35;${second.col + 4};${second.row}M`) // hover the second option
    stdin.emit('data', `\x1b[<0;${second.col + 4};${second.row}M`) // then click it
    assert.equal(await within(hovered, 2000), '/health', 'hover previews a row and the click takes that row')
    scr.exit()
  }

  // ── A long plate is fully reachable (the `/model` dead end) ───────────────
  // The model plate listed 85 models and the caret DIED at the end of the
  // first screenful: the clamp used the number of rows the plate could DRAW,
  // not the number of models in the list, so 35 models were unreachable
  // (operator report, 2026-11-04). Keyboard and mouse must both reach the
  // whole list.
  {
    const many: SelectOption[] = Array.from({ length: 85 }, (_, i) => ({
      title: `model-${String(i).padStart(2, '0')}`,
      desc: 'a model',
      value: `model:${i}`,
    }))
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('W', 'm')
    scr.enter()
    const choice = runSelect(out, 100, 30, 'Models', many, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    // End jumps to the LAST model, not to the end of the first screenful.
    stdin.emit('data', '\x1b[F')
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\r')
    assert.equal(await within(choice, 2000), 'model:84', 'End reaches the last model in the list')
    scr.exit()
  }

  // A CLICK in a SCROLLED list picks the option that is drawn there. The slot
  // in the window is not the index in the list: the old hit map used the slot
  // alone, so clicking the 70th model on screen activated the 10th.
  {
    const many: SelectOption[] = Array.from({ length: 85 }, (_, i) => ({
      title: `model-${String(i).padStart(2, '0')}`,
      desc: 'a model',
      value: `model:${i}`,
    }))
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('W', 'm')
    scr.enter()
    const choice = runSelect(out, 100, 30, 'Models', many, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\x1b[F') // scroll to the tail of the list
    await new Promise(resolve => setTimeout(resolve, 10))
    const raw = get()
    const found = [...raw.matchAll(/\x1b\[(\d+);(\d+)H/g)]
    const spots = found.map((m, i) => {
      const from = (m.index ?? 0) + m[0].length
      const to = i + 1 < found.length ? (found[i + 1]!.index ?? raw.length) : raw.length
      return { row: Number(m[1]), col: Number(m[2]), text: strip(raw.slice(from, to)) }
    })
    const hit = spots.reverse().find(spot => spot.text.includes('model-70'))
    assert.ok(hit, 'the scrolled window shows the model it claims to')
    stdin.emit('data', `\x1b[<0;${hit!.col + 4};${hit!.row}M`)
    assert.equal(await within(choice, 2000), 'model:70', 'a click in a scrolled list picks the option under the pointer')
    scr.exit()
  }

  // ── A caret move repaints the PLATE, not the page ─────────────────────────
  // Every arrow key re-emitted the whole base frame, and Windows Terminal
  // paints that as a full-screen blink (operator report, 2026-11-04: "the menu
  // blinks when I move with the keyboard"). The plate writes only the rows
  // that changed.
  {
    const options: SelectOption[] = [
      { title: '/help', desc: 'this help', value: '/help' },
      { title: '/health', desc: 'health', value: '/health' },
      { title: '/status', desc: 'status', value: '/status' },
    ]
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('W', 'm')
    scr.enter()
    const marker = 'BASE-FRAME-MARKER'
    const choice = runSelect(out, 100, 30, 'Commands', options, () => `${marker}\n${scr.frame(st)}`, '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    const before = get().length
    stdin.emit('data', '\x1b[B') // one arrow down
    await new Promise(resolve => setTimeout(resolve, 10))
    const after = get().slice(before)
    assert.ok(after.length > 0, 'the arrow key repainted the plate')
    assert.ok(!after.includes(marker), 'a caret move does NOT repaint the page behind the plate')
    stdin.emit('data', '\x1b')
    await within(choice, 2000)
    scr.exit()
  }

  // ── Approval hit map: clicks answer the dialog ────────────────────────────
  // The choice rows are found by content, never by frame position: the frame is
  // padded to the terminal height, so length-2 points at blanks.
  {
    async function clickDialog(token: string, expected: boolean): Promise<boolean | 'TIMEOUT'> {
      const { out } = fakeOut(100, 30)
      const scr = new Screen(out, 100, 30)
      const st = initialState('WEDNESDAY', 'mode live')
      scr.enter()
      const pending = scr.askApproval(st, {
        title: 'Ready to run',
        body: 'Fix: x',
        prompt: 'Run it?',
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      const frame = strip(scr.lastFrame.join('\n')).split('\n')
      const rowIdx = frame.findIndex(r => r.includes(token))
      assert.ok(rowIdx >= 0, `${token} is drawn`)
      const colIdx = (frame[rowIdx] ?? '').indexOf(token)
      stdin.emit('data', `\x1b[<0;${colIdx + 2};${rowIdx + 1}M`)
      const result = await Promise.race([
        pending,
        new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 500)),
      ])
      scr.exit()
      assert.equal(result, expected, `${token} answers ${expected ? 'run' : 'cancel'}`)
      return result
    }
    assert.equal(await clickDialog('1. Run once', true), true, 'clicking run approves')
    assert.equal(await clickDialog('2. Deny', false), false, 'clicking deny rejects')

    // Keys: 1 runs, 2 rejects, Enter takes the lit row, arrows move it.
    async function pressDialog(keys: string[]): Promise<boolean | 'TIMEOUT'> {
      const { out } = fakeOut(100, 30)
      const scr = new Screen(out, 100, 30)
      const st = initialState('WEDNESDAY', 'mode live')
      scr.enter()
      const pending = scr.askApproval(st, { title: 'Ready to run', body: 'Fix: x', prompt: 'Run it?' })
      await new Promise(resolve => setTimeout(resolve, 10))
      for (const key of keys) {
        await new Promise(resolve => setTimeout(resolve, 5))
        stdin.emit('data', key)
      }
      const result = await Promise.race([pending, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 500))])
      scr.exit()
      return result
    }
    assert.equal(await pressDialog(['y']), true, 'y runs the task')
    assert.equal(await pressDialog(['Y']), true, 'Y runs the task')
    assert.equal(await pressDialog(['n']), false, 'n rejects')
    assert.equal(await pressDialog(['1']), true, '1 runs the task')
    assert.equal(await pressDialog(['2']), false, '2 rejects')
    assert.equal(await pressDialog(['\r']), false, 'Enter on the default (lit deny) rejects')
    assert.equal(await pressDialog(['\x1b[A', '\r']), true, 'Up arms run, so Enter runs it')
    assert.equal(await pressDialog(['\t', '\r']), true, 'Tab arms run too')
    assert.equal(await pressDialog(['\x1b[B', '\r']), false, 'Down goes back to deny')
    assert.equal(await pressDialog(['\x1b']), false, 'Esc rejects')
    assert.equal(await pressDialog(['\x03']), false, 'Ctrl+C rejects')
  }

  // 0. Startup paints NO splash. Reported as "flash screen when i first start":
  //    enter() painted the crest and the first real frame overwrote it a tick
  //    later, so all the splash ever did was flash. The home page is the first
  //    thing on screen now; the splash survives only as a designed frame.
  {
    const { out, get } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    scr.enter()
    const afterEnter = strip(get())
    assert.ok(afterEnter.includes('\x1b[?1049h') || get().includes('\x1b[?1049h'), 'enter switches to the alternate screen')
    // No crest, no wordmark, no gate: nothing but terminal mode switches. The
    // 2026-11 input protocol arming (`?2004h ?1004h >1u`) is a mode switch too.
    assert.ok(!afterEnter.includes('small models'), 'the tagline is not painted at startup')
    assert.ok(!afterEnter.includes('▀▀') && !afterEnter.includes('█'), 'no block-art crest at startup')
    const controls = get().replace(/\x1b\[[?>][0-9;]*[a-z]/gi, '')
    assert.ok(strip(controls).trim().length === 0, `enter paints nothing but mode switches, got ${JSON.stringify(strip(controls).slice(0, 60))}`)
    // The splash is still available as an explicit call (design board A0).
    scr.showSplash()
    assert.match(strip(get()), /Small open models, staffed as a coding team/, 'showSplash still renders the designed frame on demand')
    scr.exit()
  }

  // ── Live bug fixes from real terminal captures (2026-10-04) ───────────────

  // 1. The palette redraw must HOME the cursor before re-emitting the frame.
  //    Without ESC[H the frame is written from wherever the composer caret
  //    was, the terminal scrolls, and every keystroke inside the plate moves
  //    the whole page — which reads as a frozen, unresponsive UI.
  {
    const { out, get } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    scr.render(st)
    const mark = get().length
    void runSelect(out, 80, 24, 'Commands', [
      { title: '/help', desc: 'this help', value: '/help' },
      { title: '/tasks', desc: 'list tasks', value: '/tasks' },
    ], () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 20))
    // The plate arms mouse tracking once, before its first paint; everything
    // after that is frame output, and frame output must always home.
    //
    // The home is preceded by the cursor being hidden: the frame is painted
    // from (1,1), and a visible cursor there is the blinking artifact in the
    // top-left corner of the screen.
    const opened = get().slice(mark).replace(mouseArm(true), '')
    assert.ok(opened.startsWith('\x1b[?25l\x1b[?7l\x1b[H'), 'the overlay redraw hides the cursor and homes before painting the frame')
    // And it must home again on every redraw, not just the first.
    stdin.emit('data', 'x')
    await new Promise(resolve => setTimeout(resolve, 20))
    const afterKey = get().slice(mark + get().slice(mark).indexOf(mouseArm(true)) + mouseArm(true).length)
    assert.ok(afterKey.startsWith('\x1b[?25l\x1b[?7l\x1b[H'), 'every palette redraw homes, so keystrokes never scroll')
    scr.exit()
  }

  // 2. A lone "/" opens the command tab as you type (design board G1), not
  //    after Enter.
  {
    const { out, get } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    const line = scr.readLine(st, [])
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '/')
    const value = await Promise.race([
      line,
      new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 500)),
    ])
    assert.equal(value, '/', 'a lone slash returns immediately, without waiting for Enter')
    assert.equal(scr.pendingPalette, false, 'and does not latch pendingPalette (that would trap Ctrl+C)')
    scr.exit()
  }

  // 3. The caret sits after the prompt's `❯ ` on BOTH layouts. Hermes' prompt
  //    is full-width, so there is no centred box to find: the caret column is
  //    always the third cell of the row.
  {
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live')
    st.home = true
    st.status = ''
    scr.enter()
    scr.render(st)
    const caret = /\x1b\[(\d+);(\d+)H\x1b\[\?25h/.exec(get())
    assert.ok(caret, 'the render addresses the caret')
    const caretCol = Number(caret![2])
    assert.equal(caretCol, 3, `the caret sits after the prompt mark (col ${caretCol})`)
    // The stream view keeps the same full-width prompt.
    st.home = false
    scr.render(st)
    const streamCaret = /\x1b\[(\d+);(\d+)H\x1b\[\?25h/.exec(get().slice(get().lastIndexOf('\x1b[H')))
    assert.equal(Number(streamCaret![2]), 3, 'the stream prompt keeps the caret in the same column')
    scr.exit()
  }

  // 4. The STREAM takes the WHEEL, Hermes grammar. `1000 + 1006` (Hermes'
  //    'wheel' preset) is armed while the composer owns input: wheel ticks
  //    scroll the transcript, plain clicks do nothing, and hover stays off.
  //    This is the behavior the operator compared against Hermes ("i cant
  //    scroll up and down via mouse to see what earlier i did").
  {
    const { out, get } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    for (let i = 0; i < 40; i++) scr.push(st, { text: `line ${i}`, tone: 'plain' })
    const beforeInput = get().length
    const line = scr.readLine(st, [])
    await new Promise(resolve => setTimeout(resolve, 10))
    const armed = get().slice(beforeInput)
    assert.ok(/\?1000h/.test(armed), 'readLine arms press/release reporting')
    assert.ok(/\?1002h/.test(armed), 'and button-motion, so drag selection actually arrives')
    assert.ok(/\?1006h/.test(armed), 'with SGR encoding')
    assert.ok(!/\?1003h/.test(armed), 'hover is not armed for the stream')
    stdin.emit('data', '\x1b[<64;10;10M') // wheel up
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(st.scroll > 0, 'a wheel tick scrolls toward older lines')
    const wheeled = st.scroll
    stdin.emit('data', '\x1b[<0;10;10M') // a plain click, too
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(st.scroll, wheeled, 'a click over the transcript changes nothing in the app')
    // PgUp/PgDn remain the keyboard path, and they must still work.
    stdin.emit('data', '\x1b[5~')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(st.scroll > wheeled, 'PgUp still scrolls toward older lines')
    stdin.emit('data', '\x1b[6~')
    stdin.emit('data', '\x1b[6~')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(st.scroll, 0, 'PgDn still returns to the newest line')
    stdin.emit('data', '\r')
    assert.equal(await within(line, 2000), '', 'the mouse test line resolves')
    scr.exit()
    const stream = get().slice(beforeInput)
    assert.ok(/\?1000l/.test(stream), 'detach disarms wheel reporting')
    assert.ok(/\?1003l/.test(stream), 'and the hover mode too (safe even when unused)')
  }

  // 4b. The arm/disarm grammar itself: button-motion by default (drag-select),
  //     hover only on request, and every mode released again. The order matters
  //     (coarse mode first) or a terminal can be left tracking motion after the
  //     plate closes.
  {
    assert.equal(mouseArm(false), '\x1b[?1000h\x1b[?1002h\x1b[?1006h')
    assert.equal(mouseArm(true), '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1003h')
    assert.equal(mouseDisarm(), '\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l')
    assert.ok(!mouseArm(false).includes('?1003h'), 'hover tracking is opt-in, not the default')
    assert.ok(mouseArm(false).includes('?1002h'), 'drag motion is reported (select-to-copy depends on it)')
  }

  // 5. A pasted multi-character string reaches the composer instead of being
  //    dropped: the old single-char branch discarded the whole paste.
  {
    const { out } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    const line = scr.readLine(st, [])
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '/usr/local/bin')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(st.input, '/usr/local/bin', 'a pasted path lands in the composer')
    assert.equal(scr.pendingPalette, false, 'a pasted slash does not open the command tab')
    stdin.emit('data', '\r')
    assert.equal(await within(line, 2000), '/usr/local/bin')
    scr.exit()
  }

  // ── Boot splash (design board A0) ─────────────────────────────────────────
  const splash = strip(bootSplashRows(80).join('\n'))
  assert.match(splash, /WEDNESDAY/, 'the splash names the product in crisp type')
  assert.match(splash, /Small open models, staffed as a coding team/, 'the brand one-liner stays')
  assert.ok(
    wordmarkRows(80).some(row => /[▀▄█]/.test(row.text)),
    'the wordmark is drawn with real pixels (half-block cells), not spaces',
  )
  // Budget before you draw: the wordmark never clips, it drops. An orphaned
  // half-glyph is worse than no wordmark.
  for (const cols of [44, 56, 68, 88, 110, 132, 200]) {
    const rows = wordmarkRows(cols)
    assert.ok(rows.every(row => row.text.length <= cols), `wordmark fits ${cols} columns`)
    // Per row, not per joined block: a newline is not a column.
    for (const row of bootSplashRows(cols)) {
      assert.ok(visibleWidth(strip(row)) <= cols, `splash row fits ${cols} columns`)
    }
  }
  assert.deepEqual(wordmarkRows(56), [], 'below 53 + 4 cells there is no wordmark — drop, never clip')
  assert.equal(wordmarkRows(80).length, 4, 'the standard size: four half-block rows over eight sub-rows')
  assert.equal(wordmarkRows(120).length, 8, 'a wide terminal gets the nearest-neighbour double')
  assert.ok(wordmarkRows(120).every(row => row.text.length <= 106), 'the double is 106 cells')
  // The feet row wears the accent so the wordmark fades into its rule.
  const stdWord = wordmarkRows(80)
  assert.equal(stdWord[stdWord.length - 1]!.tone, 'cyan', 'the letters feet are the violet flourish')
  assert.ok(stdWord.slice(0, -1).every(row => row.tone === 'bold'), 'the body is bold bone')
  // 52 columns is below the 53-cell floor: nothing is drawn, not a broken one.
  assert.deepEqual(wordmarkRows(52), [], 'a sub-57 terminal gets no wordmark, not a broken one')

  // ── ASCII tier (design board H1) ──────────────────────────────────────────
  assert.equal(supportsOrnamental({}), true, 'ornamental is the default')
  assert.equal(supportsOrnamental({ WEDNESDAY_GLYPHS: 'ascii' }), false, 'the env forces Tier A')
  assert.equal(glyph('skull', false), 'x', 'every mark has a parseable ASCII twin')
  assert.equal(glyph('severed', false), '!', 'blocked is unambiguous in a log')
  assert.equal(glyph('dagger', false), '#', 'archived reads as archived without a legend')
  assert.equal(markFor('verification.started'), 'eye', 'looking gets its own mark')
  assert.equal(markFor('agent.ready'), 'rose', 'the house has one mark')
  assert.equal(markFor('session.note'), null, 'an undesigned event has no mark, not a default')

  // ── /help: one HUD page ──────────────────────────────────────────────────
  // A full-width `✦ AVAILABLE COMMANDS` plate, a plate per category, aligned
  // command rows, then the tip block. The fit rule is the same one the old
  // box had to satisfy — every row stays inside the caller's width.
  const helpFixture: Array<[string, string]> = [['/status', 'route · model · pool · shape'], ['/help', 'this page']]
  const helpOut = renderHelp(96, helpFixture, [{ title: 'Session', names: ['/status'] }, { title: 'Help', names: ['/help'] }], [['--test "c"', 'verify']])
  const helpPlain = helpOut.map(row => row.text).join('\n')
  assert.match(helpPlain, /✦ AVAILABLE COMMANDS/, 'the page opens on the HUD plate')
  assert.match(helpPlain, /✦ SESSION ─/, 'commands are grouped by category plate')
  assert.match(helpPlain, /route · model · pool · shape/, 'command descriptions survive')
  assert.match(helpPlain, /--test/, 'flag names survive')
  assert.match(helpPlain, /1 runs once, 2 denies/, 'the tip block teaches the real approval keys')
  assert.ok(
    renderHelp(40, helpFixture, [{ title: 'Session', names: ['/status'] }], [['--test "c"', 'verify']])
      .every(row => row.text.length <= 40),
    'the help transcript respects a narrow terminal',
  )

  // ── HUD grammar for command answers ──────────────────────────────────────
  // Status, Doctor, /tasks and any paged report wear the same heading as the
  // home panel: a star, the group in caps, a rail to the column edge. The text
  // itself never changes — only tone — so widths and copy are untouched.
  {
    const plate = hudPlate('Weekly Status', 40)
    assert.equal(visibleWidth(plate), 40, 'a plate fills its width exactly')
    assert.ok(strip(plate).startsWith('✦ WEEKLY STATUS ─'), 'star, caps, rail')
    assert.ok(plate.includes(`38;5;${THEME.accent}`), 'and wears the focus tone')
    const heading = strip(hudLine('Wednesday Status', 40))
    assert.equal(visibleWidth(heading), 40, 'a report heading becomes a full-width plate')
    assert.ok(heading.startsWith('✦ STATUS ─'), 'with the duplicate report name folded away')
    assert.equal(strip(hudLine('Session ID: abc', 40)), 'Session ID: abc', 'a label row keeps its text')
    assert.ok(hudLine('Session ID: abc', 40).includes(`38;5;${THEME.accent}`), 'with the label lit')
    assert.ok(strip(hudLine('✔ tests PASS', 40)).startsWith('✔'), 'a pass keeps its mark')
    assert.ok(hudLine('✔ tests PASS', 40).includes(`38;5;${THEME.sage}`), 'and wears the done tone')
    assert.ok(hudLine('✘ build failed', 40).includes(`38;5;${THEME.bloodInk}`), 'a failure wears the alarm tone')
    assert.equal(hudLine('  plain prose only', 40), '  plain prose only', 'prose is never restyled')
    assert.equal(hudLine('see https://x.dev/docs', 40), 'see https://x.dev/docs', 'a URL row is left for the linker')
  }

  // ── The Nevermore gate plate (design board A1 + family I) ─────────────────
  const plate = gatePlateRows({ TERM: 'xterm-256color' })
  assert.equal(plate.length, GATE_ROWS, 'the plate has one row per cell row')
  assert.ok(
    plate.every(row => visibleWidth(strip(row)) === GATE_COLS),
    'every plate row is exactly the plate width in visible columns',
  )
  // Only quadrant-block glyphs and spaces. The set is U+2580, U+2584, U+258C,
  // U+2590, U+2588 and U+2596..U+259F — the half/quadrant/full blocks. Sextants
  // (U+1FB00+) and octants (U+1CD00+) were measured and both render as tofu, so
  // anything outside this range is a portability bug, not a style choice.
  const quadrantOnly = /^[\u2580\u2584\u2588\u258c\u2590\u2596-\u259f ]+$/
  assert.ok(
    plate.every(row => quadrantOnly.test(strip(row))),
    'the plate uses only quadrant blocks, safe on every terminal',
  )
  // Two tones per cell is the whole protocol surface, so colour must be real.
  assert.ok(plate[0]!.includes('38;2;'), 'truecolor foreground per run')
  assert.ok(plate[0]!.includes('48;2;'), 'an independent background per run')
  // Cropping to a narrow terminal keeps the art, it does not squash it.
  for (const cols of [30, 40, 44, 52, 80]) {
    const cropped = gatePlateRowsFor(cols, { TERM: 'xterm-256color' })
    assert.equal(cropped.length, GATE_ROWS, `crop to ${cols} keeps every row`)
    assert.ok(
      cropped.every(row => visibleWidth(strip(row)) === Math.min(cols, GATE_COLS)),
      `crop to ${cols} yields exactly ${Math.min(cols, GATE_COLS)} columns`,
    )
  }
  // NO_COLOR must degrade to the 256 ramp rather than leaking truecolor.
  const ramped = gatePlateRows({ TERM: 'xterm-256color', NO_COLOR: '1' })
  assert.ok(!ramped[0]!.includes('38;2;'), 'NO_COLOR falls back to the 256 ramp')

  // The home page draws the bitmap wordmark when a scale fits, and the crest
  // when none does — a wordmark that has to be clipped is not the same picture.
  function homeAt(w: number, h: number, side?: { title: string; tokens: number; limit: number }): string {
    let captured = ''
    const out = { columns: w, rows: h, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'live')
    st.home = true
    st.status = ''
    st.tip = 'type /help for commands'
    if (side) st.side = side
    // enter(false) skips the splash; exit() is NOT called, because its teardown
    // escapes would land in the captured frame and be counted as content.
    scr.enter()
    scr.render(st)
    // `painted()`, not the byte stream: repaints are addressed writes, so the
    // stream is a patch. Three other helpers here were still slicing "the last
    // frame" out of it, which quietly stopped testing the frame at all.
    return strip(scr.painted().join('\n'))
  }
  const wideHome = homeAt(132, 40)
  assert.ok(wideHome.includes('█'), 'a roomy home page draws the bitmap wordmark above the banner')
  assert.match(wideHome, /╭.*╮/, 'the banner is a rounded frame')
  assert.ok(wideHome.includes('Welcome to Wednesday!'), 'the welcome line sits under the banner')
  assert.match(wideHome, /✦ Tip:/, 'one rotating tip, chosen at startup')
  assert.match(wideHome, /^ ✦ /m, 'the status meter sits above the prompt, opening on the brand star')
  assert.match(wideHome, /❯/, 'the prompt is the last block')
  // Brand (2026-11-01): the banner's hero art is the 4D tesseract cube
  // (braille wireframe, animated); the old baked gate plate is gone. The
  // compact banner replaces the art when the window cannot hold it.
  assert.ok(/[⠁-⣿]/.test(wideHome), 'the hero 4D cube sits in the banner')
  assert.ok(!/[▖-▟▌▐]/.test(wideHome), 'no baked gate-plate art on the start page')
  assert.ok(!/❦/.test(wideHome), 'no opencode header mark on the start page')
  const midHome = homeAt(100, 30)
  assert.ok(/[⠁-⣿]/.test(midHome), 'a 100-column banner still carries the cube')
  const tightHome = homeAt(44, 20)
  assert.ok(!/[⠁-⣿]/.test(tightHome), 'a narrow page uses the compact banner, not cropped art')
  assert.ok(tightHome.includes('Welcome to Wednesday!'), 'the banner still explains itself when narrow')
  const railedHome = homeAt(120, 30, { title: 'fix login leak', tokens: 2318, limit: 13312 })
  assert.ok(!railedHome.includes('┃'), 'no side rail: the banner and meter carry the session')
  assert.match(railedHome, /2\.3K\/13\.0K/, 'the meter carries the token count')
  for (const [w, h] of [[44, 20], [68, 24], [100, 30], [132, 40]] as Array<[number, number]>) {
    assert.ok(
      homeAt(w, h).split('\n').every(row => row.length <= w),
      `home frame fits ${w} columns`,
    )
  }
  assert.ok(
    railedHome.split('\n').every(row => row.length <= 120),
    'the railed home keeps every row inside the frame',
  )

  // Footer location (design record B2): the working directory, plus `:branch`
  // when the directory is a git repository. gitBranch reads `.git/HEAD` once
  // per directory — the assert pins the cache so a thrash (re-reading git on
  // every render tick) fails here rather than in a perf report.
  assert.equal(parseGitHead('ref: refs/heads/main\n'), 'main', 'a branch ref parses to its name')
  assert.equal(parseGitHead('  ref: refs/heads/fix/login-leak  '), 'fix/login-leak', 'a slashed branch survives')
  assert.equal(parseGitHead('deadbeefcafe\n'), '', 'a detached HEAD names no branch')
  assert.equal(parseGitHead(''), '', 'an empty HEAD is not a crash')
  assert.equal(gitBranch(process.cwd()), gitBranch(process.cwd()), 'the branch cache answers the same twice')
  assert.ok(wideHome.includes(process.cwd()), 'the banner carries the working directory')
  const repoBranch = gitBranch(process.cwd())
  if (repoBranch) {
    assert.ok(wideHome.includes(`⎇ ${repoBranch}`), 'and the meter names the branch')
  }

  // A home toast (the page's only receipt): the stream's note lands in
  // `messages`, a list the home page never draws, so a home-page action like a
  // model switch with no toast would change nothing the operator can see.
  {
    let captured = ''
    const out = { columns: 100, rows: 30, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, 100, 30)
    const st = initialState('WEDNESDAY', 'live')
    st.home = true
    st.status = ''
    st.toast = 'route → demo-model'
    scr.enter()
    scr.render(st)
    const toasted = strip(scr.painted().join('\n'))
    assert.ok(toasted.includes('route → demo-model'), 'a home toast is drawn — the page has no stream to push into')
    scr.exit()
  }

  // Session footer (Hermes grammar): the meter sits above the prompt, and the
  // empty prompt's placeholder carries the hints. The banner owns the location.
  {
    const sessionAt = (w: number): string => {
      let captured = ''
      const out = { columns: w, rows: 24, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
      const scr = new Screen(out, w, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      st.status = COMPOSER_HINTS
      scr.enter()
      scr.render(st)
      const frame = strip(scr.painted().join('\n'))
      scr.exit()
      return frame
    }
    const wideSession = sessionAt(100)
    assert.match(wideSession, /✦/, 'the meter is drawn above the prompt')
    assert.ok(wideSession.includes('ctrl+p palette'), 'the empty prompt carries the hints')
    assert.ok(wideSession.includes('❯'), 'the prompt is drawn')
    assert.ok(!wideSession.includes(process.cwd()), 'the session frame is transcript + meter + prompt, not a footer')
    const tightSession = sessionAt(64)
    assert.ok(tightSession.includes('ctrl+p palette'), 'a narrow session keeps the hints')
    for (const line of tightSession.split('\n')) assert.ok(visibleWidth(line) <= 64, 'and never overflows')
  }

  // ── Multiline composer: wraps, caps, never spills ─────────────────────────
  // A long logical line wraps to visual rows (nothing lost to clipping); more
  // than 8 visual rows scroll with an indicator in the tag rail; the box keeps
  // its corners and the frame keeps its width at every size.
  function streamFrame(w: number, h: number, input: string): string[] {
    let captured = ''
    const out = { columns: w, rows: h, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
    const scr = new Screen(out, w, h)
    const st = initialState('WEDNESDAY', 'live')
    st.composerLabel = 'test'
    st.input = input
    st.cursor = input.length
    scr.enter()
    scr.render(st)
    return scr.painted().map(strip)
  }
  {
    // Long line wraps instead of clipping the tail away. Hermes' prompt has a
    // rule above and below; the wrapped rows live between them.
    const rows = streamFrame(80, 30, `word `.repeat(40).trim())
    const inputAt = rows.findIndex(r => r.includes('❯'))
    const bottom = rows.findIndex((r, i) => i > inputAt && /^─+$/.test(r.trimEnd()))
    assert.ok(inputAt > 0 && bottom > inputAt, 'the prompt and its closing rule are drawn')
    assert.ok(bottom - inputAt >= 3, 'a 200-char line wraps to 3+ visual rows')
    assert.ok(rows.every(r => visibleWidth(r) === 80), 'every wrapped row is exactly the frame width')
  }
  {
    // 12 logical lines cap at 8 visual rows with a scroll indicator in the top
    // rule; the prompt keeps rule + 8 rows + rule, and the frame keeps its width.
    const input = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const rows = streamFrame(80, 30, input)
    const inputAt = rows.findIndex(r => r.includes('❯'))
    const top = inputAt - 1
    const bottom = rows.findIndex((r, i) => i > inputAt && /^─+$/.test(r.trimEnd()))
    assert.equal(bottom - inputAt, 8, 'the prompt shows exactly 8 visual rows')
    assert.match(rows[top]!, /▲4/, 'the top rule counts the hidden rows')
    assert.match(rows[bottom - 1]!, /line 12/, 'the window follows the cursor to the end')
    assert.ok(rows.every(r => visibleWidth(r) === 80), 'capped prompt keeps every row at frame width')
  }

  // ── Resizing with an overlay open must redraw the OVERLAY ─────────────────
  // Overlays paint on top of the frame instead of through it, so render() alone
  // left them stale: dragging the window narrower repainted the page and left
  // the plate's old pixels plus its old hit map on screen, so clicking a row
  // that LOOKS drawn did nothing.
  {
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live · test')
    scr.enter()
    scr.render(st)
    const options = [
      { title: '/help', desc: 'this help', value: '/help' },
      { title: '/health', desc: 'meter', value: '/health' },
    ]
    const paintedAt = (needle: string): { row: number; col: number } => {
      const raw = get()
      const found = [...raw.matchAll(/\x1b\[(\d+);(\d+)H/g)]
      const spots = found.map((m, i) => {
        const from = (m.index ?? 0) + m[0].length
        const to = i + 1 < found.length ? (found[i + 1]!.index ?? raw.length) : raw.length
        return { row: Number(m[1]), col: Number(m[2]), text: strip(raw.slice(from, to)) }
      })
      const hit = spots.reverse().find(spot => spot.text.includes(needle))
      assert.ok(hit, `"${needle}" is on screen`)
      return { row: hit!.row, col: hit!.col }
    }
    const picked = runSelect(out, 100, 30, 'Commands', options, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    const wide = paintedAt('/help')
    scr.resize(50, 16)
    await new Promise(resolve => setTimeout(resolve, 10))
    const narrow = paintedAt('/help')
    // The plate is narrower now, so its left edge moves toward the middle.
    assert.ok(narrow.col < wide.col, `the plate re-lays out on the narrower window (${wide.col} → ${narrow.col})`)
    assert.ok(narrow.row <= 16, 'and it is inside the new height')
    // The hit map followed the pixels: clicking the option where it is NOW
    // drawn commits that option.
    stdin.emit('data', `\x1b[<0;${narrow.col + 4};${narrow.row}M`)
    assert.equal(await within(picked, 2000), '/help', 'a click after a resize still commits the row it landed on')
    scr.exit()
  }

  // ── Mouse reporting is armed for the OVERLAY, on the screen's own stream ──
  // The string grammar was always right; what matters is that the modes are
  // written where the frame goes and are gone the moment the overlay closes.
  {
    const stream = fakeOut(100, 30)
    stream.out.isTTY = true
    const scr = new Screen(stream.out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    assert.ok(!/\?1000h/.test(stream.get()), 'entering the screen arms nothing')
    const opened = stream.get().length
    void runSelect(stream.out, 100, 30, 'Commands', [{ title: '/help', desc: 'd', value: '/help' }], () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 10))
    const whileOpen = stream.get().slice(opened)
    assert.ok(whileOpen.includes('\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1003h'), 'the plate arms button + hover tracking on the screen stream')
    // Enter picks the row, which is the plate's own exit path.
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 20))
    const afterClose = stream.get()
    assert.ok(afterClose.includes('\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l'), 'and disarms every mode when it closes')
    scr.exit()
  }
  {
    // The approval gate arms buttons only: it has no hover, and asking for
    // motion tracking there would cost selection for nothing.
    const stream = fakeOut(100, 30)
    stream.out.isTTY = true
    const scr = new Screen(stream.out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    const mark = stream.get().length
    void scr.askApproval(st, { title: 'Ready to run', body: 'Fix: x', prompt: 'Run it? [y/N]' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const armed = stream.get().slice(mark)
    assert.ok(armed.includes('\x1b[?1000h\x1b[?1002h\x1b[?1006h'), 'the gate arms button tracking')
    assert.ok(!armed.includes('?1003h'), 'and does not pay for hover tracking')
    stdin.emit('data', 'n')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(stream.get().includes('\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l'), 'the gate disarms on an answer')
    scr.exit()
  }

  // ── Startup advisories report through the screen, and never reject ────────
  // The health meter and the update notice used to be awaited BEFORE the
  // alternate screen existed, so a slow meter or an offline registry left the
  // operator staring at nothing for seconds and then wiped the output. They now
  // run after enter() and report through the screen — which is only true if the
  // policy lives in a function this test can call without a TTY.
  {
    const { out, get } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    runAdvisories(scr, st, {
      health: async () => 'health: WARN (11 checks) — /health for detail',
      update: async () => 'Update available: 0.1.0 → 0.2.0. Run: npm i -g @lab1207/wednesday',
    })
    // Nothing is on screen yet, synchronously after the call — that IS the
    // property: the first paint was never blocked on the meter or the network.
    assert.ok(!/health: WARN/.test(strip(get())), 'the advisories do not block the first paint')
    await new Promise(resolve => setTimeout(resolve, 20))
    const painted = strip(get())
    assert.match(painted, /health: WARN/, 'the health lamp arrives as a toast')
    assert.match(painted, /Update available/, 'the update notice arrives on screen')
    assert.ok(st.messages.some(m => /Update available/.test(m.text)), 'and it is in the scrollback, not console output')
    scr.exit()
  }
  {
    // A failing advisory is not news: it must not reject into the session.
    const { out } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    let unhandled = 0
    const onRejection = (): void => { unhandled += 1 }
    process.on('unhandledRejection', onRejection)
    runAdvisories(scr, st, {
      health: async () => { throw new Error('meter offline') },
      update: async () => null,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.off('unhandledRejection', onRejection)
    assert.equal(unhandled, 0, 'a failing advisory never becomes an unhandled rejection')
    assert.equal(st.toast, null, 'and it toasts nothing')
    scr.exit()
  }

  // ── DEPTH: a panel must show which way the light falls ────────────────────
  // Every panel used ONE border colour on all four edges, so nothing read as
  // raised: a box with no light direction is a printed rectangle. That is the
  // whole of "the theme is good but it could be much better" from the outside.
  // The fix is colour-only — same characters, so every geometry invariant above
  // still holds. These assertions are what stop it drifting back to flat.
  {
    // The command plate is the floating panel that still carries all four
    // edges; the composer is now Hermes' rule-and-caret prompt.
    const box = selectLines('Commands', [{ title: '/help', desc: 'this help', value: '/help' }], '', 0, 60, 20).join('\n')
    assert.ok(
      box.includes(`\x1b[38;5;${THEME.edgeTop}m`),
      `the plate top rail is the LIT edge (edgeTop ${THEME.edgeTop})`,
    )
    assert.ok(
      box.includes(`\x1b[38;5;${THEME.edgeSide}m\u2502`),
      `the plate verticals are the body edge (edgeSide ${THEME.edgeSide})`,
    )
    assert.ok(
      box.includes(`\x1b[38;5;${THEME.edgeBottom}m\u2570`),
      `the plate bottom rail is the CAST edge (edgeBottom ${THEME.edgeBottom})`,
    )
    // The three steps must actually differ, or "depth" is one colour three names.
    assert.notEqual(THEME.edgeTop, THEME.edgeSide, 'lit and body edges are different steps')
    assert.notEqual(THEME.edgeSide, THEME.edgeBottom, 'body and cast edges are different steps')
    // ...and they must differ by ENOUGH. The first ladder used 240/238/236 and
    // was reported as "where is the glass theme": three adjacent greys two steps
    // apart are the same colour to anyone not holding a colour picker. Asserting
    // only `notEqual` would have passed that.
    //
    // Measured in LUMINANCE, not palette index: the violet ramp crosses the
    // greyscale ramp, so index order stopped meaning anything the day the edges
    // became lavender (141 < 235 numerically, far brighter on screen).
    const MIN_EDGE_SEPARATION = 0.06
    const topL = luminance(THEME.edgeTop)
    const sideL = luminance(THEME.edgeSide)
    const bottomL = luminance(THEME.edgeBottom)
    assert.ok(
      topL - sideL >= MIN_EDGE_SEPARATION,
      `lit and body edges are ${(topL - sideL).toFixed(3)} luminance apart (want ${MIN_EDGE_SEPARATION})`,
    )
    assert.ok(
      sideL - bottomL >= MIN_EDGE_SEPARATION,
      `body and cast edges are ${(sideL - bottomL).toFixed(3)} luminance apart (want ${MIN_EDGE_SEPARATION})`,
    )
    // The surfaces must also be genuinely above the page, or there is nothing to
    // light. The composer used to have NO fill at all.
    assert.ok(THEME.surface >= THEME.bg + 3, `the composer fill sits above the page (${THEME.bg} -> ${THEME.surface})`)
    assert.ok(THEME.surface2 > THEME.surface, `a floating plate sits above the composer (${THEME.surface} -> ${THEME.surface2})`)
    assert.ok(topL > luminance(THEME.surface), 'the lit edge is lighter than the surface it lights')
    assert.ok(bottomL < luminance(THEME.surface), 'the cast edge is darker than the surface it shadows')
  }
  {
    // The plate is the floating surface, so it gets the full ladder PLUS a cast
    // shadow. Both are what stop it reading as a pasted block of text.
    const options: SelectOption[] = [
      { title: '/help', desc: 'this help', value: '/help' },
      { title: '/health', desc: 'meter', value: '/health' },
      { title: '/exit', desc: 'leave', value: '/exit' },
    ]
    const { out, get } = fakeOut(100, 30)
    const scr = new Screen(out, 100, 30)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    void runSelect(out, 100, 30, 'Commands', options, () => scr.frame(st), '', scr)
    await new Promise(resolve => setTimeout(resolve, 20))
    const painted = get()
    const plate = painted.slice(painted.lastIndexOf('\x1b[H') + 3)
    assert.ok(plate.includes(`\x1b[38;5;${THEME.edgeTop}m\u256d`), 'the plate top rail is lit')
    assert.ok(plate.includes(`\x1b[38;5;${THEME.edgeBottom}m\u2570`), 'the plate bottom rail is cast')
    assert.ok(
      plate.includes(`\x1b[38;5;${THEME.shadow}m`),
      `the plate casts a shadow (shadow token ${THEME.shadow})`,
    )
    assert.ok(plate.includes('\u2591'), 'the shadow is drawn as a texture (the 256 ramp cannot go darker than the page)')
    assert.ok(plate.includes('\u2592'), 'and its right edge has a shadow cell too')
    // The shadow is OFFSET: below the plate and right of it, never under the
    // panel's own cells. A shadow drawn flush reads as a thick border.
    const bottomRail = plate.indexOf('\u2570')
    const shadowAt = plate.indexOf('\u2591')
    assert.ok(shadowAt > bottomRail, 'the shadow sits below the bottom rail, not on it')
    scr.exit()
  }

  // ── WIDTH: display columns, not code units (B83) ───────────────────────────
  // Literal expected counts, deliberately NOT computed by the same table the app
  // uses - a width test that asks the implementation what it thinks the answer
  // is proves nothing. These are the numbers a terminal draws.
  {
    const cols = (text: string): number => visibleWidth(text)
    assert.equal(cols('abc'), 3, 'ASCII is one column each')
    assert.equal(cols('\u4f60\u597d'), 4, 'CJK han is TWO columns each')
    assert.equal(cols('\u3053\u3093'), 4, 'hiragana is two columns each')
    assert.equal(cols('\uc548\ub155'), 4, 'hangul is two columns each')
    assert.equal(cols('\uff21\uff22'), 4, 'fullwidth latin is two columns each')
    // e+́ l+̀ e+́ v e+́ : five BASE characters, three combining marks at zero width.
    assert.equal(cols('e\u0301le\u0300ve\u0301'), 5, 'combining marks add nothing')
    assert.equal(cols('\u{1f680}'), 2, 'an emoji is two columns')
    assert.equal(cols('\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}'), 2, 'a ZWJ sequence is ONE glyph')
    assert.equal(cols('\u2714\ufe0f'), 2, 'VS16 promotes its base to emoji presentation')
    assert.equal(cols('\u2714'), 1, 'and without it, the same glyph is one column')
    assert.equal(cols('\x1b[38;5;98mabc\x1b[0m'), 3, 'escapes stay zero-width')

    // Clipping must not hand the terminal more columns than it asked for. This
    // is the bug: 20 code units of Chinese is 40 columns, which wrapped the
    // frame and tore the border off the row.
    for (const asked of [10, 20, 21, 40]) {
      const cjk = clipVisible('\u4f60\u597d\u4e16\u754c\u8fd9\u662f\u4e00\u4e2a\u6d4b\u8bd5\u6587\u672c', asked)
      assert.ok(
        visibleWidth(cjk) <= asked,
        `clipping CJK to ${asked} columns yields ${visibleWidth(cjk)}`,
      )
    }
    // A wide character is never split: half a glyph is a replacement character.
    assert.equal(
      visibleWidth(clipVisible('\u4f60\u597d', 3)),
      2,
      'a double-width glyph that does not fit is left out whole, not sliced',
    )
    // Emoji sequences are indivisible too.
    assert.ok(
      !clipVisible('\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 ok', 2).includes('\ufffd'),
      'clipping never splits a ZWJ sequence into replacement characters',
    )

    // wrap() must BREAK in columns. Cutting 40 code units hands the terminal 80
    // columns of Chinese, which overflows just as badly as clipping to the wrong
    // width did - so this needed its own case, not just the frame check below.
    //
    // Driven through a STREAM MESSAGE, not the composer: the composer clips the
    // draft to the box and windows it, so it never calls wrap() at all. The
    // first version of this test drove the composer, passed, and proved nothing.
    const wrappedRows = (w: number, h: number, message: string): string[] => {
      const fab = fakeOut(w, h)
      const s3 = new Screen(fab.out, w, h)
      const st3 = initialState('WEDNESDAY', 'mode live \u00b7 m')
      st3.composerLabel = 'm'
      st3.messages.push({ text: message, tone: 'plain' })
      s3.enter()
      s3.render(st3)
      const rows = s3.painted().map(strip)
      s3.exit()
      return rows
    }
    {
      // The symptom is NOT a wide row: the frame clips each wrapped part
      // afterwards, so a wrap that cuts in the wrong unit still produces a
      // correctly sized row - it just quietly EATS the overflow. Reverting the
      // column maths passed a width assertion and dropped half the message, so
      // the property held here is that no character is lost.
      const source = '\u4f60'.repeat(60)
      const rows = wrappedRows(40, 24, source)
      const shown = rows.join('').split('\u4f60').length - 1
      assert.equal(shown, 60, `all 60 CJK characters survive the wrap (saw ${shown})`)
      assert.ok(rows.filter(r => r.includes('\u4f60')).length > 1, 'and it genuinely wrapped')
    }
    {
      // And with the wrap correct the rows still respect the width.
      const rows = wrappedRows(40, 24, '\u4f60'.repeat(60))
      assert.equal(rows.filter(r => visibleWidth(r) > 40).length, 0, 'every wrapped row fits 40 columns')
    }
    {
      // Mixed widths in one line: the break has to land on a column boundary
      // whichever kind of character it lands on.
      const mixed = `${'ab '.repeat(20)}\u4f60\u597d${'cd '.repeat(20)}`
      const rows = wrappedRows(40, 24, mixed)
      assert.ok(rows.every(r => visibleWidth(r) <= 40), 'a mixed ASCII/CJK line wraps inside the width')
      assert.ok(rows.join('').includes('\u4f60\u597d'), 'and the CJK run is not split across a break')
    }

    // The frame itself: at every width, no row may exceed the terminal.    // The frame itself: at every width, no row may exceed the terminal. The
    // failure mode is not subtle - the row wraps and the right border and the
    // Context rail are pushed off the screen.
    for (const w of [20, 40, 60, 100]) {
      const fab = fakeOut(w, 16)
      const s2 = new Screen(fab.out, w, 16)
      const st2 = initialState('WEDNESDAY', 'mode live \u00b7 m')
      st2.composerLabel = '\u6a21\u578b-x'
      st2.side = { title: '\u4f1a\u8bdd', tokens: 2318, limit: 13312 }
      st2.messages.push({ text: '\u4f60\u597d\u4e16\u754c\uff0c\u8fd9\u662f\u4e00\u4e2a\u6d4b\u8bd5\u6587\u672c\u7528\u4e8e\u68c0\u67e5\u5bbd\u5ea6\u662f\u5426\u6b63\u786e', tone: 'plain' })
      st2.status = '\u5c31\u7eea \u00b7 pgup/pgdn'
      s2.enter()
      s2.render(st2)
      const tooWide = s2.painted().filter(row => visibleWidth(strip(row)) > w)
      assert.equal(tooWide.length, 0, `at ${w} columns, ${tooWide.length} row(s) exceed the width`)
      s2.exit()
    }
  }

  // Brand overhaul 2026-11-01: animated 4D cube hero, responsive home at every
  // terminal size, mouse drag-selection + copy, and "/" opening the command
  // plate DURING a live run.
  {
    // (a) The tesseract renders braille pixels at any size and animates.
    const a = tesseractRows(30, 9, 0.9)
    assert.equal(a.length, 9, 'cube frame keeps the requested height')
    assert.ok(a.every(row => visibleWidth(row.text) <= 30), 'cube rows never exceed the width')
    assert.ok(a.some(row => /[⠁-⣿]/.test(row.text)), 'the cube is braille pixels, not box-drawing art')
    const b = tesseractRows(30, 9, 1.7)
    assert.notDeepEqual(b.map(row => row.text), a.map(row => row.text), 'the cube animates — two moments differ')

    // (b) The home hero carries the 4D cube when it fits and drops it WHOLE on
    // a narrow terminal; no row ever exceeds the terminal width at any size;
    // and the old baked gate plate (quadrant-glyph pixel art) is GONE from
    // every screen (brand decision 2026-11-01: the cube is the only hero art).
    for (const [w, h] of [[40, 12], [50, 16], [60, 20], [80, 24], [95, 26], [100, 30], [120, 40], [200, 60]] as const) {
      const f = fakeOut(w, h)
      const s = new Screen(f.out, w, h)
      const st = initialState('WEDNESDAY', 'mode live')
      st.home = true
      s.enter()
      s.render(st)
      const tooWide = s.painted().filter(row => visibleWidth(strip(row)) > w)
      assert.equal(tooWide.length, 0, `home at ${w}x${h}: no painted row exceeds the width`)
      const painted = strip(s.painted().join('\n'))
      assert.ok(!/[▌▐▖▗▘▝▞▚]{6,}|█{20,}/.test(painted), `home at ${w}x${h}: no gate-plate pixel art`)
      assert.equal(/[⠁-⣿]/.test(painted), w >= 95 && h >= 26, `home at ${w}x${h}: cube shown exactly when the non-compact page fits it`)
      s.exit()
    }
    {
      // The cube lives in the banner's left column; the wordmark above it.
      const wide = fakeOut(120, 40)
      const s = new Screen(wide.out, 120, 40)
      const st = initialState('WEDNESDAY', 'mode live')
      st.home = true
      s.enter(); s.render(st)
      assert.ok(/[⠁-⣿]/.test(strip(wide.get())), 'wide home paints the 4D cube in the banner')
      s.exit()
      const narrow = fakeOut(30, 12)
      const s2 = new Screen(narrow.out, 30, 12)
      const st2 = initialState('WEDNESDAY', 'mode live')
      st2.home = true
      s2.enter(); s2.render(st2)
      assert.ok(!/[⠁-⣿]/.test(strip(narrow.get())), 'narrow home drops the cube whole instead of clipping it')
      s2.exit()
    }

    // (b2) /new regression: after a clearSession-style home reset, with the
    // cube animation ticking, the composer must still accept input (the
    // reported "screen hangs on the home screen after /new").
    for (const [w, h] of [[60, 20], [80, 24], [100, 30], [120, 40]] as const) {
      const f = fakeOut(w, h)
      const s = new Screen(f.out, w, h)
      const st = initialState('WEDNESDAY', 'mode live')
      st.home = true
      st.side = { title: 'wednesday', tokens: 0, limit: 13312, rows: [{ text: 'commands…', tone: 'dim' }] }
      s.enter()
      s.render(st)
      // what ui.clearSession(true) does (harness.ts)
      st.messages.length = 0
      st.home = true
      st.status = ''
      st.queued = []
      s.invalidate()
      s.render(st)
      s.notify(st, 'session cleared — a fresh session starts here')
      await new Promise(r => setTimeout(r, 500)) // let the cube timer tick
      const line = s.readLine(st, [])
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', 'ok')
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '\r')
      const v = await Promise.race([line, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 900))])
      assert.equal(v, 'ok', `after /new at ${w}x${h} the composer still reads input`)
      s.exit()
    }

    // (b3) /new's CONFIRM is where the reported freeze was felt: the gate
    // opens on home with the cursor on "No, keep going", a stray Enter keeps
    // the session, and the receipt used to be pushed into the transcript — a
    // surface the home page never paints. Nothing on screen changed, so a
    // live session looked dead. On home the harness routes the note to the
    // toast (`note` in replLoop); this pins the whole visible contract.
    {
      const f = fakeOut(100, 30)
      const s = new Screen(f.out, 100, 30)
      const st = initialState('WEDNESDAY', 'mode live')
      st.home = true
      s.enter()
      s.render(st)
      const answer = s.confirm(st, {
        title: 'Start a new session?',
        body: 'This ends the current conversation and clears the transcript.',
        prompt: '',
        headline: '✦ confirm',
        choices: [
          { key: '1', label: 'Yes, start a new session', value: 'run' },
          { key: '2', label: 'No, keep going', value: 'cancel' },
        ],
        hint: '↑/↓ select · Enter confirm · 1/2 quick pick · Esc keeps going',
      })
      await new Promise(r => setTimeout(r, 10))
      assert.equal(st.dialog?.focus, 'cancel', 'the session-wipe confirm opens on No')
      stdin.emit('data', '\r')
      const kept = await Promise.race([answer, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 900))])
      assert.equal(kept, false, 'Enter keeps the session')
      assert.equal(st.dialog, null, 'and the gate is gone, not left painting over home')
      // harness.ts `note`: a home receipt is a toast, never an invisible row.
      if (st.home) s.notify(st, 'kept going — nothing was cleared')
      const painted = strip(s.painted().join('\n'))
      assert.ok(painted.includes('kept going'), 'the cancel receipt is painted on the home page')
      s.exit()
    }

    // (c) A lone "/" during a LIVE RUN opens the command plate (onSlash
    // fires, the draft clears) — the fix for "the / menu never shows while a
    // task runs".
    {
      const f = fakeOut(80, 24)
      const s = new Screen(f.out, 80, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      for (let i = 0; i < 10; i++) s.push(st, { text: `event ${i}`, tone: 'plain' })
      let slashes = 0
      const stop = s.watchRun(st, () => {}, () => {}, () => { slashes++ })
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '/')
      await new Promise(r => setTimeout(r, 10))
      assert.equal(slashes, 1, 'lone / mid-run fires the palette callback')
      assert.equal(st.input, '', 'the / is consumed, not queued as a literal')
      assert.equal(s.pendingPalette, true, 'the plate is latched pending')
      stop()
      s.exit()
    }

    // (d) Mouse drag selects transcript rows; right-click copies via OSC 52.
    {
      const f = fakeOut(80, 24)
      const s = new Screen(f.out, 80, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      for (let i = 0; i < 20; i++) s.push(st, { text: `row ${i}`, tone: 'plain' })
      s.enter()
      const before = f.get().length
      const stop = s.watchRun(st, () => {}, () => {})
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '\x1b[<0;5;6M')    // left press at frame row 6
      stdin.emit('data', '\x1b[<32;5;9M')   // drag motion to row 9
      stdin.emit('data', '\x1b[<0;5;9m')    // release
      await new Promise(r => setTimeout(r, 10))
      assert.deepEqual(st.selection, { row: 6, col: 5, toRow: 9, toCol: 5 }, 'drag selects cells from (6,5) to (9,5)')
      stdin.emit('data', '\x1b[<2;5;9m')    // right-click release = copy
      await new Promise(r => setTimeout(r, 10))
      const out = f.get().slice(before)
      assert.ok(out.includes('\x1b]52;c;'), 'right-click copies via OSC 52')
      assert.match(strip(out), /copied \d+ lines? to the clipboard/, 'the toast confirms the copy')
      assert.equal(st.selection, null, 'copy clears the selection')
      stop()
      s.exit()
    }

    // (e) In the idle composer, Ctrl+C with a selection COPIES instead of
    // exiting; without a selection the two-press window still exits.
    {
      const f = fakeOut(80, 24)
      const s = new Screen(f.out, 80, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      for (let i = 0; i < 20; i++) s.push(st, { text: `row ${i}`, tone: 'plain' })
      s.enter()
      const line = s.readLine(st, [])
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '\x1b[<0;5;4M')
      stdin.emit('data', '\x1b[<32;8;4M')   // drag: a click alone now deselects
      stdin.emit('data', '\x1b[<0;8;4m')
      await new Promise(r => setTimeout(r, 10))
      assert.ok(st.selection, 'selection exists before Ctrl+C')
      const before = f.get().length
      stdin.emit('data', '\x03')            // ctrl+c copies
      await new Promise(r => setTimeout(r, 10))
      assert.ok(f.get().slice(before).includes('\x1b]52;c;'), 'ctrl+c with a selection copies via OSC 52')
      assert.equal(st.selection, null, 'copy clears the selection')
      let settled = false
      void line.then(() => { settled = true })
      assert.equal(settled, false, 'the prompt is NOT exited by the copying Ctrl+C')
      stdin.emit('data', '\x03')            // first exit press
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '\x03')            // second exit press within the window
      const value = await Promise.race([line, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 500))])
      assert.equal(value, undefined, 'second Ctrl+C exits the prompt as before')
      s.exit()
    }

    // (f) The pager is a reading surface too: a drag paints the rows it will
    // copy, Ctrl+C copies them, and the receipt lands in the pager's OWN hint
    // row — the stream's toast row is not painted while the pager owns the
    // window, which made copy look dead on the one screen built for reading.
    {
      const f = fakeOut(80, 24)
      const s = new Screen(f.out, 80, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      st.home = false
      s.enter()
      const opening = s.page(st, 'Help', Array.from({ length: 60 }, (_, i) => `line ${i}`))
      await new Promise(r => setTimeout(r, 10))
      assert.ok(st.pager, 'the pager owns the window')
      const mark = f.get().length
      stdin.emit('data', '\x1b[<0;6;3M')
      stdin.emit('data', '\x1b[<32;6;5M')
      stdin.emit('data', '\x1b[<0;6;5m')
      await new Promise(r => setTimeout(r, 10))
      assert.deepEqual(st.selection, { row: 3, col: 6, toRow: 5, toCol: 6 }, 'a drag on the pager selects cells, not whole rows')
      stdin.emit('data', '\x03')
      await new Promise(r => setTimeout(r, 10))
      const out = f.get().slice(mark)
      assert.ok(out.includes('\x1b]52;c;'), 'Ctrl+C copies the pager selection')
      const payload = /\]52;c;([A-Za-z0-9+/=]+)/.exec(out)?.[1] ?? ''
      const copied = Buffer.from(payload, 'base64').toString('utf8')
      assert.equal(copied, '0\nline 1\nline 2', 'the copy starts mid-row and ends mid-row, exactly as dragged')
      assert.match(strip(out), /copied \d+ lines? to the clipboard/, 'and the pager hint row carries the receipt')
      stdin.emit('data', 'q')
      await Promise.race([opening, new Promise(r => setTimeout(r, 500))])
      assert.equal(st.pager, null, 'q still closes the pager')
      s.exit()
    }

    // (g) Cell precision and click-to-deselect in the stream: a drag from the
    // middle of a word copies from that character, and a plain click (press +
    // release, no motion) clears the selection instead of selecting a line.
    {
      const f = fakeOut(80, 24)
      const s = new Screen(f.out, 80, 24)
      const st = initialState('WEDNESDAY', 'mode live')
      s.push(st, { text: 'alpha', tone: 'plain' })
      s.enter()
      const stop = s.watchRun(st, () => {}, () => {})
      await new Promise(r => setTimeout(r, 10))
      stdin.emit('data', '\x1b[<0;3;1M')
      stdin.emit('data', '\x1b[<32;5;1M')
      stdin.emit('data', '\x1b[<0;5;1m')
      await new Promise(r => setTimeout(r, 10))
      assert.deepEqual(st.selection, { row: 1, col: 3, toRow: 1, toCol: 5 }, 'the drag keeps its exact cells')
      const mark = f.get().length
      stdin.emit('data', '\x03')
      await new Promise(r => setTimeout(r, 10))
      const payload = /\x1b\]52;c;([A-Za-z0-9+/=]+)/.exec(f.get().slice(mark))?.[1] ?? ''
      assert.equal(Buffer.from(payload, 'base64').toString('utf8'), 'pha', 'copy is the dragged characters, not the line')
      stdin.emit('data', '\x1b[<0;1;1M')
      stdin.emit('data', '\x1b[<32;4;1M')
      stdin.emit('data', '\x1b[<0;4;1m')
      await new Promise(r => setTimeout(r, 10))
      assert.ok(st.selection, 'a second drag selects again')
      stdin.emit('data', '\x1b[<0;10;5M')
      stdin.emit('data', '\x1b[<0;10;5m')
      await new Promise(r => setTimeout(r, 10))
      assert.equal(st.selection, null, 'a click with no drag deselects')
      stop()
      s.exit()
    }
  }

  // (h) Run stages — a lifecycle row says WHERE in the pipeline the work is,
  // and the activity line names the stage instead of a texture verb.
  {
    const plan = eventMessage('agent.started', 'architect')
    assert.match(plan.text, /1 plan\s+working · architect/, 'a started agent row carries its stage')
    const done = eventMessage('agent.completed', 'architect', { detail: '2 files' })
    assert.match(done.text, /1 plan\s+done · architect · 2 files/, 'the same row says done and what it touched')
    const verify = eventMessage('verification.completed', 'tester', { note: 'PASS' })
    assert.match(verify.text, /3 verify\s+PASS · tester/, 'verification reports its verdict in the stage column')
    const failed = eventMessage('verification.completed', 'tester', { note: 'FAIL' })
    assert.equal(failed.tone, 'red', 'a failed verification keeps the alarm tone')
    const building = eventMessage('agent.started', 'coder')
    assert.match(building.text, /2 build\s+working · coder/, 'the coder is the build stage')
    const live = busyStatus(0, [{ role: 'architect', phase: 'working' }])
    assert.match(live, /1 plan · architect/, 'the activity line names the stage and the seat')
    assert.doesNotMatch(live, /casting|forging|tempering/, 'and not a texture verb')
    assert.match(busyStatus(0, []), /esc interrupts/, 'with no crew the busy verb still fills the line')
  }

  // (i) The cursor never blinks in the top-left corner.
  //
  // The frame is painted from the home position, so a cursor that stays
  // visible while it lands sits at (1,1) — a block in the corner of the
  // screen. Every repaint re-parks it, which restarts the terminal's own
  // blink timer nine times a second: the "blinking artifact in the top-left"
  // the operator reported on the home page (2026-11-04).
  {
    const { out, get } = fakeOut(120, 36)
    const s = new Screen(out, 120, 36)
    const st = initialState(wednesdayCompact(), 'gemma-3-4b-it')
    st.home = true
    s.enter()
    s.render(st)
    // A second render that changes one row: the incremental path, which is
    // the one the animated brand mark uses on the home page.
    st.toast = 'model switched'
    s.render(st)
    const seen = visibleCursorPositions(get())
    assert.ok(seen.length > 0, 'the cursor is shown again after the paint')
    for (const at of seen) {
      assert.ok(
        at.row > 1 || at.col > 1,
        `the cursor was visible in the top-left corner (${at.row},${at.col})`,
      )
    }
    // The caret belongs in the composer, not in the corner.
    const last = seen[seen.length - 1]!
    assert.ok(last.row > 1, 'the visible cursor sits on the composer row')
    s.exit()
  }

  // (j) ONE chat row, streaming the reasoning and the answer, honest at the end.
  //
  // The chat used to push a `✻ thinking` header and then a row per reasoning
  // line: a wall, and a header that still said "thinking" after the turn had
  // failed. The operator asked: "why is there thinking also at the bottom? are
  // both the same, or is the bottom one fake?" The answer must be: there is
  // ONE row, it streams, and it ends honestly.
  {
    const thinking = chatLiveRow('the user said hi, answer briefly', '', 'reasoning')
    assert.match(thinking.text, /^✻ thinking/, 'the row says it is thinking')
    assert.equal(thinking.tone, 'dim', 'a passing thought is dim')
    assert.ok(!thinking.text.includes('\n'), 'there is ONE row while it thinks')

    const answering = chatLiveRow('the user said hi', 'Hello! How can I help?', 'answering')
    assert.match(answering.text, /^✻ thought/, 'the row stops saying "thinking"')
    assert.match(answering.text, /Hello! How can I help\?/, 'the answer rides in the SAME row')
    assert.equal(answering.text.split('\n').length, 2, 'the row is one message, two lines')
    assert.equal(answering.tone, 'plain', 'the answer is readable, not dim')

    const stopped = chatLiveRow('thinking about it', '', 'reasoning', 'failed')
    assert.match(stopped.text, /^✻ stopped/, 'a stopped turn does not claim to be thinking')
    const cut = chatLiveRow('thinking', 'half an ans', 'answering', 'failed')
    assert.match(cut.text, /stopped — cut off here/, 'a half answer says it was cut off')
  }

  // (k) The activity line names the LIVE thing, not a decorative verb.
  {
    const chat = busyStatus(0, [], { role: 'chat', detail: 'thinking' })
    assert.match(chat, /^chat · thinking/, 'the chat turn names itself')
    assert.doesNotMatch(chat, /winding|forging|casting/, 'and not a texture verb')
    assert.match(chat, /esc interrupts/, 'the ways out are still advertised')
  }

  // (l) The STOP control: drawn on the frame, and clickable.
  {
    const { out, get } = fakeOut(100, 30)
    const s = new Screen(out, 100, 30)
    const st = initialState(wednesdayCompact(), 'gemma-3-4b-it')
    st.busy = true
    st.status = 'chat · thinking · esc interrupts · type to queue'
    s.enter()
    s.render(st)
    const frame = strip(s.frame(st))
    assert.ok(frame.includes('■ stop'), 'the stop button is on the frame while a turn is live')
    const row = frame.split('\n').findIndex(line => line.includes('■ stop'))
    assert.ok(row >= 0, 'the stop button is on a row of its own')
    const button = s.stopButton
    assert.ok(button, 'the frame measured a hit box for the button')
    assert.equal(button!.row, row + 1, 'the hit box is on the row the button was drawn on')
    // A click on the button is the SAME interrupt as Esc.
    let stopped = 0
    s.onStop = () => { stopped += 1 }
    const hit = s.clickAt(st, button!.row, button!.col)
    assert.equal(hit, true, 'clicking the stop button hits the button')
    assert.equal(stopped, 1, 'clicking the stop button interrupts the turn')
    // A click AWAY from the button does not.
    s.clickAt(st, button!.row, 1)
    assert.equal(stopped, 1, 'a click elsewhere does not stop the turn')
    s.exit()
    void get
  }

  // (m) The queue panel must not advertise keys or commands it does not have.
  {
    const { out } = fakeOut(100, 30)
    const s = new Screen(out, 100, 30)
    const st = initialState(wednesdayCompact(), 'gemma-3-4b-it')
    st.busy = true
    st.status = 'working… esc interrupts · type to queue'
    st.queued = ['build me a website']
    s.enter()
    s.render(st)
    const frame = strip(s.frame(st))
    assert.ok(frame.includes('Queue'), 'the queue panel is drawn')
    assert.ok(!frame.includes('/queue'), 'it does not advertise a command that does not exist')
    assert.ok(!frame.includes('Ctrl+R'), 'it does not advertise a key that does not exist')
    s.exit()
  }

  // (n) The palette ranks FUZZILY and by recency — qwen-code's rules.
  {
    const options: SelectOption[] = [
      { title: '/model', desc: 'every model', value: '/model' },
      { title: '/status', desc: 'route · model', value: '/status' },
      { title: '/stats', desc: 'token usage', value: '/stats' },
      { title: '/review', desc: 'review the diff', value: '/review' },
    ]
    // A SUBSEQUENCE finds the command: `mdl` is `/model`.
    const fuzzy = selectMatching(options, 'mdl', 20).filter(o => o.section === undefined)
    assert.equal(fuzzy[0]?.title, '/model', 'a fuzzy subsequence finds the command')
    // The exact match still wins over a fuzzy one.
    assert.equal(selectMatching(options, 'review', 20)[0]?.title, '/review', 'an exact match beats a guess')
    // Recency breaks a tie among equals, and NEVER promotes a non-match.
    const tie = selectMatching(options, 'st', 20, ['/stats']).filter(o => o.section === undefined)
    assert.equal(tie[0]?.title, '/stats', 'the command used last comes first among equals')
    const noMatch = selectMatching(options, 'zzz', 20, ['/stats']).filter(o => o.section === undefined)
    assert.equal(noMatch.length, 0, 'a recent command that does not match never surfaces')
  }

  // (o) The TRANSCRIPT SEARCH (Ctrl+F): the panel says how many hits there
  // are, the hits are marked on the page, and the way back is named.
  {
    const { out } = fakeOut(100, 24)
    const s = new Screen(out, 100, 24)
    const st = initialState('WEDNESDAY', 'live')
    s.enter()
    s.push(st, { text: 'the needle is in the transcript', tone: 'plain' })
    s.push(st, { text: 'a second line about nothing', tone: 'plain' })
    s.push(st, { text: 'and the needle appears again', tone: 'plain' })
    st.search = { query: 'needle', active: 0, total: 0 }
    s.render(st)
    const frame = strip(s.frame(st))
    assert.match(frame, /1\/2/, 'the panel counts the hits and says which one is active')
    assert.match(frame, /needle/, 'the query is on screen')
    assert.match(frame, /enter next/, 'the panel names the key that moves')
    // The hits are MARKED, not just counted: the raw frame carries the
    // reverse-video sequence on the active hit.
    const raw = s.frame(st)
    assert.ok(raw.includes('\x1b[7m'), 'the active hit is marked on the page')
    assert.ok(raw.includes('\x1b[48;2;'), 'the other hits are washed')
    // Moving to the next hit moves the counter — and the mark with it.
    st.search.active = 1
    s.render(st)
    assert.match(strip(s.frame(st)), /2\/2/, 'the counter follows the active hit')
    st.search = { query: 'zzz', active: 0, total: 0 }
    s.render(st)
    assert.match(strip(s.frame(st)), /no matches/, 'a query with no hits says so')
    s.exit()
  }

  // (p) The JUMP-TO-LATEST marker appears only when the page is scrolled.
  {
    const { out } = fakeOut(100, 24)
    const s = new Screen(out, 100, 24)
    const st = initialState('WEDNESDAY', 'live')
    s.enter()
    for (let i = 0; i < 40; i++) s.push(st, { text: `line ${i}`, tone: 'plain' })
    s.render(st)
    assert.ok(!strip(s.frame(st)).includes('▼ latest'), 'the marker is absent at the tail')
    st.scroll = 10
    s.render(st)
    assert.match(strip(s.frame(st)), /▼ latest/, 'the marker appears once the page is scrolled')
    s.exit()
  }

  console.log('SCREEN TEST: PASS (event mapping, layout, dialog, clipping, no-splash startup, help, plate, multiline, advisories, depth, display-column width, brand cube + cell selection + mid-run slash, /new confirm + pager copy, HUD command pages, run detail, run stages, cursor parking, B92 prose integrity, one chat row, truthful activity line, stop control, truthful queue hint, fuzzy + recency ranking, transcript search, jump-to-latest)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

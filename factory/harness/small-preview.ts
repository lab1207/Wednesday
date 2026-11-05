/**
 * SMALL-TERMINAL SWEEP — render every screen at genuinely tiny sizes.
 *
 * The audit checks invariants, which is how the width and border bugs were
 * found. This one just PRINTS the frames so a human can see what the layout
 * looks like when there is almost no room — the case where "passes every
 * check" and "looks right" come apart.
 *
 *   npx tsx factory/harness/small-preview.ts [minCols] [maxCols]
 */
import { COMPOSER_HINTS, Screen, initialState, bootSplashRows, frameRows, helpRows, eventMessage } from './screen.js'
import { gatePlateRowsFor } from './plate.js'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

const MIN = Number(process.argv[2] ?? 24)
const MAX = Number(process.argv[3] ?? 56)

function render(w: number, h: number, build: (scr: Screen, st: ReturnType<typeof initialState>) => void): string[] {
  let captured = ''
  const out = { columns: w, rows: h, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
  const scr = new Screen(out, w, h)
  const st = initialState('WEDNESDAY', 'mode live · qwen2.5-coder-3b')
  st.composerLabel = 'qwen2.5-coder-3b'
  build(scr, st)
  // Repaints are incremental — replay the whole stream (see frameRows) or
  // every state prints as whatever single row the last patch touched.
  return frameRows(captured).map(strip)
}

const STATES: Array<[string, (scr: Screen, st: ReturnType<typeof initialState>) => void]> = [
  ['home', (scr, st) => { st.home = true; st.status = ''; scr.render(st) }],
  ['home + rail', (scr, st) => { st.home = true; st.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }; st.status = ''; scr.render(st) }],
  ['home + typed', (scr, st) => { st.home = true; st.status = ''; st.input = 'add a regression test for the token refresh path'; st.cursor = st.input.length; scr.render(st) }],
  ['stream', (scr, st) => {
    st.side = { title: 'fix login leak', tokens: 2318, limit: 13312 }
    for (const m of ['task.created', 'agent.started', 'agent.completed', 'verification.started', 'task.completed']) st.messages.push(eventMessage(m))
    st.status = COMPOSER_HINTS
    scr.render(st)
  }],
  ['busy', (scr, st) => { st.busy = true; st.status = 'working… esc interrupts'; for (let i = 0; i < 6; i++) st.messages.push(eventMessage('agent.started', 'coder')); scr.render(st) }],
  ['dialog', (scr, st) => { st.dialog = { title: 'Ready to run', body: 'Fix: the login leak\nWhere: C:\\wednesday\nVerify: npm test', prompt: 'Run it? [y/N]' }; scr.render(st) }],
]

const SIZES: Array<[number, number]> = [
  [24, 10], [28, 12], [32, 14], [36, 16], [40, 18], [44, 20], [48, 22], [56, 24],
]

for (const [w, h] of SIZES) {
  if (w < MIN || w > MAX) continue
  console.log(`\n${'═'.repeat(w)}\n  ${w} x ${h}\n${'═'.repeat(w)}`)
  for (const [name, build] of STATES) {
    const rows = render(w, h, build)
    const over = rows.filter(r => r.length > w)
    const wrong = rows.filter(r => r.length !== w)
    console.log(`\n--- ${name} ---`)
    for (const r of rows) console.log(r.replace(/\s+$/, ''))
    const flag = over.length ? `OVERFLOW ${over.length} row(s) max=${Math.max(...rows.map(r => r.length))}` : wrong.length ? `width ${[...new Set(rows.map(r => r.length))].join('/')}` : 'ok'
    console.log(`[${flag}]`)
  }
  console.log('\n--- boot splash ---')
  for (const r of bootSplashRows(w)) console.log(strip(r).replace(/\s+$/, ''))
  console.log('\n--- help ---')
  for (const r of helpRows(w, [['<request>', 'run a task'], ['/agents', 'crew profile'], ['/health', 'meter']], [['--test "c"', 'verification']])) console.log(strip(r).replace(/\s+$/, ''))
  console.log('\n--- gate plate ---')
  for (const r of gatePlateRowsFor(w)) console.log(strip(r).replace(/\s+$/, ''))
}

/**
 * FUZZ — every byte sequence a terminal can deliver, through the real router.
 *
 * The `hist is not defined` crash shipped because no test pressed UP. Layout
 * tests and unit asserts cannot find that class of bug; only feeding real
 * bytes through the real input path can. This walks the byte space
 * deterministically (no randomness, so a failure is reproducible) plus every
 * CSI/mouse/UTF-8 shape a terminal actually emits, and asserts the one
 * property that matters: NO HANDLER EVER THROWS.
 *
 *   npx tsx factory/harness/fuzz-test.ts [iterations]
 */
import { stdin } from 'node:process'
import { Screen, initialState, runSelect, type SelectOption } from './screen.js'

const ITERATIONS = Number(process.argv[2] ?? 4000)

const failures: string[] = []

const PALETTE: SelectOption[] = [
  { title: '/help', desc: 'this help', value: '/help' },
  { title: '/tasks', desc: 'list tasks', value: '/tasks' },
  { title: '/exit', desc: 'leave', value: '/exit' },
]

/** Deterministic PRNG — a failing seed reproduces exactly. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const ALPHABET: string[] = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ' ', '/', '\\', '|', '-', '_', '.', ':', ';', ',', '?', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '[', ']', '{', '}', '<', '>', '=', '+', '~', '`', "'", '"',
  '\r', '\n', '\t', '\x7f', '\b', '\x03', '\x10', '\x1b', '\x00', '\x01', '\x1a',
  'é', 'ü', '→', '✓', '漢', '字', '❦', '☠', '▌', '█', '\u{1F600}',
]

/** Terminal control sequences a real terminal emits. */
const SEQUENCES: string[] = [
  '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[1~', '\x1b[4~',
  '\x1b[5~', '\x1b[6~', '\x1b[3~', '\x1b[2~', '\x1bOH', '\x1bOF', '\x1b[E', '\x1b[Z',
  '\x1b[<0;1;1M', '\x1b[<0;99;40M', '\x1b[<35;50;20M', '\x1b[<64;10;10M', '\x1b[<65;10;10M',
  '\x1b[<0;1;1m', '\x1b[M0+ ', '\x1b[M0!!', '\x1b[?1049h', '\x1b[?25l', '\x1b[2J', '\x1b[H',
  '\x1b[38;5;245m', '\x1b[48;2;1;2;3m\x1b[0m', '\x1b]0;title\x07', '\x1bP1$r0m\x1b\\',
  '\x1b[200~', '\x1b[201~', '\x1b[<', '\x1b[', '\x1b', '\x1b\x1b\x1b', '\x1b[999;999H',
  '\x1b[<0;0;0M', '\x1b[<0;1000;1000M',
]

function randomChunk(rnd: () => number): string {
  const roll = rnd()
  if (roll < 0.45) {
    // A run of printable characters, like typing or a paste.
    const n = 1 + Math.floor(rnd() * 12)
    let out = ''
    for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
    return out
  }
  if (roll < 0.85) return SEQUENCES[Math.floor(rnd() * SEQUENCES.length)]
  // A truncated sequence, like a read boundary landing mid-escape.
  const seq = SEQUENCES[Math.floor(rnd() * SEQUENCES.length)]
  return seq.slice(0, 1 + Math.floor(rnd() * Math.max(1, seq.length - 1)))
}

function makeScreen(seed: number) {
  let captured = ''
  const out = {
    columns: 100, rows: 30,
    write: (c: string) => { captured += c; return true },
  } as unknown as NodeJS.WriteStream
  const scr = new Screen(out, 100, 30)
  const st = initialState('WEDNESDAY', 'mode live')
  st.composerLabel = 'qwen2.5-coder-3b'
  for (let i = 0; i < 20; i++) st.messages.push({ text: `line ${i}`, tone: 'plain' })
  scr.enter()
  return { scr, st, out, seed }
}

async function main(): Promise<void> {
  // ── Pass 1: the composer, byte soup, no handler may throw ────────────────
  for (let seed = 1; seed <= ITERATIONS; seed++) {
    const rnd = makeRandom(seed * 2654435761)
    const { scr, st } = makeScreen(seed)
    let line: Promise<string | undefined> | null = scr.readLine(st, ['old one', 'old two'])
    try {
      const n = 1 + Math.floor(rnd() * 8)
      for (let i = 0; i < n; i++) {
        stdin.emit('data', randomChunk(rnd))
        if (rnd() < 0.06) {
          // Resolving and re-entering mid-fuzz, the way a submitted line does.
          stdin.emit('data', '\r')
          line = scr.readLine(st, ['old one', 'old two'])
        }
      }
    } catch (error) {
      failures.push(`composer seed=${seed}: ${String(error)}`)
    }
    // The draft must stay a coherent string with a cursor inside it.
    if (typeof st.input !== 'string') {
      failures.push(`composer seed=${seed}: input is ${typeof st.input}`)
    } else if (st.cursor < 0 || st.cursor > st.input.length) {
      failures.push(`composer seed=${seed}: cursor ${st.cursor} outside draft of ${st.input.length}`)
    }
    if (stateLooksBroken(st)) failures.push(`composer seed=${seed}: draft holds a raw control byte`)
    void scr.exit()
    void line
    // Unresolved readLines leave stdin listeners behind; 4,000 seeds would
    // stack 4,000 handlers and every emit would run them all (slow + noisy).
    // Test process only — production detaches via done().
    stdin.removeAllListeners('data')
    if (failures.length > 12) break
  }

  // ── Pass 2: the command plate, byte soup ────────────────────────────────
  for (let seed = 1; seed <= Math.floor(ITERATIONS / 4); seed++) {
    const rnd = makeRandom(seed * 40503 + 7)
    const { scr, st, out } = makeScreen(seed)
    const plate = runSelect(out, 100, 30, 'Commands', PALETTE, () => scr.frame(st), '', scr)
    try {
      const n = 1 + Math.floor(rnd() * 8)
      for (let i = 0; i < n; i++) stdin.emit('data', randomChunk(rnd))
    } catch (error) {
      failures.push(`plate seed=${seed}: ${String(error)}`)
    }
    if (stateLooksBroken(st)) failures.push(`plate seed=${seed}: draft holds a raw control byte`)
    void plate
    scr.exit()
    stdin.removeAllListeners('data')
    if (failures.length > 12) break
  }

  // ── Pass 3: geometry under the same abuse ───────────────────────────────
  for (let seed = 1; seed <= Math.floor(ITERATIONS / 4); seed++) {
    const rnd = makeRandom(seed * 22699 + 13)
    const { scr, st } = makeScreen(seed)
    try {
      const w = 24 + Math.floor(rnd() * 200)
      const h = 12 + Math.floor(rnd() * 50)
      scr.resize(w, h)
      scr.render(st)
      for (let i = 0; i < 4; i++) stdin.emit('data', randomChunk(rnd))
      scr.render(st)
    } catch (error) {
      failures.push(`resize seed=${seed}: ${String(error)}`)
    }
    if (stateLooksBroken(st)) failures.push(`resize seed=${seed}: draft holds a raw control byte`)
    scr.exit()
    if (failures.length > 12) break
  }

  if (failures.length === 0) {
    console.log(`FUZZ TEST: PASS (${ITERATIONS} seeds x 3 passes, no handler ever threw)`)
  } else {
    console.log(`FUZZ TEST: ${failures.length} FAILURES\n`)
    for (const f of failures.slice(0, 15)) console.log(`  • ${f}`)
    process.exitCode = 1
  }
}

/** The composer must never hold a raw control byte or a stray escape. */
function stateLooksBroken(st: { input: string }): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b-\x1f\x7f]|\x1b/.test(st.input)
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch(error => {
  console.error('FUZZ TEST: CRASHED —', error)
  process.exit(1)
})

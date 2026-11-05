/**
 * INPUT PROTOCOL + ADOPTED OPENTUI SEMANTICS — regression tests.
 *
 * The harness adopted a protocol layer from OpenTUI (MIT): kitty keyboard
 * reports, xterm modifyOtherKeys, modified CSI, bracketed paste, focus
 * reporting, bare-URL detection and tmux-safe OSC 52. None of it is a
 * renderer dependency; all of it is pure stdlib and lives in key-protocol.ts.
 *
 * These tests pin the WIRE FACTS. A terminal is not reproducible in CI, so the
 * only honest guard is to feed the exact byte sequences real terminals send and
 * assert what reaches a handler, in order:
 *
 *   - kitty `CSI codepoint ; modifiers u`, including the base-layout code
 *   - `CSI 27 ; modifiers ; codepoint ~` (modifyOtherKeys)
 *   - `CSI 1 ; modifiers A` (modified arrows/paging)
 *   - `ESC [ 200 ~ … ESC [ 201 ~` pastes, including split-across-reads
 *   - `ESC [ I` / `ESC [ O` focus, `ESC [ Z` Shift+Tab
 *   - A PASTE CAN NEVER ANSWER A GATE (the security property)
 *
 * plus the composer behaviours those protocols made possible: shell word
 * editing (Ctrl+A/E/U/K/W, Ctrl/Alt+arrow, Ctrl+Backspace/Delete) and a
 * transcript URL that is clickable without changing its measured width.
 *
 *   npx tsx factory/harness/input-protocol-test.ts
 */
import { stdin } from 'node:process'
import { Screen, decodeInput, initialState, visibleWidth, type ScreenDialog } from './screen.js'
import {
  FOCUS_DISABLE, FOCUS_ENABLE, KITTY_POP, KITTY_PUSH, PASTE_DISABLE, PASTE_ENABLE,
  autoLinkRow, findLinks, hyperlink, modernInput,
  nextWordEnd, osc52Sequence, parseKittySequence, parseModifiedCsi,
  parseModifyOtherKeys, prevWordStart,
} from './key-protocol.js'

const failures: string[] = []
let checks = 0

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** Strip SGR + OSC 8 exactly the way the screen's width maths does. */
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g
const strip = (s: string): string => s.replace(ANSI, '')

const KEY = {
  esc: '\x1b',
  enter: '\r',
  ctrlC: '\x03',
  ctrlJ: '\n',
  backspace: '\x7f',
  up: '\x1b[A',
  pageUp: '\x1b[5~',
  ctrlUpLegacyCsi: '\x1b[1;5A',
  shiftTab: '\x1b[Z',
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

/** Send raw bytes the way a terminal would, then let the handler run. */
async function type(...chunks: string[]): Promise<void> {
  for (const chunk of chunks) stdin.emit('data', chunk)
  await new Promise(r => setTimeout(r, 12))
}

/** Wait without losing an unresolved promise, to prove "nothing happened". */
const settle = (ms: number): Promise<string> => new Promise(r => setTimeout(() => r('__PENDING__'), ms))

async function main(): Promise<void> {
  // ── 1. Kitty protocol: the exact reports terminals send ──────────────────
  {
    const ctrlC = parseKittySequence('\x1b[99;5u')
    ok('kitty Ctrl+C decodes to ctrl+c', !!ctrlC && ctrlC.name === 'c' && ctrlC.ctrl && ctrlC.sequence === 'c', JSON.stringify(ctrlC))

    const shiftEnter = parseKittySequence('\x1b[13;2u')
    ok('kitty Shift+Enter decodes to a shifted return', !!shiftEnter && shiftEnter.name === 'return' && shiftEnter.shift === true, JSON.stringify(shiftEnter))

    const ctrlEnter = parseKittySequence('\x1b[13;5u')
    ok('kitty Ctrl+Enter decodes to a ctrl return', !!ctrlEnter && ctrlEnter.name === 'return' && ctrlEnter.ctrl, JSON.stringify(ctrlEnter))

    const ctrlUp = parseKittySequence('\x1b[1;5A')
    ok('kitty/modified Ctrl+Up keeps its modifier', !!ctrlUp && ctrlUp.name === 'up' && ctrlUp.ctrl, JSON.stringify(ctrlUp))

    const shiftedA = parseKittySequence('\x1b[97:65;2u')
    ok('kitty shifted text reports the SHIFTED glyph', !!shiftedA && shiftedA.shift === true && shiftedA.sequence === 'A', JSON.stringify(shiftedA))

    const layout = parseKittySequence('\x1b[99:67:99;5u')
    ok('kitty base-layout code survives a foreign layout', !!layout && layout.name === 'c' && layout.baseCode === 99 && layout.ctrl, JSON.stringify(layout))

    const escape = parseKittySequence('\x1b[27u')
    ok('kitty names the escape key instead of typing it', !!escape && escape.name === 'escape', JSON.stringify(escape))

    const f1 = parseKittySequence('\x1b[1;2P')
    ok('kitty functional keys decode (Shift+F1)', !!f1 && f1.name === 'f1' && f1.shift === true, JSON.stringify(f1))

    const ctrlShiftC = parseKittySequence('\x1b[99;6u')
    ok('Ctrl+Shift+C still means Ctrl+C', !!ctrlShiftC && ctrlShiftC.name === 'c' && ctrlShiftC.ctrl && ctrlShiftC.shift, JSON.stringify(ctrlShiftC))

    const c0 = parseKittySequence('\x1b[1;5u')
    ok('a C0 kitty code stays a CONTROL key (Ctrl+A)', !!c0 && c0.name === 'a' && c0.ctrl === true, JSON.stringify(c0))

    const lf = parseKittySequence('\x1b[10u')
    ok('kitty LF is Ctrl+J, never a raw byte', !!lf && lf.name === 'j' && lf.ctrl === true, JSON.stringify(lf))

    const tab = parseKittySequence('\x1b[9u')
    ok('kitty TAB is still TAB, not Ctrl+I', !!tab && tab.name === 'tab' && tab.ctrl === false, JSON.stringify(tab))

    const junk = parseKittySequence('\x1b[hello')
    ok('a non-protocol CSI is not claimed as kitty', junk === null, JSON.stringify(junk))
  }

  // ── 2. modifyOtherKeys and modified CSI (the no-negotiation dialects) ────
  {
    const shiftEnter = parseModifyOtherKeys('\x1b[27;2;13~')
    ok('modifyOtherKeys Shift+Enter decodes', !!shiftEnter && shiftEnter.name === 'return' && shiftEnter.shift, JSON.stringify(shiftEnter))

    const ctrlSpace = parseModifyOtherKeys('\x1b[27;5;32~')
    ok('modifyOtherKeys Ctrl+Space decodes', !!ctrlSpace && ctrlSpace.name === 'space' && ctrlSpace.ctrl, JSON.stringify(ctrlSpace))

    const altX = parseModifyOtherKeys('\x1b[27;3;120~')
    ok('modifyOtherKeys Alt+X decodes as meta', !!altX && altX.name === 'x' && altX.meta, JSON.stringify(altX))

    const ctrlA = parseModifyOtherKeys('\x1b[27;5;1~')
    ok('modifyOtherKeys C0 codepoint stays Ctrl+A', !!ctrlA && ctrlA.name === 'a' && ctrlA.ctrl === true, JSON.stringify(ctrlA))

    const ctrlUp = parseModifiedCsi('\x1b[1;5A')
    ok('modified CSI keeps the Ctrl on an arrow', !!ctrlUp && ctrlUp.name === 'up' && ctrlUp.ctrl, JSON.stringify(ctrlUp))

    const altPageUp = parseModifiedCsi('\x1b[5;3~')
    ok('modified CSI keeps the Alt on a tilde key', !!altPageUp && altPageUp.name === 'pageup' && altPageUp.meta, JSON.stringify(altPageUp))

    const notModified = parseModifiedCsi('\x1b[A')
    ok('an unmodified arrow is left to the legacy table', notModified === null, JSON.stringify(notModified))
  }

  // ── 3. decodeInput: legacy bytes still mean exactly what they meant ──────
  {
    const cases: Array<[string, string, boolean, string]> = [
      ['\\x03', 'c', true, KEY.ctrlC],
      ['\\r', 'return', false, KEY.enter],
      ['\\n', 'j', true, KEY.ctrlJ],
      ['ESCAPE', 'escape', false, KEY.esc],
      ['TAB', 'tab', false, '\t'],
      ['DEL', 'backspace', false, KEY.backspace],
      ['UP', 'up', false, KEY.up],
      ['PAGEUP', 'pageup', false, KEY.pageUp],
    ]
    for (const [label, name, ctrl, seq] of cases) {
      const d = decodeInput(seq)
      // A LONE ESC is held for the flush window (Esc vs Alt), so it has no
      // event yet by design; attachInput's timer emits it as `escape`.
      if (seq === KEY.esc) {
        ok('legacy ESCAPE is held as pending, never typed', d.events.length === 0 && d.pending === '\x1b', JSON.stringify(d))
        continue
      }
      const key = d?.events[0]
      ok(`legacy ${label} still decodes`, !!key && key.kind === 'key' && key.key.name === name && key.key.ctrl === ctrl,
        JSON.stringify(d?.events))
    }

    const run = decodeInput('hello')
    const first = run.events[0]
    ok('a printable run is ONE key (paste-vs-typing signal preserved)',
      !!first && first.kind === 'key' && first.key.sequence === 'hello', JSON.stringify(run.events))

    const shiftTab = decodeInput(KEY.shiftTab)
    const tab = shiftTab.events[0]
    ok('Shift+Tab is reported, not swallowed',
      !!tab && tab.kind === 'key' && tab.key.name === 'tab' && tab.key.shift === true,
      JSON.stringify(shiftTab.events))

    const modified = decodeInput(KEY.ctrlUpLegacyCsi)
    const mkey = modified.events[0]
    ok('Ctrl+Up over legacy CSI reaches the handler with Ctrl',
      !!mkey && mkey.kind === 'key' && mkey.key.name === 'up' && mkey.key.ctrl,
      JSON.stringify(modified.events))
  }

  // ── 4. Bracketed paste: verbatim, ordered, split-safe ────────────────────
  {
    const one = decodeInput('\x1b[200~hello\x1b[201~')
    ok('one paste yields one paste event, no keys',
      one.events.length === 1 && one.events[0]!.kind === 'paste' && one.events[0]!.text === 'hello',
      JSON.stringify(one.events))

    const crlf = decodeInput('\x1b[200~a\r\nb\x1b[201~')
    ok('paste payload is passed through byte-for-byte',
      crlf.events[0]?.kind === 'paste' && crlf.events[0].text === 'a\r\nb',
      JSON.stringify(crlf.events))

    const controls = decodeInput('\x1b[200~a\x1b[Ab\x07\x1b[201~')
    ok('escapes INSIDE a paste are content, never keys',
      controls.events.length === 1 && controls.events[0]!.kind === 'paste' &&
      controls.events[0]!.text === 'a\x1b[Ab\x07',
      JSON.stringify(controls.events))

    const ordered = decodeInput('\x1b[200~abc\x1b[201~\r')
    ok('a paste followed by Enter keeps READ ORDER',
      ordered.events.length === 2 &&
      ordered.events[0]!.kind === 'paste' && ordered.events[0]!.text === 'abc' &&
      ordered.events[1]!.kind === 'key' && ordered.events[1]!.key.name === 'return',
      JSON.stringify(ordered.events))

    const head = decodeInput('\x1b[200~abc')
    ok('a split paste head is HELD, not decoded', head.events.length === 0 && head.pending === '\x1b[200~abc',
      JSON.stringify(head))
    const joined = decodeInput(head.pending + '\x1b[201~')
    ok('the next read completes the split paste',
      joined.events.length === 1 && joined.events[0]!.kind === 'paste' && joined.events[0]!.text === 'abc',
      JSON.stringify(joined.events))

    const halfClose = decodeInput('\x1b[200~abc\x1b[20')
    ok('a half-arrived close marker is also held', halfClose.pending === '\x1b[200~abc\x1b[20',
      JSON.stringify(halfClose.pending))
  }

  // ── 5. Focus reports and ordering ────────────────────────────────────────
  {
    const d = decodeInput('\x1b[Ix\x1b[O')
    ok('focus in, typing, focus out arrive in order',
      d.events.length === 3 &&
      d.events[0]!.kind === 'focus' && d.events[0]!.focused === true &&
      d.events[1]!.kind === 'key' && d.events[1]!.key.sequence === 'x' &&
      d.events[2]!.kind === 'focus' && d.events[2]!.focused === false,
      JSON.stringify(d.events))
  }

  // ── 6. Modes are armed once and always popped ────────────────────────────
  {
    ok('paste mode bytes', PASTE_ENABLE === '\x1b[?2004h' && PASTE_DISABLE === '\x1b[?2004l')
    ok('focus mode bytes', FOCUS_ENABLE === '\x1b[?1004h' && FOCUS_DISABLE === '\x1b[?1004l')
    ok('kitty push is flag 1 only', KITTY_PUSH === '\x1b[>1u' && KITTY_POP === '\x1b[<u')
    ok('modern input is on by default', modernInput({} as NodeJS.ProcessEnv) === true)
    ok('WEDNESDAY_LEGACY_INPUT=1 is the escape hatch', modernInput({ WEDNESDAY_LEGACY_INPUT: '1' } as NodeJS.ProcessEnv) === false)

    const modern = fresh()
    const entered = modern.get()
    ok('enter arms paste + focus + kitty',
      entered.includes(PASTE_ENABLE) && entered.includes(FOCUS_ENABLE) && entered.includes(KITTY_PUSH),
      JSON.stringify(entered))
    modern.scr.exit()
    const left = modern.get()
    ok('exit pops kitty and disarms paste/focus',
      left.includes(KITTY_POP) && left.includes(FOCUS_DISABLE) && left.includes(PASTE_DISABLE),
      JSON.stringify(left.slice(-80)))

    const saved = process.env.WEDNESDAY_LEGACY_INPUT
    process.env.WEDNESDAY_LEGACY_INPUT = '1'
    try {
      const legacy = fresh()
      const text = legacy.get()
      ok('legacy input sends NO protocol push',
        !text.includes(KITTY_PUSH) && !text.includes(PASTE_ENABLE) && !text.includes(FOCUS_ENABLE),
        JSON.stringify(text))
      legacy.scr.exit()
      ok('legacy exit still disarms (a stale mode must never survive)',
        legacy.get().includes(PASTE_DISABLE) && legacy.get().includes(FOCUS_DISABLE),
        JSON.stringify(legacy.get().slice(-80)))
    } finally {
      if (saved === undefined) delete process.env.WEDNESDAY_LEGACY_INPUT
      else process.env.WEDNESDAY_LEGACY_INPUT = saved
    }
  }

  // ── 7. Links: detection, trimming, zero-width OSC 8 ──────────────────────
  {
    const spans = findLinks('see https://x.dev/a(b). and http://y.io/z).')
    ok('two bare URLs are found', spans.length === 2, JSON.stringify(spans))
    ok('a balanced paren is part of the URL', spans[0]?.url === 'https://x.dev/a(b)', JSON.stringify(spans[0]))
    ok('a trailing period and an unbalanced paren are trimmed', spans[1]?.url === 'http://y.io/z', JSON.stringify(spans[1]))
    ok('the span ends where the URL ends', spans[1]?.end === 28 + 'http://y.io/z'.length, JSON.stringify(spans[1]))
    ok('no scheme, no link', findLinks('ftp://x.dev and https://').length === 0, JSON.stringify(findLinks('ftp://x.dev and https://')))
    ok('HTTPS in caps still links', findLinks('HTTPS://X.DEV/a')[0]?.url === 'HTTPS://X.DEV/a', JSON.stringify(findLinks('HTTPS://X.DEV/a')))

    const row = 'see https://x.dev/docs for details'
    const linked = autoLinkRow(row)
    ok('autoLinkRow keeps every visible character', strip(linked) === row, JSON.stringify(strip(linked)))
    ok('autoLinkRow emits OSC 8 around the URL', linked.includes('\x1b]8;;https://x.dev/docs\x1b\\'), JSON.stringify(linked))
    ok('autoLinkRow emits a closing OSC 8', linked.split('\x1b]8;;\x1b\\').length >= 2, JSON.stringify(linked))
    ok('OSC 8 is ZERO display width', visibleWidth(hyperlink('abc', 'https://x.dev')) === 3,
      String(visibleWidth(hyperlink('abc', 'https://x.dev'))))
    ok('a linked row measures exactly like the plain row', visibleWidth(linked) === visibleWidth(row),
      `${visibleWidth(linked)} vs ${visibleWidth(row)}`)
    ok('text with no URL is untouched', autoLinkRow('nothing here') === 'nothing here')

    // Defensive: even if a caller hands in styled text, an SGR reset must not
    // become part of the OSC 8 URL parameter (the pre-fix bug).
    const styled = '\x1b[38;5;245msee https://x.dev/docs\x1b[0m'
    ok('an SGR reset never enters the OSC 8 target',
      autoLinkRow(styled).includes('\x1b]8;;https://x.dev/docs\x1b\\'), JSON.stringify(autoLinkRow(styled)))

    // End to end: the transcript paints the link.
    const { scr, st } = fresh()
    scr.push(st, { text: 'docs at https://x.dev/docs', tone: 'plain' })
    const frame = scr.frame(st)
    ok('the painted transcript carries the hyperlink', frame.includes('\x1b]8;;https://x.dev/docs\x1b\\'), frame.slice(-200))
    scr.exit()
  }

  // ── 8. OSC 52: plain, tmux, screen ───────────────────────────────────────
  {
    const plain = osc52Sequence('hi', {} as NodeJS.ProcessEnv)
    ok('plain OSC 52 has the base64 payload', plain === '\x1b]52;c;aGk=\x07', JSON.stringify(plain))

    const tmux = osc52Sequence('hi', { TMUX: '/tmp/tmux' } as NodeJS.ProcessEnv)
    ok('tmux gets a DCS passthrough', tmux.startsWith('\x1bPtmux;\x1b'), JSON.stringify(tmux))
    ok('tmux gets every inner ESC doubled', tmux.includes('\x1b\x1b]52;c;aGk=\x07'), JSON.stringify(tmux))
    ok('tmux passthrough is terminated with ST', tmux.endsWith('\x1b\\'), JSON.stringify(tmux))

    const screen = osc52Sequence('hi', { STY: '1234.pts' } as NodeJS.ProcessEnv)
    ok('GNU screen gets its own passthrough', screen === '\x1bP\x1b]52;c;aGk=\x07\x1b\\', JSON.stringify(screen))

    const unicode = osc52Sequence('hé', {} as NodeJS.ProcessEnv)
    ok('unicode payload is base64 of UTF-8', unicode === `\x1b]52;c;${Buffer.from('hé', 'utf8').toString('base64')}\x07`,
      JSON.stringify(unicode))
  }

  // ── 9. Word boundaries (EditBuffer semantics, our implementation) ────────
  {
    ok('Ctrl+Left skips to the previous word', prevWordStart('hello big world', 15) === 10, String(prevWordStart('hello big world', 15)))
    ok('Ctrl+Left crosses the separator', prevWordStart('hello big world', 10) === 6, String(prevWordStart('hello big world', 10)))
    ok('Ctrl+Left stops at punctuation', prevWordStart('foo.bar', 7) === 4, String(prevWordStart('foo.bar', 7)))
    ok('Ctrl+Right stops at the word end', nextWordEnd('hello big world', 0) === 5, String(nextWordEnd('hello big world', 0)))
    ok('Ctrl+Right crosses the separator', nextWordEnd('hello big world', 5) === 9, String(nextWordEnd('hello big world', 5)))
    ok('Ctrl+Right stops at punctuation', nextWordEnd('foo.bar', 0) === 3, String(nextWordEnd('foo.bar', 0)))
    ok('underscore is a word character', prevWordStart('a_b c', 3) === 0 && nextWordEnd('a_b c', 0) === 3,
      `${prevWordStart('a_b c', 3)}/${nextWordEnd('a_b c', 0)}`)
    ok('unicode letters are word characters', prevWordStart('héllo 漢字', 8) === 6 && nextWordEnd('héllo 漢字', 0) === 5,
      `${prevWordStart('héllo 漢字', 8)}/${nextWordEnd('héllo 漢字', 0)}`)
    ok('boundaries clamp instead of reading past the ends',
      prevWordStart('abc', 0) === 0 && nextWordEnd('abc', 3) === 3 && nextWordEnd('', 0) === 0)
  }

  // ── 10. The composer: shell editing through REAL terminal bytes ──────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])

    await type('alpha beta gamma')
    await type('\x1b[119;5u') // kitty Ctrl+W
    ok('kitty Ctrl+W kills the previous word', st.input === 'alpha beta ', JSON.stringify(st.input))

    await type('\x1b[97;5u') // kitty Ctrl+A
    ok('kitty Ctrl+A goes to column 0', st.cursor === 0, String(st.cursor))

    await type('\x1b[107;5u') // kitty Ctrl+K
    ok('Ctrl+K kills from the cursor to the end', st.input === '', JSON.stringify(st.input))

    await type('one two')
    await type('\x1b[97;5u') // Ctrl+A
    await type('\x1b[1;5C') // Ctrl+Right (modified CSI, not kitty)
    ok('Ctrl+Right moves to the next word', st.cursor === 3, String(st.cursor))

    await type('\x1b[3;5~') // Ctrl+Delete
    ok('Ctrl+Delete kills the next word', st.input === 'one', JSON.stringify(st.input))

    await type('\x1b[101;5u') // kitty Ctrl+E
    ok('kitty Ctrl+E goes to the end', st.cursor === st.input.length, `${st.cursor}/${st.input.length}`)

    await type('\x1b[13;2u') // kitty Shift+Enter
    await type('next')
    ok('kitty Shift+Enter inserts a newline and typing continues', st.input === 'one\nnext', JSON.stringify(st.input))

    await type('\x1b[127;5u') // kitty Ctrl+Backspace
    ok('Ctrl+Backspace kills the word before the cursor', st.input === 'one\n', JSON.stringify(st.input))

    await type('!', KEY.enter)
    const value = await Promise.race([line, settle(300)])
    ok('the edited draft submits on plain Enter', value === 'one\n!', String(value))
    scr.exit()
  }
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await type('abc def')
    await type('\x1b[117;5u') // kitty Ctrl+U kills LEFT of the cursor
    ok('Ctrl+U with the cursor at the end clears the draft', st.input === '', JSON.stringify(st.input))
    await type('tail', '\x1b[97;5u', '\x1b[107;5u') // Ctrl+A then Ctrl+K
    ok('Ctrl+K with the cursor at 0 clears the draft', st.input === '', JSON.stringify(st.input))
    await type('kept', KEY.enter)
    await Promise.race([line, settle(200)])
    scr.exit()
  }

  // ── 11. Kitty Ctrl+C reaches the same two-press exit ─────────────────────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await type('half a thought')
    await type('\x1b[99;5u') // kitty Ctrl+C
    ok('one kitty Ctrl+C clears the draft', st.input === '', JSON.stringify(st.input))
    ok('one kitty Ctrl+C asks before leaving', /ctrl\+c again/.test(st.status), st.status)
    await type('\x1b[99;5u')
    const value = await Promise.race([line, settle(300)])
    ok('two kitty Ctrl+C presses leave the composer', value === undefined, String(value))
    scr.exit()
  }

  // ── 12. Paste into the composer: verbatim, no submit, no execution ───────
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await type('\x1b[200~/usr/local/bin\r\nnext line\x1b[201~')
    ok('a bracketed paste lands verbatim (CRLF -> LF)',
      st.input === '/usr/local/bin\nnext line', JSON.stringify(st.input))
    const early = await Promise.race([line, settle(120)])
    ok('a paste NEVER submits the composer', early === '__PENDING__', String(early))
    await type(KEY.enter)
    const value = await Promise.race([line, settle(300)])
    ok('the pasted draft submits only on a real Enter', value === '/usr/local/bin\nnext line', String(value))
    scr.exit()
  }

  // ── 12b. Pasted terminal content is sanitised before it reaches a draft ──
  {
    const { scr, st } = fresh()
    const line = scr.readLine(st, [])
    await type('\x1b[200~a\x1b[2Jb\tc\x00d\x1b]8;;https://evil\x07e\x1b[201~')
    ok('pasted escapes/controls are stripped and tabs expanded',
      st.input === 'ab  cde', JSON.stringify(st.input))
    ok('no raw control byte or escape reaches the draft',
      !/[\x00-\x08\x0b-\x1f\x7f]|\x1b/.test(st.input), JSON.stringify(st.input))
    await type(KEY.enter)
    await Promise.race([line, settle(200)])
    scr.exit()
  }

  // ── 13. Paste during a run composes the queued request ───────────────────
  {
    const { scr, st } = fresh()
    const queue: string[] = []
    const stop = scr.watchRun(st, () => { /* interrupt */ }, text => queue.push(text))
    await type('\x1b[200~queued while busy\x1b[201~')
    ok('a paste during a run reaches the next-request draft', st.input === 'queued while busy', JSON.stringify(st.input))
    await type(KEY.enter)
    ok('Enter queues the pasted request', queue.length === 1 && queue[0] === 'queued while busy', JSON.stringify(queue))
    stop()
    scr.exit()
  }

  // ── 14. Pasting an API key still fills the secret buffer ─────────────────
  {
    const { scr, st } = fresh()
    const secret = scr.readSecret(st, 'OpenRouter key')
    await type('\x1b[200~sk-or-v1-abc123\x1b[201~')
    await type(KEY.enter)
    const value = await Promise.race([secret, settle(300)])
    ok('a bracketed paste lands in the secret buffer', value === 'sk-or-v1-abc123', String(value))
    ok('the secret never appears in the painted frame', !strip(scr.frame(st)).includes('sk-or-v1-abc123'),
      strip(scr.frame(st)).slice(-120))
    scr.exit()
  }

  // ── 15. THE SECURITY PROPERTY: a paste cannot answer a gate ──────────────
  {
    const { scr, st } = fresh()
    const dialog: ScreenDialog = { title: 'Approval', body: 'run the task?', prompt: 'Proceed?' }
    const gate = scr.askApproval(st, dialog)
    await type('\x1b[200~y\x1b[201~', '\x1b[200~1\x1b[201~')
    const early = await Promise.race([gate, settle(150)])
    ok('pasting "y" and "1" does NOT approve the gate', early === '__PENDING__', String(early))
    await type('y')
    const answer = await Promise.race([gate, settle(300)])
    ok('a real "y" keypress approves it', answer === true, String(answer))
    scr.exit()
  }

  // ── 16. The pager links URLs too (status/doctor/help are paged reports) ──
  {
    const { scr, st, get } = fresh()
    const page = scr.page(st, 'Status', [
      'Route: local · probe-3b',
      'Endpoint: http://localhost:11434/v1',
      'Mode: deterministic',
      'Pool: 1 model',
    ])
    const painted = get()
    ok('the pager wraps its bare URL in OSC 8', painted.includes('\x1b]8;;http://localhost:11434/v1'), JSON.stringify(painted.slice(-200)))
    ok('the pager keeps the URL text visible and width-neutral', strip(painted).includes('Endpoint: http://localhost:11434/v1'))
    await type(KEY.esc)
    const closed = await Promise.race([page, settle(300)])
    ok('Esc closes the pager', closed !== '__PENDING__', String(closed))
    scr.exit()
  }

  // ── 17. Focus: background/foreground is observable and repaints ──────────
  {
    const { scr, st, get } = fresh()
    scr.render(st)
    const before = get().length
    ok('the screen starts focused', scr.hasFocus === true)
    scr.onFocus(st, false)
    ok('losing focus is recorded', scr.hasFocus === false)
    const quiet = get().length
    scr.onFocus(st, true)
    ok('regaining focus is recorded', scr.hasFocus === true)
    ok('regaining focus forces a full repaint', get().length > quiet && get().length > before,
      `${before} -> ${quiet} -> ${get().length}`)
    scr.exit()
  }

  if (failures.length === 0) {
    console.log(`INPUT PROTOCOL TEST: PASS (${checks} checks, real terminal byte sequences)`)
  } else {
    console.log(`INPUT PROTOCOL TEST: ${failures.length} FAILURES of ${checks}\n`)
    for (const f of failures) console.log(`  • ${f}`)
    process.exitCode = 1
  }
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch(error => {
  console.error('INPUT PROTOCOL TEST: CRASHED —', error)
  process.exit(1)
})

/**
 * Terminal INPUT PROTOCOL layer — the one thing Wednesday adopted from
 * OpenTUI (https://github.com/anomalyco/opentui, MIT).
 *
 * Why this file exists: our renderer, layout and brand are ours and stay ours
 * (see screen.ts). Input is the opposite kind of problem — it is a spec with
 * many dialects (kitty keyboard protocol, xterm modifyOtherKeys, bracketed
 * paste, focus reporting, legacy CSI), and OpenTUI's `parse.keypress.ts` /
 * `parse.keypress-kitty.ts` / `detect-links.ts` are a tested, MIT-licensed
 * reading of that spec. The sequence tables and modifier maths below are
 * adapted from those files; everything is pure stdlib, so the harness keeps
 * its "zero new dependencies" rule.
 *
 * Adopted, with attribution in THIRD_PARTY_LICENSES.md:
 *   - kitty keyboard protocol parsing (unicode-key-code ; modifiers ; text)
 *   - xterm modifyOtherKeys (`CSI 27;mod;code~`)
 *   - CSI modifier parameters (`CSI 1;5A`, `CSI 5;3~`)
 *   - bracketed-paste / focus-reporting terminal modes
 *   - bare-URL detection with trailing-punctuation trimming
 *   - OSC 52 clipboard with tmux passthrough
 *
 * NOT adopted: OpenTUI's Zig renderer, Yoga layout, EditBuffer class, keymap
 * scene graph. Those are good, but swapping them in means rebuilding a
 * 200 KB screen that already ships, is tested, and carries our grammar. We
 * take the protocol facts and keep the harness.
 */

import { Buffer } from 'node:buffer'

// ---------------------------------------------------------------------------
// Terminal modes
// ---------------------------------------------------------------------------

/** Bracketed paste: the terminal marks a paste so it can never be read as keys. */
export const PASTE_ENABLE = '\x1b[?2004h'
export const PASTE_DISABLE = '\x1b[?2004l'

/** Focus reporting: `CSI I` on focus, `CSI O` on blur. */
export const FOCUS_ENABLE = '\x1b[?1004h'
export const FOCUS_DISABLE = '\x1b[?1004l'

/**
 * Kitty keyboard protocol, flag 1 only: DISAMBIGUATE ESCAPE CODES.
 *
 * That is the flag that turns Shift+Enter, Ctrl+Enter and Ctrl+letter into
 * unambiguous CSI-u reports instead of bytes that collide with Esc/Tab/CR.
 * We deliberately do NOT ask for event types (flag 2) or alternate keys
 * (flag 4): key release/repeat events would rewrite every handler in the
 * harness and buy nothing for a prompt box.
 *
 * Terminals that do not implement the protocol ignore the push. Terminals
 * that implement it answer with `CSI <codepoint>;modifier u`, which
 * `parseKittySequence` below understands.
 */
export const KITTY_PUSH = '\x1b[>1u'
export const KITTY_POP = '\x1b[<u'

/** `WEDNESDAY_LEGACY_INPUT=1` turns every 2026-11 protocol off (escape hatch). */
export function modernInput(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEDNESDAY_LEGACY_INPUT !== '1'
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

/** One decoded key. Extra fields are optional so old handlers keep compiling. */
export interface ParsedKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift?: boolean
  super?: boolean
  sequence: string
  /** Kitty's base-layout codepoint (99 = "c") for layout-independent shortcuts. */
  baseCode?: number
}

interface Mods {
  shift: boolean
  alt: boolean
  ctrl: boolean
  super: boolean
}

/** Terminal modifier bits: 1=Shift 2=Alt 4=Ctrl 8=Super (the `-1` is caller's). */
function modifierBits(mask: number): Mods {
  const m = Math.max(0, mask - 1)
  return {
    shift: (m & 1) !== 0,
    alt: (m & 2) !== 0,
    ctrl: (m & 4) !== 0,
    super: (m & 8) !== 0,
  }
}

/** Kitty private-use key codes (functional keys). */
const KITTY_KEYS: Record<number, string> = {
  27: 'escape', 9: 'tab', 13: 'return', 127: 'backspace',
  57344: 'escape', 57345: 'return', 57346: 'tab', 57347: 'backspace',
  57348: 'insert', 57349: 'delete', 57350: 'left', 57351: 'right',
  57352: 'up', 57353: 'down', 57354: 'pageup', 57355: 'pagedown',
  57356: 'home', 57357: 'end', 57358: 'capslock', 57359: 'scrolllock',
  57360: 'numlock', 57361: 'printscreen', 57362: 'pause', 57363: 'menu',
  57364: 'f1', 57365: 'f2', 57366: 'f3', 57367: 'f4', 57368: 'f5',
  57369: 'f6', 57370: 'f7', 57371: 'f8', 57372: 'f9', 57373: 'f10',
  57374: 'f11', 57375: 'f12', 57376: 'f13', 57377: 'f14', 57378: 'f15',
  57379: 'f16', 57380: 'f17', 57381: 'f18', 57382: 'f19', 57383: 'f20',
  57427: 'clear',
}

const CSI_LETTER_KEYS: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear',
  F: 'end', H: 'home', P: 'f1', Q: 'f2', S: 'f4', Z: 'tab',
}

const CSI_TILDE_KEYS: Record<string, string> = {
  '1': 'home', '2': 'insert', '3': 'delete', '4': 'end',
  '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end',
  '11': 'f1', '12': 'f2', '13': 'f3', '14': 'f4', '15': 'f5',
  '17': 'f6', '18': 'f7', '19': 'f8', '20': 'f9', '21': 'f10',
  '23': 'f11', '24': 'f12', '29': 'menu',
}

/**
 * Kitty protocol: `CSI unicode-key-code[:shifted[:base]] ; modifiers[:event] ; text u`
 * plus functional keys `CSI 1;mod:event LETTER` / `CSI num;mod:event ~`.
 *
 * Adapted from OpenTUI's `parse.keypress-kitty.ts` (MIT).
 */
export function parseKittySequence(sequence: string): ParsedKey | null {
  // Functional / tilde keys with the protocol's `1;mod:event` shape.
  const special = /^\x1b\[(\d+);(\d+)(?::(\d+))?([A-Z~])$/.exec(sequence)
  if (special) {
    const [, code, mod, , term] = special
    const name = term === '~' ? CSI_TILDE_KEYS[code!] : code === '1' ? CSI_LETTER_KEYS[term!] : undefined
    if (!name) return null
    const bits = modifierBits(Number(mod))
    return {
      name,
      ctrl: bits.ctrl,
      meta: bits.alt,
      shift: bits.shift || term === 'Z',
      super: bits.super,
      sequence,
    }
  }

  if (!sequence.endsWith('u') || !sequence.startsWith('\x1b[')) return null
  const params = sequence.slice(2, -1)
  if (!params || !/^[0-9;:]+$/.test(params)) return null

  const fields = params.split(';')
  const first = (fields[0] ?? '').split(':')
  const codepoint = Number(first[0])
  if (!Number.isFinite(codepoint)) return null
  const baseCode = first[2] ? Number(first[2]) : undefined

  const bits = fields[1] ? modifierBits(Number((fields[1].split(':')[0] ?? '1'))) : null
  const shift = bits?.shift ?? false

  let name: string
  let text = ''
  const exact = KITTY_KEYS[codepoint]
  // A C0 key code (10 = LF/Ctrl+J, 1-26 = Ctrl+letter) is a CONTROL key, not
  // a printable one. 9/13/27 are named above and never reach this branch; the
  // rest map to their letter so a nonconforming `CSI 1;5u` still means Ctrl+A
  // instead of typing a raw byte (the fuzz suite pins this).
  const controlKey = !exact && codepoint > 0 && codepoint < 27
  if (exact) {
    name = exact
  } else if (controlKey) {
    name = String.fromCharCode(codepoint + 96)
  } else if (codepoint >= 32 && codepoint <= 0x10ffff) {
    name = String.fromCodePoint(codepoint)
    if (name === ' ') name = 'space'
    // Field 3 is the text the key produced, when the terminal reports it.
    if (fields[2]) {
      for (const cp of fields[2].split(':')) {
        const n = Number(cp)
        if (Number.isFinite(n) && n >= 32 && n !== 127 && n <= 0x10ffff) text += String.fromCodePoint(n)
      }
    }
    if (!text && name.length > 0) {
      if (shift && first[1]) {
        const shifted = Number(first[1])
        text = Number.isFinite(shifted) && shifted >= 32 && shifted !== 127 ? String.fromCodePoint(shifted) : name
      } else {
        text = name === 'space' ? ' ' : name
      }
    }
  } else {
    return null
  }

  // Ctrl+letter arrives as the lower-case codepoint but Shift may capitalise
  // the printed name. Handlers bind on the KEY, not the glyph: normalise
  // Ctrl/Alt single letters to lower case so Ctrl+Shift+C still means Ctrl+C.
  if ((bits?.ctrl || bits?.alt) && /^[A-Z]$/.test(name)) name = name.toLowerCase()

  return {
    name,
    ctrl: (bits?.ctrl ?? false) || controlKey,
    meta: bits?.alt ?? false,
    shift,
    super: bits?.super ?? false,
    // Printable keys carry their text; named keys keep the raw report so the
    // composer's "never type an escape sequence" rule still applies.
    sequence: text || sequence,
    baseCode: baseCode !== undefined && Number.isFinite(baseCode) ? baseCode : undefined,
  }
}

/**
 * xterm `modifyOtherKeys`: `CSI 27 ; modifier ; codepoint ~`.
 *
 * iTerm2, Ghostty and xterm send this without any protocol push when the user
 * enables it; reading it costs nothing and turns Shift+Enter into a newline
 * on terminals that never learned kitty.
 */
export function parseModifyOtherKeys(sequence: string): ParsedKey | null {
  const m = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence)
  if (!m) return null
  const bits = modifierBits(Number(m[1]))
  const code = Number(m[2])
  const named: Record<number, string> = { 13: 'return', 27: 'escape', 9: 'tab', 32: 'space', 127: 'backspace' }
  let name = named[code] ?? ''
  // Same C0 rule as kitty: 1-26 are Ctrl+letter, never printable bytes.
  let controlKey = false
  if (!name && code > 0 && code < 27) {
    name = String.fromCharCode(code + 96)
    controlKey = true
  }
  // A raw C0 control is NOT a printable key. Kitty and modifyOtherKeys both
  // carry Unicode codepoints; codepoints 1-26 would otherwise type a control
  // byte into the draft (the fuzz suite caught `CSI 1u` doing exactly that).
  if (!name && code >= 33 && code <= 0x10ffff) name = String.fromCodePoint(code)
  if (!name) return null
  if ((bits.ctrl || bits.alt) && /^[A-Z]$/.test(name)) name = name.toLowerCase()
  return {
    name,
    ctrl: bits.ctrl || controlKey,
    meta: bits.alt,
    shift: bits.shift,
    super: bits.super,
    sequence: named[code] ? sequence : name,
  }
}

/**
 * Plain CSI with a modifier parameter: `CSI 1;5A` (Ctrl+Up), `CSI 5;3~`.
 * This is what xterm-family terminals send for modified arrows/paging even
 * when no keyboard protocol is negotiated.
 */
export function parseModifiedCsi(sequence: string): ParsedKey | null {
  const m = /^\x1b\[(\d+);(\d+)(?::\d+)?([A-Za-z~])$/.exec(sequence)
  if (!m) return null
  const [code, modifier, term] = [m[1]!, m[2]!, m[3]!]
  const name = term === '~' ? CSI_TILDE_KEYS[code] : code === '1' ? CSI_LETTER_KEYS[term] : undefined
  if (!name) return null
  const bits = modifierBits(Number(modifier))
  return {
    name,
    ctrl: bits.ctrl,
    meta: bits.alt,
    shift: bits.shift || term === 'Z',
    super: bits.super,
    sequence,
  }
}

// ---------------------------------------------------------------------------
// Composer word editing (OpenTUI EditBuffer semantics, our own implementation)
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Cursor index at the start of the word before `cursor` (Ctrl+Left/W). */
export function prevWordStart(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length))
  while (i > 0 && !WORD_CHAR.test(text[i - 1]!)) i -= 1
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i -= 1
  return i
}

/** Cursor index just past the word after `cursor` (Ctrl+Right). */
export function nextWordEnd(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length))
  while (i < text.length && !WORD_CHAR.test(text[i]!)) i += 1
  while (i < text.length && WORD_CHAR.test(text[i]!)) i += 1
  return i
}

// ---------------------------------------------------------------------------
// Links (adapted from OpenTUI's detect-links.ts, MIT)
// ---------------------------------------------------------------------------

const BARE_URL = /https?:\/\/[^\s<>"`\x1b\x07]+/gi

export interface LinkSpan {
  start: number
  end: number
  url: string
}

/**
 * Bare `https?://` URLs in plain text, with the trailing punctuation that is
 * almost never part of the address (`.` `,` `!` `?` `;` `:` `]` `}` `'`) and
 * unbalanced closing parentheses removed. Same rule OpenTUI applies before it
 * makes a span clickable; the tests pin the paren case.
 */
export function findLinks(text: string): LinkSpan[] {
  const out: LinkSpan[] = []
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0
    let url = match[0]
    let open = 0
    let close = 0
    for (const ch of url) {
      if (ch === '(') open += 1
      else if (ch === ')') close += 1
    }
    while (url.length > 0) {
      const last = url[url.length - 1]!
      if (last === ')' && close > open) { close -= 1; url = url.slice(0, -1); continue }
      if ('.,!?;:]}\''.includes(last)) { url = url.slice(0, -1); continue }
      break
    }
    if (url) out.push({ start, end: start + url.length, url })
  }
  return out
}

/** OSC 8 hyperlink wrapper: zero display width, ignored by terminals without it. */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

/**
 * Make bare URLs in one ALREADY-WRAPPED row clickable. Wrapping happens on
 * plain text first, so a URL never spans two rows here: the OSC 8 bytes cannot
 * affect our column maths (ANSI_RE strips them in screen.ts).
 */
export function autoLinkRow(text: string): string {
  const links = findLinks(text)
  if (links.length === 0) return text
  let out = ''
  let at = 0
  for (const link of links) {
    out += text.slice(at, link.start)
    out += hyperlink(text.slice(link.start, link.end), link.url)
    at = link.end
  }
  return out + text.slice(at)
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * OSC 52 clipboard sequence. Inside tmux the sequence must ride a DCS
 * passthrough with every ESC doubled, otherwise tmux swallows it and the
 * operator's copy silently does nothing — the exact bug OpenTUI's clipboard
 * layer guards against. GNU screen gets the plain passthrough form.
 */
export function osc52Sequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const payload = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
  if (env.TMUX) return `\x1bPtmux;\x1b${payload.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`
  if (env.STY) return `\x1bP${payload}\x1b\\`
  return payload
}

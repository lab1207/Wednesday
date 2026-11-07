import { stdin, stdout } from 'node:process'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { redactSensitiveText } from '../security/redaction'
import type { AgentActivity, AgentActivityKind } from '../events/types'

import { BRAND_HEX, THEME, fgHex, hexTo256 } from './theme'
import { MARKS, mark as markGlyph, markFor, supportsOrnamental, wordmarkRows } from './marks'
import { tesseractRows } from './cube'
import { computeWheelStep, initWheelAccelForHost, type WheelAccelState } from './wheel'
import {
  acceptedGhostText,
  acceptedText,
  clampActive,
  completionFor,
  fuzzyScore,
  moveActive,
  COMPLETION_VISIBLE,
  type CommandSpec,
  type CompletionState,
} from './completion'
import {
  FOCUS_DISABLE, FOCUS_ENABLE, KITTY_POP, KITTY_PUSH,
  PASTE_DISABLE, PASTE_ENABLE, autoLinkRow,
  modernInput, nextWordEnd, osc52Sequence, parseKittySequence, parseModifiedCsi,
  parseModifyOtherKeys, prevWordStart,
} from './key-protocol'
import {
  isLargePaste,
  pastePlaceholder,
  restorePasteDraft,
  stripUnresolvedPlaceholders,
} from './paste-framing'
import { KillRing } from './kill-ring'
import { UndoStack } from './undo-stack'
import {
  findMatches,
  searchLabel,
  type SearchMatch,
  type SearchSegment,
  type SearchState,
} from './transcript-search'

/**
 * B1d fullscreen screen — stdlib only, zero new dependencies.
 * Alternate-screen app driving our own Factory loop. Piped/non-TTY
 * sessions never enter this path.
 *
 * Visual language, two sources (both original reimplementations, no
 * vendored rendering code): the opencode TUI dialog/rail/toast grammar (MIT —
 * see THIRD_PARTY_LICENSES.md) and the Wednesday brand spec
 * (wednesday-theme/brand-spec.md). One violet flourish per screen, blood only
 * for failure, amber only for lit/awaiting states.
 *
 * The INPUT PROTOCOL layer (kitty keys, modifyOtherKeys, bracketed paste,
 * focus reports) is adapted from OpenTUI's MIT parsers in key-protocol.ts.
 * The renderer, layout and grammar here remain ours.
 */

/**
 * Footer key hints. One source: the preview board, the audit fixtures and the
 * live composer had drifted into three different strings, and the board still
 * advertised a `ctrl+c exits` hint the product had removed — a design record
 * that lies about the UI is worse than no design record.
 *
 * `wheel/pgup/pgdn scroll` is here because the transcript is longer than the
 * window: Hermes scrolls the transcript with the wheel, and the keyboard path
 * is the discoverable fallback for a terminal that forwards no mouse reports.
 */
export const COMPOSER_HINTS = '/ for commands · ctrl+p palette · drag to select · ctrl+c copies · wheel/pgup/pgdn scroll'
export const BUSY_HINTS = 'working… esc interrupts · type to queue'

/**
 * How long a quiet screen is trusted before the next paint rewrites every row.
 *
 * See `Screen.lastPaintAt`: the dirty-row diff is fast and correct until the
 * terminal moves under the app, and it cannot tell that it did. Two seconds is
 * the smallest gap that is reliably "a human was reading, not typing" — short
 * enough that a stale row heals before the next decision, long enough that
 * ordinary typing never pays for a full frame.
 */
export const IDLE_HEAL_MS = 2000

/**
 * SYNCHRONIZED OUTPUT — the terminal's atomic-frame mode.
 *
 * `CSI ? 2026 h` tells the terminal to hold everything that follows until
 * `CSI ? 2026 l`, and then present it in one go. Without it a frame arrives
 * row by row, and the operator can see the half-drawn page: the transcript
 * lands, the composer is still missing, the meter flickers. The mode is
 * standard (DEC 2026) and terminals that do not know it ignore the sequence
 * — so it costs nothing where it is not understood.
 *
 * pi uses the same pair around its frame (MIT, Copyright (c) 2025 Mario
 * Zechner — `packages/tui/src/tui-alt-screen.ts`). The behaviour is a
 * terminal protocol, not pi's code: two escape sequences, balanced.
 */
export const SYNC_OUTPUT_START = '\x1b[?2026h'
export const SYNC_OUTPUT_END = '\x1b[?2026l'

/**
 * The verbs that rotate beside the scanner while a run is live (Claude Code's
 * trick, cast for this house): the line never lies — the machine is doing one
 * of these things — but a word that changes every second reads as "alive",
 * where a frozen "working…" reads as "hung". Eight verbs make a full cycle
 * with no repeat, and the last one is the wink.
 */
export const BUSY_VERBS = ['forging', 'riveting', 'casting', 'tempering', 'milling', 'winding', 'polishing', 'brooding'] as const

/** Verb for a spin tick; changes every 8 ticks (~1s at the 120ms tick). */
export function busyVerb(spin: number): string {
  return BUSY_VERBS[Math.floor(spin / 8) % BUSY_VERBS.length]!
}

/**
 * The status line while a run is live: the rotating verb, then the two ways
 * out — interrupt, or keep typing.
 *
 * `type to queue` is part of this line and not just of `BUSY_HINTS`, because
 * `spinnerTick` rewrites the status every 120ms while the run is live. The
 * old `busyStatus` wrote only "esc interrupts", so the feature that lets an
 * operator line up the next three requests was invisible at exactly the moment
 * it was available — advertised once on the way in, gone for the whole run.
 */
/** The factory pipeline, in order. Every run walks it left to right. */
export const RUN_STAGES = ['plan', 'build', 'verify', 'review'] as const

/**
 * Which pipeline stage a seat or event belongs to.
 *
 * A run used to print `agent started` and then a spinner for minutes: the
 * operator could see THAT something was happening but not WHERE in the pipeline
 * it was, so a stuck planner and a working coder looked identical. The stage is
 * derivable from the role and the event type alone, so the stream and the
 * activity line can both say where the work is without the bus carrying a new
 * field.
 */
export function stageOf(role?: string, type = ''): { index: number; stage: string } | null {
  const hay = `${role ?? ''} ${type}`.toLowerCase()
  if (/architect|planner|\bplan\b/.test(hay)) return { index: 1, stage: 'plan' }
  if (/coder|builder|\bbuild\b/.test(hay)) return { index: 2, stage: 'build' }
  if (/tester|verif/.test(hay)) return { index: 3, stage: 'verify' }
  if (/review/.test(hay)) return { index: 4, stage: 'review' }
  if (/repair|fixer/.test(hay)) return { index: 4, stage: 'repair' }
  return null
}

/**
 * The activity line while a turn is live.
 *
 * Three sources, in order of truthfulness:
 *
 *  1. the live CHAT turn (`chat`): who is answering and what it is doing —
 *     the only source that knows about a chat, and the reason a chat no
 *     longer falls back to a decorative verb;
 *  2. the crew dock (`crew`): the seat, its pipeline stage and the last
 *     concrete thing it touched — real state, not a rotating verb;
 *  3. nothing known: the rotating verb. This is the one decorative case,
 *     and it is honest about being generic ("forging…" is texture, not a
 *     claim about the work).
 *
 * `esc interrupts · type to queue` is always last: those are the two ways
 * out of a live turn, and they must not be pushed off the end of a narrow
 * window by a long seat name.
 */
export function busyStatus(
  spin: number,
  crew?: CrewRow[],
  chat?: { role: string; detail: string } | null,
): string {
  if (chat) return `${chat.role} · ${chat.detail} · esc interrupts · type to queue`
  const live = (crew ?? []).filter(row => row.phase !== 'done' && row.phase !== 'failed')
  const at = live[live.length - 1]
  if (!at) return `${busyVerb(spin)}… · esc interrupts · type to queue`
  const stage = stageOf(at.role)
  const prefix = stage ? `${stage.index} ${stage.stage} · ` : ''
  const seat = at.lane ? `${at.role} ${at.lane}` : at.role
  return `${prefix}${seat}${at.detail ? ` · ${at.detail}` : ''} · esc interrupts · type to queue`
}

/**
 * Advisories that must not stand between the operator and the UI.
 *
 * The health meter (~1s) and the update notice (a registry GET with a 2.5s
 * timeout) both used to be awaited BEFORE the alternate screen was entered, so
 * a cold or offline machine sat on nothing for seconds and then threw the
 * output away when `1049h` wiped it. On the screen path the UI comes up first
 * and these land whenever they land. The classic/piped path still awaits them
 * inline, because a script wants the line in stdout, in order.
 */
export interface StartupAdvisories {
  /** Returns a one-line health lamp, or null if the meter failed. */
  health?: () => Promise<string | null>
  /** Returns a one-line update notice, or null if there is nothing to say. */
  update?: () => Promise<string | null>
}

/**
 * Report the startup advisories through a screen that already exists.
 *
 * Fire-and-forget by design, and total: neither job can reject into the
 * session (a background advisory is not allowed to take the REPL down), the
 * health lamp becomes a toast that expires, and the update notice goes into the
 * stream — console output here would land under the alternate screen, where
 * nobody sees it.
 */
export function runAdvisories(screen: Screen, state: ScreenState, advisories: StartupAdvisories): void {
  if (advisories.update) {
    void advisories.update()
      .then(notice => {
        // Persist the notice on the state so the HOME page keeps showing the
        // banner (not just a stream line that scrolls away); the stream line
        // still lands for the transcript after the first request.
        state.updateNotice = notice ?? null
        if (notice) screen.push(state, { text: notice, tone: 'yellow' })
      })
      .catch(() => { /* a failed update check is not news */ })
  }
  if (advisories.health) {
    void advisories.health()
      .then(line => { if (line) screen.notify(state, line) })
      .catch(() => { /* a failed meter is not news */ })
  }
}

export type MsgTone = 'plain' | 'dim' | 'green' | 'red' | 'yellow' | 'cyan' | 'bold'

export interface ScreenMessage {
  text: string
  tone: MsgTone
  /**
   * A framed answer block (Hermes' response panel): title on the top rule, the
   * answer inside, one closing rule. Rendered at the CURRENT width — a stored
   * pre-drawn frame would keep the old width after a resize.
   */
  panel?: { title: string; lines: Array<{ text: string; tone: MsgTone }> }
  /**
   * An invisible key for a row that is rewritten IN PLACE — the live activity
   * row of a seat. The renderer never shows it; the harness uses it to find
   * the row again after the transcript shifted or was trimmed.
   */
  live?: string
}

export interface ScreenDialog {
  title: string
  body: string
  prompt: string
  /**
   * Which action Enter would take. Defaults to `cancel`: the classic `[y/N]`
   * gate is default-N, and an approval that runs on a stray Enter is worse
   * than one that needs a second key. `y` still runs it, visibly.
   */
  focus?: 'cancel' | 'run'
  /**
   * The panel's headline, above the title. Absent keeps the approval
   * headline: this dialog is the approval gate most of the time, and a
   * confirm (`/clear`, `/new`) names itself instead of calling a session
   * wipe an "approval".
   */
  headline?: string
  /**
   * The numbered choices. Absent keeps `Run once` / `Deny`; a confirm puts
   * Hermes' two honest options here — `Yes, clear the session` and
   * `No, keep going` — with the cursor still on the safe one.
   */
  choices?: ReadonlyArray<{ key: string; label: string; value: 'run' | 'cancel' }>
  /** The key-hint row. Absent keeps the approval hint. */
  hint?: string
}

/**
 * The approval button row: `[ N ]  cancel` and `[ Y ]  run`, one of them lit
 * with void-on-violet.
 *
 * `room` is the columns available inside the card. On a narrow terminal the
 * labelled form does not fit — and a clipped `[ Y ]` is not a cosmetic
 * problem: the button stops being clickable, so the ONLY way to approve is the
 * keyboard. So the row degrades in three honest steps (wide gap → narrow gap →
 * bare keys) and the tokens always survive.
 *
 * Returned WITH its column map so the click hit-map and the pixels cannot
 * disagree — the previous version searched the painted frame for the literal
 * text `[cancel]`/`[confirm]`, which silently rotted the moment the wording
 * changed and turned every click into a reject.
 */
export interface DialogButtons {
  row: string
  /** 0-based column of each button's hit box inside `row`. */
  cancelAt: number
  runAt: number
  /** The painted label of the run button, so the hit box covers it too. */
  runLabel: string
  cancelLabel: string
}

/**
 * Approval choices, Hermes grammar: numbered rows under a `▸` cursor.
 *
 * Hermes' approval panel offers Allow once / Allow this session / Always allow
 * / Deny. A Wednesday factory run is one-shot and writes the workspace, so the
 * honest pair is Run once / Deny — the same numbered grammar without promising
 * a session grant the factory does not have.
 */
export const APPROVAL_CHOICES: ReadonlyArray<{ key: string; label: string; value: 'run' | 'cancel' }> = [
  { key: '1', label: 'Run once', value: 'run' },
  { key: '2', label: 'Deny', value: 'cancel' },
]

/** The numbered choice rows, lit on the armed one. */
export function choiceRows(
  focus: 'run' | 'cancel',
  choices: ReadonlyArray<{ key: string; label: string; value: 'run' | 'cancel' }> = APPROVAL_CHOICES,
  width = 80,
): string[] {
  return choices.map(choice => {
    const armed = choice.value === focus
    const row = `${armed ? '▸' : ' '} ${choice.key}. ${choice.label}`
    return clipVisible(armed ? tone('yellow', row) : tone('dim', row), width)
  })
}

/** The one key-hint row under the choices, longest form that fits. */
export function approvalHint(width = 80): string {
  const forms = [
    '↑/↓ select · Enter confirm · 1-2 quick pick · Esc/Ctrl+C deny',
    '↑/↓ select · Enter · 1/2 · Esc denies',
    '↑/↓ · Enter · 1/2 · Esc',
    '↑/↓ · Enter · 1/2',
    '1/2 · Esc',
  ]
  return forms.find(line => line.length <= width) ?? '1/2'
}

/**
 * The line under the buttons. Longest variant that FITS, ordered so the keys
 * survive longest: a hint clipped to "n/esc cance" reads as a broken
 * keybinding, and the whole point of this row is that the operator can tell
 * what each key does. When even the keys do not fit, the buttons carry them.
 */
export function dialogHint(focus: 'cancel' | 'run', room: number): string {
  const enter = focus === 'run' ? 'enter runs' : 'enter cancels'
  const armed = focus === 'run' ? 'Y' : 'N'
  return [
    `${enter} · y runs · n/esc cancels · never auto-approve in a pipe`,
    `${enter} · y runs · n/esc cancels`,
    // Enter's meaning is the part that must never be lost: "Enter rejected but
    // the button looked bold" was a real confusion, so it outranks the full key
    // list and gets its own short form before anything is dropped.
    `enter=${armed} · y runs`,
    `enter=${armed}`,
  ].find(line => line.length <= room) ?? `enter=${armed}`
}

export function dialogButtons(focus: 'cancel' | 'run', indent = 2, room = 80): DialogButtons {  const forms: Array<[string, string, number]> = [
    ['[ N ]  cancel', '[ Y ]  run', 4],
    ['[ N ] cancel', '[ Y ] run', 2],
    ['[ N ]', '[ Y ]', 2],
  ]
  const form = forms.find(([a, b, gap]) => indent + a.length + gap + b.length <= room) ?? forms[forms.length - 1]!
  const [cancelLabel, runLabel, gap] = form
  const cancelAt = indent
  const runAt = indent + cancelLabel.length + gap
  // Paint from the plain layout so the lit fill lands on exactly the right
  // columns instead of shifting the row by its own escape codes.
  const row = ' '.repeat(cancelAt)
    + (focus === 'cancel' ? armedFill(cancelLabel) : tone('dim', cancelLabel))
    + ' '.repeat(gap)
    + (focus === 'run' ? armedFill(runLabel) : tone('dim', runLabel))
  return { row, cancelAt, runAt, cancelLabel, runLabel }
}

/**
 * A decoded mouse report (SGR/1006 encoding, 1-based terminal cells).
 * `motion` is a hover (no button), `press` a click, `wheel` a scroll tick.
 * `button` is -1 when no button is involved (pure hover).
 */
export interface MouseEvent {
  button: number
  x: number
  y: number
  wheel: boolean
  motion: boolean
  press: boolean
}

/** `ESC[<btn;col;rowM` (press) / `m` (release). The only mouse encoding we ask for. */
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

/** Decode one mouse report from a chunk of terminal input (null if none). */
export function parseMouse(text: string): MouseEvent | null {
  MOUSE_RE.lastIndex = 0
  const m = MOUSE_RE.exec(text)
  if (!m) return null
  const button = Number(m[1])
  return {
    button: (button & 3) === 3 ? -1 : button & 3,
    x: Number(m[2]),
    y: Number(m[3]),
    wheel: (button & 64) !== 0,
    motion: (button & 32) !== 0,
    press: m[4] === 'M',
  }
}

/**
 * Mouse callback for the screen currently owning input. Overlays (palette,
 * dialogs) set it; a press outside their bounds resolves undefined, which is
 * what "click anywhere to dismiss" means. Never armed while a run is live,
 * so a stray click cannot cancel a task.
 */
export type MouseHandler = (event: MouseEvent) => void

/**
 * Nevermore palette — 256-color codes derived from the brand spec
 * (hexTo256 in theme.ts), so every terminal (including stock Windows
 * consoles) renders the same hues: bone / ash-violet / wrought-iron /
 * Nevermore / blood-ink / amber / sage.
 */
const TONE_CODE: Record<MsgTone, string | null> = {
  plain: `38;5;${THEME.fg}`,
  dim: `38;5;${THEME.muted}`,
  green: `38;5;${THEME.sage}`,
  red: `38;5;${THEME.bloodInk}`,
  yellow: `38;5;${THEME.amber}`,
  cyan: `38;5;${THEME.accent}`,
  bold: `1;38;5;${THEME.fg}`,
}

/** Truecolor variant (used where the panel needs exact brand ink). */
export function brand(hex: string, text: string): string {
  return fgHex(hex, text)
}

export { BRAND_HEX, hexTo256 }

function tone(toneName: MsgTone, text: string): string {
  const code = TONE_CODE[toneName]
  return code ? `\x1b[${code}m${text}\x1b[0m` : text
}

/**
 * Zero-width control sequences the layout must ignore: SGR colour and OSC 8
 * hyperlinks (adopted from OpenTUI's link support). Without the OSC 8 arm a
 * linked URL would be measured as its escape bytes and tear the frame.
 */
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Terminal input router. We parse the byte stream ourselves instead of using
 * readline's keypress emitter, for two reasons that both bit us in the field:
 *
 *  1. readline does NOT understand SGR mouse reports — `\x1b[<0;12;5M` reached
 *     the composer as the literal text `0;12;5M`.
 *  2. Windows console hosts drop the modifier flag, so `key.ctrl` was
 *     unreliable and every Ctrl binding had to match a raw byte as well.
 *
 * One owner at a time: the caller attaches, gets `key` and `mouse` callbacks,
 * and detaches when it is done.
 */
export interface TerminalKey {
  name: string
  ctrl: boolean
  meta: boolean
  /** Shift, when the terminal actually reports it (kitty/modifyOtherKeys). */
  shift?: boolean
  /** Super/Cmd, when the terminal reports it. */
  super?: boolean
  sequence: string
  /**
   * Kitty's base-layout codepoint. A key that prints `ㅊ` on a Korean layout
   * still reports 99 ("c") here, so shortcuts stay layout-independent.
   */
  baseCode?: number
}

export interface InputHandlers {
  key?: (key: TerminalKey) => void
  mouse?: (event: MouseEvent) => void
  /**
   * Bracketed-paste payload (already unwrapped from `CSI 200~ … CSI 201~`).
   * Delivered exactly as the terminal sent it — escape sequences included —
   * so a text surface MUST sanitise before inserting (`pasteText` in this
   * file). Modal gates that answer yes/no deliberately do NOT handle it, so
   * pasting can never approve or reject a task.
   */
  paste?: (text: string) => void
  /** Terminal focus: true when the window gained focus, false when it lost it. */
  focus?: (focused: boolean) => void
  /**
   * Also track hover (`?1003h`). Costs native text selection, so only an
   * overlay that genuinely uses hover preview asks for it.
   */
  hover?: boolean
  /**
   * Where to write the mouse-reporting modes. Defaults to the process stdout,
   * which is where the screen draws in production; a Screen passes its own
   * stream so the modes and the frame always go to the same place.
   */
  out?: NodeJS.WriteStream
}

/**
 * Mouse reporting, one preset for the stream and one extra for overlays:
 *
 *  - The STREAM arms button-event tracking (`1000 + 1002 + 1006`). `1000` is
 *    press/release, `1002` adds MOTION WHILE A BUTTON IS HELD — that is the
 *    only mode in which a terminal sends the drag reports `selectEvent` needs.
 *    The previous `1000`-only preset advertised "drag to select" and could
 *    never receive a drag at all, so mouse copy was dead on every terminal.
 *  - OVERLAYS may additionally arm any-motion (`1003`) when their hit map uses
 *    hover. That supersedes `1002`; `detach` disarms every mode it armed.
 *
 * Native text selection survives as the terminal's own Shift+drag bypass;
 * the app's own drag selection is what Ctrl+C/right-click copy.
 */
/** A mouse selection in 1-based frame cells, anchor and cursor inclusive. */
export interface SelectionRange {
  row: number
  col: number
  toRow: number
  toCol: number
}

/**
 * The selection in READING ORDER. A drag can go up or left, and an
 * unnormalised range would copy backwards (or nothing at all).
 */
export function normaliseSelection(sel: SelectionRange): SelectionRange {
  const forward = sel.row < sel.toRow || (sel.row === sel.toRow && sel.col <= sel.toCol)
  return forward
    ? { row: sel.row, col: sel.col, toRow: sel.toRow, toCol: sel.toCol }
    : { row: sel.toRow, col: sel.toCol, toRow: sel.row, toCol: sel.col }
}

/**
 * Wrap the cells from `start` to `end` (0-based, end exclusive) in inverse
 * video without disturbing the rest of the row.
 *
 * The row carries its own SGR runs, so the inverse pair is inserted while
 * WALKING visible columns: wrapping the whole string would invert the padding
 * too, and slicing the string would cut an escape in half.
 */
export function inverseColumns(text: string, start: number, end: number): string {
  if (!text || end <= start) return text
  let out = ''
  let col = 0
  let open = false
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const ch of part) {
      const w = columnOf(ch.codePointAt(0)!)
      if (!open && col >= start) { out += '\x1b[7m'; open = true }
      out += ch
      col += w
      if (open && col >= end) { out += '\x1b[27m'; open = false }
    }
  }
  if (open) out += '\x1b[27m'
  return out
}

export function mouseArm(hover: boolean): string {
  return `\x1b[?1000h\x1b[?1002h\x1b[?1006h${hover ? '\x1b[?1003h' : ''}`
}

/** Reverse order: the coarsest tracking mode is disabled first. */
export function mouseDisarm(): string {
  return '\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l'
}

/** CSI final byte → key name (arrows, paging, home/end). */
const CSI_NAME: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  // Shift+Tab (CBT). Legacy terminals send this when no keyboard protocol is
  // negotiated; without the row it was SWALLOWED (no key reached any handler).
  Z: 'tab',
  '1~': 'home', '2~': 'insert', '3~': 'delete', '4~': 'end',
  '5~': 'pageup', '6~': 'pagedown',
  // Modified Enter (CSI u): Shift/Ctrl/Alt+Enter all mean "newline, don't
  // submit". Plain Enter arrives as CR, never as CSI u, so every 13u variant
  // is a newline request. Without this Shift+Enter did nothing.
  '13u': 'newline', '13;2u': 'newline', '13;3u': 'newline', '13;4u': 'newline',
  '13;5u': 'newline', '13;6u': 'newline', '13;7u': 'newline', '13;8u': 'newline',
}

/**
 * Split a raw chunk into key presses and mouse reports.
 *
 * `pending` is the undecided tail: an escape sequence that the terminal cut in
 * half. Real terminals split reads mid-sequence (a click arriving as
 * `ESC [ M 0` then `+ %`), and without carrying the tail over the remainder
 * types into the composer as literal characters. Callers hold `pending` and
 * prepend it to the next chunk.
 */
export type DecodedEvent =
  | { kind: 'key'; key: TerminalKey }
  | { kind: 'mouse'; event: MouseEvent }
  | { kind: 'paste'; text: string }
  | { kind: 'focus'; focused: boolean }

export interface DecodedInput {
  keys: TerminalKey[]
  mouse: MouseEvent[]
  /** Bracketed-paste payloads, in the order the terminal sent them. */
  paste: string[]
  /** Focus gained (true) / lost (false). */
  focus: boolean[]
  /** Every event in READ ORDER (a paste followed by Enter must not reorder). */
  events: DecodedEvent[]
  pending: string
}

/**
 * Split a raw chunk into key presses, mouse reports, pastes and focus changes.
 *
 * `pending` is the undecided tail: an escape sequence that the terminal cut in
 * half. Real terminals split reads mid-sequence (a click arriving as
 * `ESC [ M 0` then `+ %`), and without carrying the tail over the remainder
 * types into the composer as literal characters. Callers hold `pending` and
 * prepend it to the next chunk.
 */
export function decodeInput(text: string): DecodedInput {
  const events: DecodedEvent[] = []
  let i = 0
  let pending = ''
  const key = (name: string, ctrl: boolean, sequence: string, extra: Partial<TerminalKey> = {}): void => {
    events.push({ kind: 'key', key: { name, ctrl, meta: false, sequence, ...extra } })
  }
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b') {
      const rest = text.length - i
      // ESC with nothing usable after it yet: wait for the next chunk.
      if (rest === 1) { pending = text.slice(i); break }
      if (text[i + 1] === '[') {
        if (rest === 2) { pending = text.slice(i); break }
        const third = text[i + 2]!
        // Focus reporting (DECSET 1004): ESC[I gained, ESC[O lost. Without
        // this branch the generic CSI path swallowed both silently.
        if (third === 'I' || third === 'O') {
          events.push({ kind: 'focus', focused: third === 'I' })
          i += 3
          continue
        }
        // Bracketed paste (DECSET 2004): ESC[200~ <verbatim bytes> ESC[201~.
        // The payload may contain ANY byte, newlines and escapes included, so
        // it is sliced, never decoded. A paste split across reads is held in
        // `pending` and completed by the next chunk.
        if (text.startsWith('\x1b[200~', i)) {
          const end = text.indexOf('\x1b[201~', i + 6)
          if (end < 0) { pending = text.slice(i); break }
          events.push({ kind: 'paste', text: text.slice(i + 6, end) })
          i = end + 6
          continue
        }
        if (third === '<') {
          // SGR mouse: ESC [ < b ; x ; y (M|m)
          const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text.slice(i))
          if (m) {
            const b = Number(m[1])
            events.push({ kind: 'mouse', event: {
              button: (b & 3) === 3 ? -1 : b & 3,
              x: Number(m[2]),
              y: Number(m[3]),
              wheel: (b & 64) !== 0,
              motion: (b & 32) !== 0,
              press: m[4] === 'M',
            } })
            i += m[0].length
            continue
          }
          // No terminator yet and the tail could still become one.
          if (!/\d/.test(text.slice(i + 3)) && rest < 12) { pending = text.slice(i); break }
          if (/^[\d;]*$/.test(text.slice(i + 3))) { pending = text.slice(i); break }
          // Malformed: swallow through the M/m terminator if present, else the
          // whole tail. Swallowing only the introducer would type "Mhello...".
          {
            const tail = text.slice(i + 3)
            const term = tail.search(/[Mm]/)
            i += term >= 0 ? 3 + term + 1 : text.length - i
          }
          continue
        }
        if (third === 'M') {
          // Legacy X10 mouse: ESC [ M <b> <col+32> <row+32>
          if (rest < 6) { pending = text.slice(i); break }
          const b = text.charCodeAt(i + 3) - 32
          const x = text.charCodeAt(i + 4) - 32
          const y = text.charCodeAt(i + 5) - 32
          if (b >= 0 && x >= 1 && y >= 1) {
            events.push({ kind: 'mouse', event: {
              // X10 has no release event: button 3 means released / no button.
              button: (b & 3) === 3 ? -1 : b & 3,
              x,
              y,
              wheel: (b & 64) !== 0,
              motion: (b & 32) !== 0,
              press: (b & 3) !== 3,
            } })
            i += 6
            continue
          }
          // Bad coordinates: swallow the whole 6-byte report. Emitting the
          // trailing bytes as spaces would type into the composer.
          i += 6
          continue
        }
        const m = /^\x1b\[([0-9;:]*)([A-Za-z~])/.exec(text.slice(i))
        if (m) {
          const seq = m[0]
          // Wire-protocol reports first: kitty (`CSI 99;5u`), xterm
          // modifyOtherKeys (`CSI 27;5;13~`), then plain modified CSI
          // (`CSI 1;5A`). All three carry a real modifier mask, which the
          // legacy table below throws away.
          const kitty = parseKittySequence(seq)
          const other = kitty ? null : parseModifyOtherKeys(seq)
          const parsed = kitty ?? other ?? parseModifiedCsi(seq)
          if (parsed) {
            // Policy, not protocol: Enter NEVER submits when it arrives as a
            // wire report. Plain Enter is the one key that runs a request and
            // it always arrives as CR. A bare kitty `CSI 13u` counts too: a
            // terminal that sends Enter through CSI u is asking for a newline
            // (the pre-2026-11 table treated every `13u` variant this way).
            // modifyOtherKeys is the exception — xterm reports unmodified keys
            // too, so `CSI 27;1;13~` is still a plain submit.
            if (parsed.name === 'return' && (kitty || parsed.ctrl || parsed.meta || parsed.shift)) parsed.name = 'newline'
            events.push({ kind: 'key', key: parsed })
            i += seq.length
            continue
          }
          const name = CSI_NAME[`${m[1]}${m[2]}`] ?? CSI_NAME[m[2]!]
          if (name) key(name, false, seq, { shift: m[2] === 'Z' })
          i += seq.length
          continue
        }
        // Incomplete CSI without a terminator: if it is all digits/semicolons
        // (or kitty's `:` event separator) it could still become valid on the
        // next chunk, so hold it. But a long digit run with no terminator is
        // garbage, not a split read: swallow the introducer plus digits rather
        // than typing numbers.
        if (/^\x1b\[[\d;:]*$/.test(text.slice(i))) {
          if (rest < 12) { pending = text.slice(i); break }
          i += text.slice(i).length
          continue
        }
        if (rest < 8) { pending = text.slice(i); break }
        i += 2 // unknown introducer: swallow it rather than type brackets
        continue
      }
      // SS3 (ESC O + letter: F1-F4, numpad): swallow the 3-byte sequence.
      // Falling through to bare-escape would clear the draft and type "OP".
      if (text[i + 1] === 'O') {
        if (rest === 2) { pending = text.slice(i); break }
        i += 3
        continue
      }
      // OSC (ESC ] ... BEL or ESC \): swallow title responses and queries.
      // Typing them would insert ";title" and a stray Ctrl-G into the draft.
      if (text[i + 1] === ']') {
        const bel = text.indexOf('\x07', i + 2)
        const st = text.indexOf('\x1b\\', i + 2)
        const end = bel >= 0 && st >= 0 ? Math.min(bel, st) : bel >= 0 ? bel : st
        if (end < 0) {
          if (rest < 128) { pending = text.slice(i); break }
          i += text.length - i
          continue
        }
        i = end + (text[end] === '\x07' ? 1 : 2)
        continue
      }
      // ESC + a printable byte in the SAME chunk: Alt on a real keyboard, but
      // this harness binds no Alt chords, so swallowing is pure loss. It is far
      // more often a batched press — the operator hit Esc, then typed, and the
      // PTY delivered both in one read (a script, or a busy app whose owner was
      // mid-dispatch). Eating both used to destroy the Esc AND the first
      // character of every later command: a 39-byte chunk of
      // `esc /model\r esc /connect\r` shipped "model" and "connect" to the
      // open plate, and Enter's escape hatch dispatched "connect" as a REQUEST.
      // Emit the escape and keep decoding — the escape closes whatever is open,
      // and the rest is carried to the next input owner.
      key('escape', false, '\x1b')
      i += 1
      continue
    }
    if (ch === '\r') { key('return', false, ch); i += 1; continue }
    // Ctrl+J must win over LF: it is our composer newline binding.
    if (ch === '\n') { key('j', true, ch); i += 1; continue }
    if (ch === '\t') { key('tab', false, ch); i += 1; continue }
    if (ch === '\x7f' || ch === '\b') { key('backspace', false, ch); i += 1; continue }
    const code = ch.codePointAt(0) ?? 0
    if (code < 32) { key(String.fromCharCode(code + 96), true, ch); i += 1; continue }
    // Printable RUN, not a single character. A paste arrives as one chunk with
    // no control bytes in it; emitting one key per character lost the only
    // signal that distinguishes typing from pasting, and made the composer
    // treat a pasted "/usr/local/bin" as if the "/" had been typed alone.
    let end = i
    while (end < text.length) {
      const c = text[end]!
      if (c === '\x1b' || c === '\r' || c === '\n' || c === '\t' || c === '\x7f' || c === '\b') break
      if ((c.codePointAt(0) ?? 0) < 32) break
      end += c.length
    }
    const run = text.slice(i, end)
    // Defensive: the run can never be empty (control bytes break the scan
    // above and are handled as ctrl keys), but if it ever were, advancing by
    // zero would hang the session in an infinite loop. Guard it.
    if (!run) { i += ch.length; continue }
    key(run, false, run)
    i = end
  }
  const keys: TerminalKey[] = []
  const mouse: MouseEvent[] = []
  const paste: string[] = []
  const focus: boolean[] = []
  for (const event of events) {
    if (event.kind === 'key') keys.push(event.key)
    else if (event.kind === 'mouse') mouse.push(event.event)
    else if (event.kind === 'paste') paste.push(event.text)
    else focus.push(event.focused)
  }
  return { keys, mouse, paste, focus, events, pending }
}

/**
 * Session trace — silent unless `WEDNESDAY_TRACE` names a file (or is `1`,
 * which lands on `~/.wednesday/trace.log`).
 *
 * Why this exists: the 2026-10-16 "type / and everything freezes — not even
 * Ctrl+C" report could not be reproduced through the same seams with
 * synthetic input, which leaves the real terminal's channel as the only
 * unobserved participant. An append-only log of what actually arrived on
 * stdin, what it decoded to, and whether a listener was even attached is
 * what turns the next reproduction into evidence instead of a story.
 *
 * Synchronous on purpose: the interesting moment is usually the one right
 * before a crash, and buffered writes lose exactly that line. Runtime data,
 * never written into the repo.
 */
export function tracePath(): string | null {
  const value = process.env.WEDNESDAY_TRACE
  if (!value) return null
  if (value === '1' || value.toLowerCase() === 'true') return join(homedir(), '.wednesday', 'trace.log')
  return value
}

export function traceNote(line: string): void {
  const path = tracePath()
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    // The trace records typed input, and people paste keys. Redact at the one
    // write point so a trace shared for debugging can never carry a secret.
    appendFileSync(path, `${new Date().toISOString()} ${redactSensitiveText(line)}\n`)
  } catch { /* tracing must never take the session down */ }
}

/** First bytes of a chunk as hex — enough to identify a sequence, capped. */
function hexPreview(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  const shown = buf.subarray(0, 48).toString('hex')
  return buf.length > 48 ? `${shown}…(${buf.length}B)` : shown
}

/**
 * Pasted text is UNTRUSTED terminal content.
 *
 * A bracketed paste is delivered verbatim by every terminal: SGR colour from a
 * copied log, `ESC[2J` from a copied shell transcript, BEL, NUL. The composer
 * ECHOES the draft into the frame, so an ESC left in it is not cosmetic — the
 * terminal executes it on the next paint and a paste can clear the screen or
 * move the cursor. Strip escape/OSC sequences and C0 controls, expand tabs
 * (a real tab jumps to the terminal's next stop and tears the composer rail),
 * and keep newlines: a pasted block stays a block, it just cannot carry
 * terminal commands. One trailing newline is still dropped (copying a line
 * usually adds one); nothing is ever executed.
 */
function pasteText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS / APC / PM / SOS, all terminated by ST. A copied `tmux`/sixel/OSC
    // blob is a terminal command, never draft text.
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    .replace(/\n$/, '')
}

/**
 * Attach the input router to stdin for the duration of one interaction.
 * Returns a detach function. A partial escape sequence is carried between
 * reads; a lone ESC is flushed on a short timer so Esc still cancels.
 *
 * RAW MODE IS NOT TOUCHED HERE. It is armed once, for the whole session, by
 * `Screen.enter()` and restored by `Screen.exit()`.
 *
 * Toggling it per interaction was a real, proven defect on Windows: every
 * `attachInput` used to `setRawMode(true)` and every detach restored the prior
 * state, so a session whose first attach came from a non-raw stream left the
 * app in NON-raw mode between two prompts. On ConPTY, `setRawMode(false)`
 * flushes the console input queue — so a keystroke that arrived during that
 * window was thrown away by the OS, not by us. A live pty capture showed it
 * plainly: Ctrl+P opened the palette, Esc dismissed it, Ctrl+P reopened it,
 * and then a 7-byte `/tasks\r` written 700ms later NEVER appeared in the app's
 * input trace, while the next single keystrokes arrived fine. A real operator
 * typing a command right after closing an overlay lost it the same way.
 *
 * So: raw once, and detach PAUSES the stream instead of flipping its mode. A
 * paused stream keeps its bytes: a key pressed during the hand-off between two
 * prompts is delivered to the next listener rather than eaten.
 */
/**
 * Keys (and wheel ticks) that outlived the prompt that was reading them.
 *
 * One PTY read can carry several complete keypresses: a paste, a fast typist,
 * or a scripted `a\r b\r c\r`. The FIRST return resolves its prompt and
 * detaches, and everything after it in the same chunk used to be dropped on
 * the floor — `/clear\r/new\r/health\r` ran only `/clear`. The remainder is
 * carried here and replayed to whoever owns the keyboard next, which is
 * exactly where the terminal's own buffer would have delivered it.
 */
type CarriedInput =
  | { kind: 'key'; key: TerminalKey }
  | { kind: 'mouse'; event: MouseEvent }
  | { kind: 'paste'; text: string }
  | { kind: 'focus'; focused: boolean }

const carriedInput: CarriedInput[] = []

export function attachInput(handlers: InputHandlers): () => void {
  const input = stdin
  traceNote(`input.attach tty=${String(input.isTTY)} raw=${String(input.isRaw)} mouse=${String(typeof handlers.mouse === 'function')}`)
  let pending = ''
  let flush: NodeJS.Timeout | null = null
  let detached = false
  const deliver = (item: CarriedInput): void => {
    if (item.kind === 'mouse') {
      traceNote(`mouse btn=${item.event.button} x=${item.event.x} y=${item.event.y} press=${item.event.press} wheel=${item.event.wheel} motion=${item.event.motion}`)
      try { handlers.mouse?.(item.event) } catch { /* a throwing mouse handler must not kill the session */ }
      return
    }
    if (item.kind === 'paste') {
      // Content is never logged, only its size: a pasted key must not land in
      // the trace file (same rule as typed input).
      traceNote(`paste n=${item.text.length}`)
      try { handlers.paste?.(item.text) } catch { /* a paste must never take the session down */ }
      return
    }
    if (item.kind === 'focus') {
      traceNote(`focus ${item.focused ? 'in' : 'out'}`)
      try { handlers.focus?.(item.focused) } catch { /* ignore */ }
      return
    }
    // Same redaction as `emit`: a printable key's name IS the character, and a
    // secret prompt's keystrokes must not land in the trace one by one.
    const seq = item.key.sequence ?? ''
    const seqNote = /[\x00-\x1b\x7f]/.test(seq) ? ` seq=${hexPreview(seq)}` : ''
    traceNote(`key name=${JSON.stringify(item.key.name)} ctrl=${String(item.key.ctrl)}${seqNote}`)
    try { handlers.key?.(item.key) } catch { /* same: input must never take the session down */ }
  }
  // Split multi-byte characters across chunks would mangle without a decoder:
  // Buffer('😀').subarray(0,2).toString() is 腿, never recoverable. StringDecoder
  // holds the partial bytes until the rest arrives.
  const decoder = new StringDecoder('utf8')
  const emit = (text: string): void => {
    const { events, pending: rest } = decodeInput(text)
    // The trace is an opt-in debug file, but it must never become a SECRET
    // FILE: `input.data hex=…` used to log every chunk's content, so a pasted
    // API key or a typed model id landed in ~/.wednesday/trace.log as hex.
    // Escape sequences are what input debugging actually needs — printable
    // text logs its LENGTH only.
    const safe = (value: string): string =>
      /[\x00-\x1b\x7f]/.test(value) ? hexPreview(value) : `printable n=${value.length}`
    traceNote(`input.data ${safe(text)}`)
    for (let i = 0; i < events.length; i++) {
      if (detached) {
        // The owner that was reading this chunk is gone; the rest belongs to
        // the NEXT owner, not to the void.
        for (let j = i; j < events.length; j++) carriedInput.push(events[j]!)
        break
      }
      deliver(events[i]!)
    }
    pending = rest
    if (flush) { clearTimeout(flush); flush = null }
    if (pending) {
      // A split escape arriving slowly (slow ssh) needs time. 40ms raced the
      // second half, which then typed literally. 200ms still feels instant for
      // a lone Esc and survives a slow link. Non-ESC leftovers are swallowed,
      // never typed: typing a partial sequence is always wrong.
      //
      // An OPEN bracketed paste is the exception: it can legitimately take
      // longer than 200ms to arrive over ssh, and dropping its head would
      // either lose the paste or leave the closing marker to type as text.
      // Give it ten seconds, then drop it the same deliberate way.
      const openPaste = pending.startsWith('\x1b[200~')
      if (pending !== '\x1b') traceNote(`input.pending hex=${hexPreview(pending)} (dropped in ${openPaste ? 10000 : 200}ms if nothing completes it)`)
      flush = setTimeout(() => {
        flush = null
        const leftover = pending
        pending = ''
        if (leftover === '\x1b') {
          try { handlers.key?.({ name: 'escape', ctrl: false, meta: false, sequence: '\x1b' }) } catch { /* ignore */ }
        } else if (leftover) {
          // Worth a line: this is input being EATEN on purpose, and it is the
          // one legitimate way a key can vanish without the handler seeing it.
          traceNote(`input.pending-dropped hex=${hexPreview(leftover)}`)
        }
      }, openPaste ? 10_000 : 200)
      if (typeof flush.unref === 'function') flush.unref()
    }
  }
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
    // A lone ESC held as pending is a completed Esc press, not the start of
    // Alt: Alt arrives in the SAME chunk (one read), while a held ESC means
    // the key was pressed and released before this chunk arrived. Concatenating
    // them would fuse Esc+typing into Alt and swallow the first character.
    if (pending === '\x1b') {
      if (flush) { clearTimeout(flush); flush = null }
      pending = ''
      try { handlers.key?.({ name: 'escape', ctrl: false, meta: false, sequence: '\x1b' }) } catch { /* ignore */ }
      emit(text)
      return
    }
    emit(pending + text)
  }
  input.on('data', onData)
  if (input.isTTY) input.resume()
  // Armed here, not in Screen.enter(): attachInput knows whether the caller
  // actually wants pointer events, and detach() is the one place that cannot
  // leak them. The modes go to the caller's stream (the one the frame is drawn
  // on), and only on a TTY, so piped output stays clean.
  const wantsMouse = typeof handlers.mouse === 'function'
  const stream = handlers.out ?? stdout
  if (wantsMouse && stream.isTTY) {
    try { stream.write(mouseArm(handlers.hover === true)) } catch { /* ignore */ }
  }
  // Replay anything an earlier prompt left behind. In a microtask: this
  // function is still mid-call, and the caller's `stop` binding (what a
  // replayed return calls) is only assigned once attachInput returns.
  if (carriedInput.length) {
    const queued = carriedInput.splice(0, carriedInput.length)
    queueMicrotask(() => {
      for (let i = 0; i < queued.length; i++) {
        if (detached) {
          for (let j = i; j < queued.length; j++) carriedInput.push(queued[j]!)
          return
        }
        deliver(queued[i]!)
      }
    })
  }
  let disarmed = false
  return () => {
    traceNote('input.detach')
    detached = true
    input.removeListener('data', onData)
    if (flush) clearTimeout(flush)
    if (wantsMouse && !disarmed && stream.isTTY) {
      disarmed = true
      try { stream.write(mouseDisarm()) } catch { /* ignore */ }
    }
    // Pause, do not un-raw. Keystrokes that arrive while no prompt owns the
    // keyboard stay in the stream and reach the next listener; flipping the
    // mode here is what used to destroy them.
    try { input.pause() } catch { /* already closed */ }
  }
}

/** Visible width (ANSI escapes are zero-width). Layout math must use this. */
/**
 * Usable terminal size. Never larger than the real terminal: the old floors
 * (`Math.max(12, height)`, `Math.max(24, width)`) laid a 24x10 window out as
 * 24x12, so the frame overflowed its height and the terminal scrolled the page
 * out from under the operator. A split pane is a normal way to work, not an
 * error to be corrected by overdrawing.
 */
function fitWidth(width: number): number {
  // The 80 fallback is for an UNKNOWN size - a non-TTY, a pipe, a stub. It must
  // not be used for a terminal that is genuinely tiny, because laying out 80
  // columns into a 3-column window paints far more cells than the terminal has,
  // and a terminal that is handed more cells than it can show answers by
  // scrolling: the page jumps and every row is wrong.
  //
  // That is not hypothetical. Dragging a window edge reports a run of tiny
  // intermediate sizes (1x1, 2x2, 3xN) before the final one, so a plain resize
  // briefly asked for an 80x24 frame in a one-column window.
  if (!Number.isFinite(width)) return 80
  return Math.max(1, Math.floor(width))
}
function fitHeight(height: number): number {
  if (!Number.isFinite(height)) return 24
  return Math.max(1, Math.floor(height))
}

/**
 * DISPLAY COLUMNS, not code units.
 *
 * The old measurement was `text.replace(ANSI_RE, '').length` - the number of
 * UTF-16 code units - which is the right answer only for ASCII. Everything else
 * is wrong, in both directions, and both directions break the layout:
 *
 *   CJK          2 columns, counted 1  -> the frame is up to 18 columns too
 *                                        wide at 40, so it WRAPS and the border
 *                                        and the Context rail are torn off
 *   combining    0 columns, counted 1  -> text is clipped early and panels are
 *                                        padded short, so corners misalign
 *   emoji (VS16) 2 columns, counted 1  -> same overflow, one column at a time
 *
 * Measured before this change: at 40 columns a single Chinese line produced a
 * row the terminal draws 18 columns wider than the window.
 *
 * East Asian **Ambiguous** characters - which includes every box-drawing glyph
 * this app draws with, plus the brand marks - are counted as 1. That is right
 * for a western terminal and wrong for one configured for CJK, where they
 * render double-width. Detecting that needs a capability query this app does not
 * have; guessing would break the layout that currently works, so it stays at 1
 * and is recorded as a known limitation rather than silently mishandled.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo, initial consonants
  // U+26A1 HIGH VOLTAGE. Emoji-presentation, so ConPTY and every modern
  // terminal draw it TWO cells wide. Measured through a real ConPTY at 40
  // columns: a padded row containing it wrapped and shifted the whole frame by
  // one line. The rest of the 0x2600 block (☤ ☠ ❦ ✿ ◉ ✧ ❀ ☞ ☾ ✦ ✖) is
  // text-presentation and measured 1, so it stays out of this table. The entry
  // MUST stay in ascending order: `inRanges` is a binary search, and an
  // out-of-order row silently measures the character as 1.
  [0x26a1, 0x26a1],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana through CJK compatibility
  [0x3400, 0x4dbf], // CJK unified, extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables and radicals
  [0xa960, 0xa97f], // Hangul Jamo, extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth ASCII variants
  [0xffe0, 0xffe6], // fullwidth currency signs
  [0x1f300, 0x1f5ff], // pictographs, emoticons, ornamental dingbats
  [0x1f600, 0x1f64f], // emoticons, transport and map
  [0x1f680, 0x1f6ff], // transport and map, supplemental
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x20000, 0x2fffd], // CJK unified, extensions B and later
  [0x30000, 0x3fffd], // CJK unified, extension G and later
]

/** Zero-width: combining marks, joiners, and the text-presentation selector. */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489], // Cyrillic combining
  [0x0591, 0x05bd], // Hebrew points
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x0610, 0x061a], // Arabic marks
  [0x064b, 0x065f], // Arabic marks
  [0x0670, 0x0670],
  [0x06d6, 0x06dc], // Arabic marks
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0e31, 0x0e31], // Thai vowel signs
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x200b, 0x200f], // zero-width space/join, ZWJ, bidi marks
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0x1ab0, 0x1aff], // combining diacritical marks, extended
  [0x1dc0, 0x1dff], // combining diacritical marks, supplement
  [0x20e1, 0x20e1], // combining enclosing marks
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = ranges[mid]!
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

/** Columns one code point occupies on its own. */
export function columnOf(cp: number): number {
  if (cp < 0x0300) return 1 // the whole Latin/Greek/box-drawing bulk is single-width
  if (inRanges(cp, ZERO_RANGES)) return 0
  if (inRanges(cp, WIDE_RANGES)) return 2
  return 1
}

/**
 * Columns of a plain string (no escapes), handling the two cases a per-character
 * table gets wrong on its own:
 *
 * - a **ZWJ sequence** (`👨‍👩‍👧`) is one glyph, not three: the joiner is zero-width
 *   and everything it joins adds nothing;
 * - **variation selector 16** promotes the character before it to emoji
 *   presentation, which is one column wider.
 */
function columnsOf(plain: string): number {
  let total = 0
  let joined = false
  let lastWidth = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x200d) { joined = true; lastWidth = 0; continue }
    if (cp === 0xfe0f) { if (lastWidth === 1) total += 1; continue }
    if (cp === 0xfe0e) { continue }
    const w = columnOf(cp)
    if (!joined) total += w
    lastWidth = w
    joined = false
  }
  return total
}

/**
 * Split a plain string at a column offset, never inside a wide character.
 *
 * Returns the string index to cut at. A double-width character that would
 * straddle the boundary is left on the far side rather than split into a half
 * glyph - a sliced emoji is a replacement character, which is worse than a
 * slightly short line.
 */
function indexAtColumn(plain: string, target: number): number {
  if (target <= 0) return 0
  let col = 0
  let index = 0
  while (index < plain.length) {
    const cp = plain.codePointAt(index)!
    const ch = String.fromCodePoint(cp)
    const w = columnOf(cp)
    if (col + w > target) break
    col += w
    index += ch.length
    if (col >= target) break
  }
  return index
}

/**
 * One terminal escape sequence: a CSI (`ESC [ ... final`) or an OSC
 * (`ESC ] ... BEL` / `ESC ] ... ESC \`).
 *
 * The walk that marks a search hit has to recognise these, because they are
 * zero-width: a row that is coloured and hyperlinked still has the same
 * columns as the plain text under it.
 */
const ANSI_SEQ_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/

/**
 * Mark a PLAIN-TEXT offset range inside a styled row.
 *
 * The transcript search matches the text the operator READS, so its offsets
 * are into the ANSI-stripped row. The row itself may still carry the
 * transcript's colour and its OSC 8 hyperlinks, so the walk counts two
 * things at once — the position in the plain text and the display column —
 * and copies every escape through untouched.
 *
 * The closing sequence resets ONLY the attribute it set (the background, or
 * the reverse), so the row's own colour survives the splice.
 *
 * @param styled the row as it will be drawn
 * @param start start offset in the PLAIN text
 * @param end end offset in the plain text (exclusive)
 * @param open the sequence that starts the mark
 * @param close the sequence that ends it
 */
export function highlightPlainRange(
  styled: string,
  start: number,
  end: number,
  open: string,
  close: string,
): string {
  if (end <= start) return styled
  let out = ''
  let plain = 0
  let opened = false
  let closed = false
  let i = 0
  while (i < styled.length) {
    if (styled.charCodeAt(i) === 0x1b) {
      const match = ANSI_SEQ_RE.exec(styled.slice(i))
      if (match) {
        out += match[0]
        i += match[0].length
        continue
      }
    }
    const cp = styled.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    if (!opened && plain >= start) { out += open; opened = true }
    if (opened && !closed && plain >= end) { out += close; closed = true }
    out += ch
    plain++
    i += ch.length
  }
  if (!opened) return styled
  if (!closed) out += close
  return out
}

/** Visible width in terminal columns (ANSI escapes are zero-width). */
export function visibleWidth(text: string): number {
  return columnsOf(text.replace(ANSI_RE, ''))
}

/** Pad to `width` VISIBLE columns, keeping escapes intact. */
export function padVisible(text: string, width: number): string {
  const visible = visibleWidth(text)
  return visible >= width ? text : text + ' '.repeat(width - visible)
}

/**
 * Clip to `width` VISIBLE COLUMNS, keeping escapes balanced.
 *
 * Columns, not characters: clipping 20 code units of Chinese used to hand the
 * terminal 36 columns of text, which wrapped the frame and tore the border off
 * the row. A double-width character that does not fit in what remains is left
 * out entirely rather than split.
 */
export function clipVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  let out = ''
  let seen = 0
  const parts = text.split(/(\x1b\[[0-9;]*m)/)
  for (const part of parts) {
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const ch of part) {
      const w = columnOf(ch.codePointAt(0)!)
      if (seen + w > width) { seen = width; break }
      out += ch
      seen += w
      if (seen >= width) break
    }
    if (seen >= width) break
  }
  // Truncation can cut before the closing reset, leaving color to bleed into
  // whatever is drawn next. Re-assert a reset when we clipped styled text.
  if (!out.endsWith('\x1b[0m')) out += '\x1b[0m'
  return out
}

/**
 * Slice by VISIBLE COLUMNS, keeping escape sequences whole and attached.
 *
 * The overlay geometry measures the plate and the frame in columns and then
 * slices both with this, so a disagreement between "columns" and "characters"
 * here shifts the plate sideways on any non-ASCII row.
 */
export function sliceVisible(text: string, from: number, to = Number.MAX_SAFE_INTEGER): string {
  const parts = text.split(/(\x1b\[[0-9;]*m)/)
  let out = ''
  let seen = 0
  let done = false
  for (const part of parts) {
    if (done) break
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const ch of part) {
      const w = columnOf(ch.codePointAt(0)!)
      // A wide character straddling `from` is dropped whole: half of a glyph is
      // a replacement character on screen.
      if (seen + w > to) { done = true; break }
      if (seen >= from) out += ch
      seen += w
      if (seen >= to) { done = true; break }
    }
  }
  return out
}

/**
 * Decode a captured frame stream into its painted rows (SGR codes kept).
 *
 * The live renderer addresses rows absolutely — `ESC[<row>;1H` per row, no
 * newlines — and repaints are INCREMENTAL: a full paint is followed by row
 * patches (cursor row, scanner tick), each in its own chunk. A frame reader
 * must therefore replay the WHOLE stream and let later writes replace
 * earlier ones, exactly like a terminal. preview.ts and small-preview.ts
 * both split the stream on '\n' and took the last chunk, so after the
 * renderer moved to per-row addressing the design board silently collapsed
 * every live frame into one row (or into whatever single row the last patch
 * happened to touch) and drew blank boxes. This is the one reader, next to
 * the format it decodes, used by every frame consumer.
 *
 * Mid-row moves (`ESC[<row>;<col>H`, col > 1 — the composer caret) end the
 * current row's text and their own text is dropped: in this renderer they
 * only ever position the cursor, and gluing them onto the row tail would
 * print escape debris into the frame. `ESC[J` clears are inert here for the
 * same reason replay.ts keeps them inert — this app writes explicit blanks.
 *
 * A chunk that carries no addressing at all (composite frames built from
 * `lastFrame`, direct string frames) already has real newlines and is
 * returned line-split, so callers do not need to know which format they got.
 */
export function frameRows(chunk: string): string[] {
  if (!chunk) return []
  const re = /\x1b\[(\d+);(\d+)H/g
  if (!re.test(chunk)) return chunk.split('\n')
  re.lastIndex = 0
  const rows: string[] = []
  let rowOf: number | null = null
  let at = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(chunk)) !== null) {
    if (rowOf !== null) rows[rowOf - 1] = chunk.slice(at, m.index)
    if (m[2] === '1') {
      rowOf = Number(m[1])
      at = m.index + m[0].length
    } else {
      rowOf = null
    }
  }
  if (rowOf !== null) rows[rowOf - 1] = chunk.slice(at)
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = ''
  return rows
}

/**
 * Extended surface tokens (opencode theme-structure grammar: panel
 * backgrounds, active borders, diff wash, links). 256-color codes so no
 * terminal capability detection is needed.
 */
export function panelBg(text: string): string {
  return `\x1b[48;5;${THEME.surface}m${text}\x1b[0m`
}

/**
 * The DEPTH system: rails that tell the eye which way the light falls.
 *
 * Every panel used one border colour on all four edges, so nothing read as
 * raised — a box with no light direction is a printed rectangle, and that is
 * what "our theme is good but it could be much better" looks like from the
 * outside. Three steps, applied consistently:
 *
 *   top rail + top corners   `edgeTop`     lit
 *   verticals + side corners `edgeSide`    body
 *   bottom rail + bottom c.  `edgeBottom`  cast
 *
 * The CHARACTERS are unchanged (`╭ ─ │ ╰ ╯`), so every geometry invariant the
 * audit holds still holds; only the colour of each edge moves. That matters:
 * depth is a colour decision, not a layout one.
 */
export function bevel(text: string, edge: 'top' | 'side' | 'bottom'): string {
  const code = edge === 'top' ? THEME.edgeTop : edge === 'side' ? THEME.edgeSide : THEME.edgeBottom
  return `\x1b[38;5;${code}m${text}\x1b[0m`
}

/**
 * The violet ramp, deep fill -> Nevermore -> lavender -> lit lilac.
 *
 * One family, nine stops, arranged symmetrically: a rule built from it is dark
 * at both ends and lit in the middle, which is how a HUD line reads as a beam
 * rather than as a box character. Every chromatic stop is in the house hue, so
 * the "purple and black" rule holds cell for cell.
 */
const GLOW_RAMP = [54, 57, 98, 141, 183, 141, 98, 57, 54] as const

/**
 * A horizontal rule with a symmetric violet glow.
 *
 * The CHARACTERS are exactly `glyph.repeat(width)` — colour only. That matters:
 * the composer's rules are asserted as `/^─+$/` after stripping, and a rule
 * that changed its characters would break every layout invariant the audit
 * holds. Nine SGR runs instead of one per cell keeps the paint cheap.
 */
export function glowRule(width: number, glyph = '─'): string {
  const n = Math.max(0, Math.floor(width))
  if (n <= 0) return ''
  const stops = GLOW_RAMP.length
  let out = ''
  for (let s = 0; s < stops; s++) {
    const from = Math.round((s * n) / stops)
    const to = Math.round(((s + 1) * n) / stops)
    if (to <= from) continue
    out += `\x1b[38;5;${GLOW_RAMP[s]}m${glyph.repeat(to - from)}`
  }
  return `${out}\x1b[0m`
}

/**
 * A HUD section plate: brand star, the group in caps, then a violet rail to
 * the column edge.
 *
 * One function so the home panel, the pager and every paged report cannot
 * drift into three versions of the same heading. The rail uses the body edge,
 * never the lit one, so a page full of headings still has one focus colour.
 */
export function hudPlate(title: string, width: number): string {
  const label = title.trim().toUpperCase()
  if (!label) return bevel('─'.repeat(Math.max(0, Math.floor(width))), 'side')
  const base = `✦ ${label}`
  const room = Math.max(0, Math.floor(width) - visibleWidth(base) - 1)
  return `${tone('cyan', '✦')} ${tone('bold', label)} ${bevel('─'.repeat(room), 'side')}`
}

/** Task status → tone, shared with the shaped `/tasks` view's semantics. */
const STATUS_TONE: Record<string, MsgTone> = {
  completed: 'green', done: 'green', passed: 'green',
  failed: 'red', error: 'red', blocked: 'red',
  queued: 'yellow', running: 'yellow', pending: 'yellow', repairing: 'yellow',
}

/**
 * Give one line of a paged report the HUD grammar: plate headings, a lit
 * label before a receding value, and tone carried by the outcome mark.
 *
 * Applied at the PAGER, not in each generator, because `status.ts`,
 * `doctor.ts` and the shaped views are also printed by `--classic` and by the
 * CLI where ANSI must not appear. The pager is the one place that knows it is
 * painting a screen.
 *
 * Lines that already carry SGR or a URL are left alone: links are wrapped
 * BEFORE styling elsewhere, and re-styling a row with an OSC 8 wrapper is how
 * the URL once got a reset byte inside its parameter.
 */
export function hudLine(text: string, width: number): string {
  if (!text || text.includes('\x1b') || /https?:\/\//i.test(text)) return text
  if (/^Wednesday (Status|Doctor)$/i.test(text.trim())) {
    return hudPlate(text.trim().replace(/^Wednesday\s+/i, ''), width)
  }
  const section = /^\s*──\s+(.+?)\s+──\s*$/.exec(text)
  if (section) return hudPlate(section[1]!, width)
  if (/^status\s+id\s+objective\b/i.test(text)) return tone('dim', clipVisible(text.toUpperCase(), width))
  // `/tasks` rows: the status word is the meaning, so it takes the tone and
  // the objective stays plain. Two spaces separate it from the id column.
  const status = /^(completed|failed|blocked|running|queued|pending|repairing|done|passed)\b/i.exec(text)?.[1]
  if (status) return `${tone(STATUS_TONE[status.toLowerCase()] ?? 'plain', status)}${text.slice(status.length)}`
  // `Label: value` rows: the label is lit, the value recedes (home panel rule).
  const at = text.indexOf(': ')
  if (at > 0 && at <= 24 && /^[A-Za-z][A-Za-z0-9 _/.-]*$/.test(text.slice(0, at))) {
    return `${tone('cyan', text.slice(0, at))}${tone('dim', text.slice(at))}`
  }
  if (/^✔/.test(text)) return tone('green', text)
  if (/^[✘✖]/.test(text)) return tone('red', text)
  if (/^[⚠▲]/.test(text)) return tone('yellow', text)
  if (/FAIL|MISSING|not set/i.test(text)) return tone('red', text)
  if (/^WARN|degraded/i.test(text)) return tone('yellow', text)
  return text
}

/**
 * Cast shadow for a FLOATING panel: one row of light-shade texture, offset one
 * column right and one row down from the panel it belongs to.
 *
 * Terminals have no alpha and the 256 ramp bottoms out at the page's own ink,
 * so a real drop shadow cannot be drawn darker than the background. The
 * honest approximation is a faint texture one step off the page — which is what
 * terminal UIs do, and it reads as "this is above the page" without pretending
 * to be a gradient.
 *
 * Returns '' when there is no room below (a plate at the bottom edge gets no
 * shadow rather than one painted off-screen).
 */
export function shadowRow(width: number): string {
  if (width <= 0) return ''
  return `\x1b[38;5;${THEME.shadow}m${'░'.repeat(width)}\x1b[0m`
}

/**
 * One cell of vertical shadow, for the right edge of a floating panel.
 *
 * A single cell, not a run: every shadow cell is addressed individually, so a
 * multi-row string here would paint them all on ONE row.
 */
export function shadowColumn(): string {
  return `\x1b[38;5;${THEME.shadow}m▒\x1b[0m`
}

/**
 * Smallest terminal that can show a bordered plate: two rails, a space and a
 * character of content on each side (`│ x │`), plus the rails' own columns.
 */
export const MIN_PLATE_COLS = 5
/** Chrome: top rail, title, query, spacer, hint, bottom rail. */
export const MIN_PLATE_ROWS = 6

/** One addressed cell write: 0-based row, 1-based column. */
interface Patch {
  readonly row: number
  readonly col: number
  readonly text: string
}

export function activeRail(text: string): string {
  return `\x1b[38;5;${THEME.accent}m${text}\x1b[0m`
}

export function link(text: string): string {
  return `\x1b[4m\x1b[38;5;${THEME.glass}m${text}\x1b[0m`
}

/** Diff row with background wash (added green / removed red / hunk panel). */
export function diffRow(kind: DiffKind, text: string): string {
  if (kind === 'add') return `\x1b[38;5;${THEME.sage}m\x1b[48;5;${THEME.diffAdd}m${text}\x1b[0m`
  if (kind === 'del') return `\x1b[38;5;${THEME.bloodInk}m\x1b[48;5;${THEME.diffDel}m${text}\x1b[0m`
  if (kind === 'hunk') return `\x1b[38;5;${THEME.accent}m\x1b[48;5;${THEME.surface}m${text}\x1b[0m`
  return tone('dim', text)
}

/**
 * What a Factory event knows beyond its type: which tool a seat reached for,
 * and the one-word outcome worth putting on the row.
 */
export interface EventDetail {
  /** Tool name as the factory reports it (`verification.test`). */
  tool?: string
  /** Short status: `PASS`, `FAIL`, `attempt 2`. */
  note?: string
  /**
   * What the tool touched: the command it ran, the files it wrote, the
   * findings it raised. The row used to say only `verification.test · PASS`,
   * which told the operator that something was verified and never what or
   * where — the detail is the difference between a progress log and a receipt.
   */
  detail?: string
  /**
   * The seat's own verdict, verbatim (`failed`, `aborted`). `agent.completed`
   * carries the outcome of a seat that may have DIED, so the dock needs the
   * raw status, not only the rendered note.
   */
  status?: string
  /**
   * The live activity of a seat: what it is doing while it does it. Present
   * on `agent.activity` events only.
   */
  activity?: AgentActivity
}

/**
 * One tool row, optionally folded.
 *
 * The factory names tools `family.action` (`verification.test`,
 * `opencode.coding-agent`), so the family becomes the row's subject and the
 * rest the action — the same aligned column `eventMessage` uses for events.
 * That is the point: `┊ ☞ verification test` names what ran, where the old row
 * said `tool called` and pushed the name into the crew dock alone.
 *
 * A run of identical calls folds into one row (`test ×6`), keeping the failure
 * count, because six verification rows of which one failed is one fact and six
 * rows of noise. The operator asked for the summary; the full trail is still
 * in `/events <id>`.
 */
export function toolRow(
  tool: string,
  role: string | undefined,
  count = 1,
  failed = 0,
  note?: string,
  detailText?: string,
): ScreenMessage {
  const [subject = 'tool', ...rest] = tool.split('.')
  const action = rest.join('.') || 'called'
  const fold = count > 1 ? ` ×${count}` : ''
  // One command, clipped: a 300-character shell line must not own the frame.
  // The full text stays in the task record and in `/events`.
  const what = detailText ? ` · ${detailText.length > 44 ? `${detailText.slice(0, 43)}…` : detailText}` : ''
  const tail = failed > 0 ? ` · ${failed} FAIL` : note ? ` · ${note}` : ''
  return {
    text: `┊ ${glyph('hand')} ${subject.padEnd(12)} ${action}${fold}${role ? ` · ${role}` : ''}${what}${tail}`,
    tone: failed > 0 ? 'red' : MARKS.hand.tone,
  }
}

/** The state of a run of identical tool calls (see `foldTool`). */
export interface ToolFold {
  tool: string
  role: string
  count: number
  failed: number
  note?: string
  /** What the calls touched; part of the identity, so different commands never fold. */
  detail?: string
}

/**
 * Decide whether a tool call folds into the run above it.
 *
 * Pure: the CALLER owns where the row lives (the transcript tail) and whether
 * that row is still the tail — this owns only whether the call merges and what
 * the merged row says. Keeping the two apart is what makes the rule testable
 * without a screen: fold the same tool for the same seat, not otherwise.
 */
export function foldTool(
  prev: ToolFold | null,
  tool: string,
  role: string,
  note?: string,
  detailText?: string,
): { fold: ToolFold; row: ScreenMessage; merged: boolean } {
  const failed = note === 'FAIL' ? 1 : 0
  // Identity is (tool, seat, WHAT IT TOUCHED). Two different test commands are
  // two facts, and folding them into `verification.test ×2` would hide the
  // command the operator needs to judge the run.
  if (prev && prev.tool === tool && prev.role === role && prev.detail === detailText) {
    const fold: ToolFold = { ...prev, count: prev.count + 1, failed: prev.failed + failed }
    return { fold, row: toolRow(tool, role, fold.count, fold.failed, prev.note, prev.detail), merged: true }
  }
  const fold: ToolFold = { tool, role, count: 1, failed, note, detail: detailText }
  return { fold, row: toolRow(tool, role, 1, failed, note, detailText), merged: false }
}

/** Map a Factory event to a screen message (plain text + tone). */
export function eventMessage(type: string, role?: string, detail?: EventDetail): ScreenMessage {
  // Hermes' tool-row grammar: `┊ {mark} {subject:12} {action} · {detail}`. The
  // prefix is what makes a stream read as machine work rather than prose, and
  // the aligned subject column lets a planner/coder/verifier run be scanned
  // vertically. The decode key (./marks.ts) still owns mark and tone.
  //
  // A tool call is the one event whose SUBJECT is worth naming, so it takes its
  // subject from the reported tool rather than from the event type. Without a
  // tool name it degrades to the old `tool called` row rather than inventing
  // one: the event bus is authoritative, this renderer is not.
  if (type === 'tool.called' && detail?.tool) {
    return toolRow(detail.tool, role, 1, detail.note === 'FAIL' ? 1 : 0, detail.note, detail.detail)
  }
  // Lifecycle rows carry the pipeline stage, not the event's subject: `agent
  // started · architect` said who arrived but never where in the run we were.
  // `1 plan   working · architect` answers both at a glance, and the same row
  // flipping to `done` / `PASS` / `FAILED` is the run's progress bar.
  const lifecycle = /^(agent|verification|review|repair)\.(started|completed|failed)$/.test(type)
  const stage = lifecycle ? stageOf(role, type) : null
  if (stage) {
    const note = (detail?.note ?? '').toUpperCase()
    const failed = type.endsWith('.failed') || note === 'FAIL'
    const aborted = note === 'ABORT'
    const passed = note === 'PASS' || note === 'PASSED'
    const done = type.endsWith('.completed') || passed
    // Keep the decode key's own mark for the event (repair is the twinkle,
    // verification the eye); only the verdict overrides it. An ABORTED seat is
    // neither green nor red: it is a stop, so it wears the dagger.
    const markName: GlyphName = failed ? 'severed' : aborted ? 'dagger' : done ? 'floret' : (markFor(type) ?? 'bloom')
    const state = failed ? 'FAILED' : aborted ? 'ABORTED' : passed ? 'PASS' : done ? 'done' : 'working'
    const seat = role ? ` · ${role}` : ''
    const what = detail?.detail ? ` · ${detail.detail}` : ''
    return {
      text: `┊ ${glyph(markName)} ${`${stage.index} ${stage.stage}`.padEnd(12)} ${state}${seat}${what}`,
      tone: MARKS[markName].tone,
    }
  }
  const [subject = type, ...rest] = type.split('.')
  const action = rest.join('.') || 'event'
  const named = type === 'tool.called' ? 'hand' : markFor(type)
  const mark = named ? glyph(named) : '·'
  const note = detail?.note ? ` · ${detail.note}` : ''
  const what = detail?.detail ? ` · ${detail.detail}` : ''
  const text = `┊ ${mark} ${subject.padEnd(12)} ${action}${role ? ` · ${role}` : ''}${what}${note}`
  return { text, tone: named ? MARKS[named].tone : 'plain' }
}

/** How much of a live activity tail a row carries. */
const LIVE_TAIL = 90

/** The tail of a live text, on one line: the newest words, never a wall. */
export function liveTail(text: string, room = LIVE_TAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= room) return flat
  return `…${flat.slice(-room)}`
}

/**
 * One activity row: what a seat is doing RIGHT NOW.
 *
 * The lifecycle rows say a seat started and that it finished; between them the
 * run was a silence, and the operator could not tell a working seat from a
 * dead one (operator, 2026-11-04: "stream the reasoning, the file changes,
 * the commands — so I can see what is happening").
 *
 * Reasoning and talk share ONE row per seat and are rewritten in place — a
 * transcript with a row per token is a wall, not a window. A tool call and a
 * file write are facts of their own and get their own rows.
 */
export function activityMessage(
  kind: AgentActivityKind,
  role: string | undefined,
  activity: AgentActivity,
  verb?: string,
): ScreenMessage {
  const stage = stageOf(role)
  const subject = stage
    ? `${stage.index} ${stage.stage}`.padEnd(12)
    : 'activity'.padEnd(12)
  const seat = role ? ` · ${role}` : ''
  if (kind === 'reasoning' || kind === 'text') {
    const markName: GlyphName = kind === 'reasoning' ? 'twinkle' : 'rose'
    const word = verb ?? (kind === 'reasoning' ? 'thinking' : 'saying')
    const tail = liveTail(activity.text ?? '')
    return {
      text: `┊ ${glyph(markName)} ${subject} ${word}${seat}${tail ? ` · ${tail}` : ''}`,
      tone: MARKS[markName].tone,
    }
  }
  if (kind === 'tool') {
    const what = activity.tool ?? 'tool'
    const detail = activity.detail ? ` · ${activity.detail}` : ''
    const status = activity.status && activity.status !== 'completed' ? ` · ${activity.status}` : ''
    return {
      text: `┊ ${glyph('hand')} ${subject} ${what}${seat}${detail}${status}`,
      tone: MARKS.hand.tone,
    }
  }
  // A file the seat wrote, changed or removed.
  const what = activity.status === 'deleted'
    ? 'deleted'
    : activity.status === 'created'
      ? 'wrote'
      : 'changed'
  return {
    text: `┊ ${glyph('moon')} ${subject} ${what}${seat} · ${activity.detail ?? ''}`,
    tone: MARKS.moon.tone,
  }
}

/**
 * The ONE live row of a chat turn.
 *
 * The chat used to push a `✻ thinking` header and then a row per reasoning
 * line, with the answer arriving as rows after it. Three defects in one
 * grammar (operator report, 2026-11-04: "why is there thinking also at the
 * bottom? are both the same or is the bottom one fake?"):
 *
 *  1. a WALL instead of a window — one row per reasoning line, and the
 *     reasoning of a small model buried the answer;
 *  2. the header said `thinking` FOREVER — after an abort the transcript
 *     still read "thinking", which is a lie: nothing was thinking;
 *  3. the answer and the reasoning were two different kinds of row, so the
 *     operator could not tell which one was still moving.
 *
 * Now a chat turn is ONE row, rewritten in place, in the same vocabulary the
 * build path uses (`thinking` -> `thought`, the seat's receipt):
 *
 *     ✻ thinking · the newest words of the reasoning      (live)
 *     ✻ thought · the reasoning                           (the answer joins)
 *     ✳ the answer
 *
 * and a turn that ends badly says `stopped` instead of `thinking`.
 *
 * The reasoning is carried as a TAIL (the newest words) because a small
 * model's reasoning can be longer than the answer; the answer is carried in
 * FULL, because the answer is the deliverable.
 */
export function chatLiveRow(
  reasoning: string,
  answer: string,
  phase: 'reasoning' | 'answering',
  outcome: 'ok' | 'failed' = 'ok',
  rate?: { tokensPerSecond: number },
): ScreenMessage {
  const tail = liveTail(reasoning)
  // THE LIVE RATE (2026-11-07). OpenCode's footer carries a tokens/sec
  // readout, and for a product built on small open models it is the most
  // honest engagement signal there is: a spinner says "something is
  // happening", a rate says "the model is producing 34 tokens a second".
  // It is an ESTIMATE (the factory has no tokenizer for the served model),
  // so it is marked as one wherever it is shown.
  const speed = rate && rate.tokensPerSecond >= 1 ? ` · ${rate.tokensPerSecond} tok/s (est)` : ''
  const head = phase === 'answering'
    ? `✻ thought${tail ? ` · ${tail}` : ''}${speed}`
    : outcome === 'failed'
      ? `✻ stopped${tail ? ` · ${tail}` : ''}${speed}`
      : `✻ thinking${tail ? ` · ${tail}` : ''}${speed}`
  const body = answer ? `${glyph('rose')} ${answer}` : ''
  // A turn that was cut off mid-answer says so on its own line: a partial
  // answer that looks complete is worse than no answer.
  const cut = outcome === 'failed' && phase === 'answering' ? '✻ stopped — cut off here' : ''
  const text = [head, body, cut].filter(Boolean).join('\n')
  // While only the thought is on screen the row is dim (a passing thought);
  // once the answer is there the row is plain, because the answer is what
  // the operator came to read.
  return { text, tone: body ? 'plain' : 'dim' }
}

/**
 * Hermes' response panel, drawn at render width:
 *
 *     ╭─ ✦ Wednesday ───────────────────────────╮
 *     │ the answer, wrapped, two cells in        │
 *     ╰──────────────────────────────────────────╯
 *
 * The panel is a frame around an ANSWER, not around every event: work stays in
 * `┊` rows above it, the way Hermes keeps tools in the transcript and frames
 * only what the agent is telling you.
 */
export function answerPanel(
  panel: { title: string; lines: Array<{ text: string; tone: MsgTone }> },
  width: number,
): ScreenMessage[] {
  const w = Math.max(20, width)
  const inner = Math.max(4, w - 4)
  // The house mark, not Hermes' crook: an answer panel and the home page are
  // the same product, and one brand glyph per surface is the rule.
  const label = `─ ✦ ${panel.title} `
  const top = `╭${label}${'─'.repeat(Math.max(0, w - 2 - visibleWidth(label)))}╮`
  const out: ScreenMessage[] = [{ text: top, tone: 'cyan' }]
  for (const line of panel.lines) {
    const plain = line.text.replace(ANSI_RE, '')
    const parts = plain ? wrap(plain, inner) : ['']
    for (const part of parts) out.push({ text: `│ ${padVisible(clipVisible(part, inner), inner)} │`, tone: line.tone })
  }
  out.push({ text: `╰${'─'.repeat(Math.max(0, w - 2))}╯`, tone: 'cyan' })
  return out
}

/**
 * Break a logical line into visual rows of at most `width` DISPLAY COLUMNS.
 *
 * Two things this has to get right, and both were wrong at different times:
 *
 * 1. **Columns, not characters.** `String.slice(0, width)` cut 40 code units,
 *    which is 40 columns of English and 80 columns of Chinese. An ideographic
 *    line was therefore never wrapped and simply overflowed the frame.
 *
 * 2. **One pass.** The intermediate version measured with `visibleWidth`, which
 *    walks the whole string - inside a loop that consumed `width` columns at a
 *    time. That is quadratic: a 1 MB paste took **145 SECONDS** to lay out, and
 *    one keystroke with a 100 KB draft present took **1.45 s**. Not slow -
 *    unresponsive, and reachable by pasting a file.
 *
 * So the column count is CARRIED as the line is consumed rather than recomputed.
 * The word-boundary preference is unchanged: the last space in the current line
 * is remembered, and a cut is only taken at a space if it is past 40% of the
 * width, so a wrap never strands a widow fragment.
 */
/**
 * Break a logical line into visual rows of at most `width` DISPLAY COLUMNS.
 *
 * Exported because it is the one primitive both output paths need: the screen
 * renderer had it, and the classic path had no way to wrap a long value at all -
 * which is how an 88-column workspace path became three ragged terminal rows.
 *
 * Two things this has to get right, and both were wrong at different times:
 *
 * 1. **Columns, not characters.** `String.slice(0, width)` cut 40 code units,
 *    which is 40 columns of English and 80 columns of Chinese.
 *
 * 2. **One pass.** An earlier version measured with `visibleWidth` inside a loop
 *    that consumed `width` columns at a time. That is quadratic: a 1 MB paste
 *    took **145 SECONDS** (B84).
 *
 * The word-boundary preference is unchanged: the last space in the current line
 * is remembered and a cut is only taken at a space past 40% of the width, so a
 * wrap never strands a widow fragment.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  const limit = Math.max(1, Math.floor(width))
  for (const raw of text.split('\n')) {
    if (!raw) { out.push(''); continue }
    let line = ''
    let col = 0
    let cutAt = -1
    let cutCol = 0
    for (const ch of raw) {
      const w = columnOf(ch.codePointAt(0)!)
      if (col + w > limit && line !== '') {
        if (cutAt > Math.floor(limit * 0.4)) {
          out.push(line.slice(0, cutAt))
          // Carry the column count across the cut, or the next line is measured
          // from zero and the whole thing drifts a column per row.
          line = line.slice(cutAt + 1)
          col -= cutCol + 1
        } else {
          out.push(line)
          line = ''
          col = 0
        }
        cutAt = -1
        cutCol = 0
        // A glyph wider than the entire box cannot fit even on its own row.
        // Emit it alone so the loop always makes progress.
        if (col + w > limit) {
          out.push(line + ch)
          line = ''
          col = 0
          continue
        }
      }
      line += ch
      col += w
      if (ch === ' ') { cutAt = line.length - 1; cutCol = col }
    }
    out.push(line)
  }
  return out
}

/**
 * Run-in-flight scanner (board Motion: `✧✧✿·····`, 4 frames at ~480ms —
 * "never 3, a 3-frame cycle stutters"). VIOLET, never amber: violet is focus
 * and a live run is the focused thing on the page; the amber wash it wore
 * until 2026-10-16 read as a scolding next to the plum chrome (user review).
 * 4-frame cycle, tone preserved per mark via marks.ts (twinkle, bloom) instead
 * of a monochrome wash. The verb beside it rotates too — see BUSY_VERBS.
 */
/**
 * Hermes' activity spinner: ONE braille cell, ten frames, 120 ms. The old
 * nine-cell brand scanner was a different product's motion — wide enough to
 * read as a progress bar and loud enough to pull the eye off the work.
 */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function scannerFrame(i: number): string {
  const n = BRAILLE_FRAMES.length
  return BRAILLE_FRAMES[((i % n) + n) % n]!
}

/** Side rail for a stream line (opencode SplitBorder grammar: ┃ rails). */
export function rail(toneName: MsgTone, text: string): string {
  return `${tone(toneName, '┃')} ${tone(toneName, text)}`
}

/** Toast notice mark — the twinkle; the row's own tone says the rest. */
export function toastMark(): string {
  return glyph('twinkle')
}

/** Branch name from a `.git/HEAD` body; '' when HEAD names no branch. */
export function parseGitHead(head: string): string {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim())
  return match ? match[1]!.trim() : ''
}

let branchCache: { cwd: string; branch: string } | null = null

/**
 * `:branch` suffix for the footer location (design record B2 draws
 * `C:\wednesday:master`). Read once per directory and cached — this runs
 * inside the render path, and re-probing git on every spinner tick is waste.
 * Anything unexpected answers `''`: a footer is not the place to explain why a
 * repository could not be read.
 */
export function gitBranch(cwd: string): string {
  if (branchCache?.cwd !== cwd) {
    let branch = ''
    try {
      const dotGit = join(cwd, '.git')
      // A worktree's `.git` is a FILE (`gitdir: …`); the real dir holds HEAD.
      const head = statSync(dotGit).isFile()
        ? join(resolve(cwd, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8').trim())?.[1]?.trim() ?? '.'), 'HEAD')
        : join(dotGit, 'HEAD')
      branch = parseGitHead(readFileSync(head, 'utf8'))
    } catch {
      branch = ''
    }
    branchCache = { cwd, branch }
  }
  return branchCache!.branch
}

/** The footer's location: `C:\wednesday:master`, or just the path outside git. */
export function locationLabel(cwd = process.cwd()): string {
  const branch = gitBranch(cwd)
  return branch ? `${cwd}:${branch}` : cwd
}

/**
 * Hermes' long-output pager.
 *
 * A command whose answer is taller than the window used to flood the
 * transcript: the rows arrived, the frame kept only the last `room`, and the
 * operator could not read the top of a task table from inside the app (the
 * wheel scrolls the stream, but a 200-row table dropped off the top of the
 * backlog). Hermes answers this with a page: the whole window is the answer,
 * `enter` pages down, `esc/q` closes. Same contract here.
 */
export interface ScreenPager {
  title: string
  lines: string[]
  offset: number
}

export interface ScreenState {
  title: string
  meta: string
  messages: ScreenMessage[]
  input: string
  cursor: number
  status: string
  busy: boolean
  dialog: ScreenDialog | null
  scroll: number
  /**
   * The long-output pager, when a command's answer is taller than the window.
   * Set by the harness (`ui.page`) and by the screen for its own long views;
   * `null` means the transcript owns the frame.
   */
  pager: ScreenPager | null
  /** Transient notice, cleared on the next pushed message (toast grammar). */
  toast: string | null
  /**
   * Persistent update banner shown on the HOME screen while a newer npm
   * release exists (set from the startup advisory, cached daily in
   * ~/.wednesday/state/update-check.json). Cleared by a successful /update
   * (the process restarts onto the new version, so the notice is gone).
   */
  updateNotice?: string | null
  /** Short model label shown in the composer tag (meta is the long line). */
  composerLabel: string | null
  /**
   * What the meter's `✦` segment names. The harness sets it: one model id when
   * every crew seat resolves to the same route, otherwise `crew · N seats`.
   * Absent falls back to `composerLabel` (a single-model session).
   */
  crewLabel?: string
  /**
   * Right-side context panel (opencode session sidebar): session title plus
   * live token accounting. Null hides the panel (narrow terminals).
   */
  side: SidePanel | null
  /**
   * The empty composer's invitation (Hermes grammar: an example prompt where
   * the caret sits, so the first screen teaches what to type). The harness
   * rotates it per session; the screen only styles it.
   */
  placeholder?: string
  /**
   * One rotating tip shown on the home page under the welcome line, chosen at
   * startup so it never flickers mid-session (Hermes' Tip line).
   */
  tip?: string
  /**
   * Home layout: the Hermes start page — a banner frame carrying identity and
   * capability columns, the welcome pair, the status meter and the prompt.
   * Cleared by the first request.
   */
  home: boolean
  /**
   * The completion the composer is offering RIGHT NOW (the navigation engine
   * from `completion.ts`, ported from qwen-code).
   *
   * The screen recomputes it whenever the draft changes and draws it above
   * the composer; the harness supplies the data (the command list, the file
   * index, the recency) through the three fields below.
   */
  completion?: CompletionState | null
  /** The commands the composer completes against. The harness owns the list. */
  completionCommands?: CommandSpec[]
  /**
   * The workspace paths `@` reaches — LAZY, because the index is a filesystem
   * scan. The harness caches it; the screen calls it only when an `@` has
   * actually been typed.
   */
  completionFiles?: () => readonly string[]
  /** Command names used recently, most recent first (recency ranking). */
  completionRecent?: readonly string[]
  /**
   * The TRANSCRIPT SEARCH (Ctrl+F), or null when it is closed.
   *
   * The search is a MODE of the composer, not a separate screen: it borrows
   * the key handler, but the DRAFT is untouched — a search must never eat
   * the request the operator was writing.
   */
  search?: SearchState | null
  /** Session stamp shown in the banner (`Session: 20261025_083453_521afa`). */
  sessionId?: string
  /** Version label centred in the banner's top border. */
  bannerTitle?: string
  /** Session start (ms epoch), for the meter's `12s` segment. */
  startedAt?: number
  /** Current turn start (ms epoch), for the live `⏱ 3s` segment. */
  turnStartedAt?: number | null
  /** Frozen duration of the last turn (ms), for the `⏲ 3s` segment. */
  turnMs?: number
  /**
   * Requests composed while a run is live (Hermes' queue panel above the
   * meter). The harness owns the list; the screen only draws it.
   */
  queued?: string[]
  /**
   * Mouse text selection, in 1-based FRAME CELLS (the same coordinates SGR
   * mouse reports use): an anchor cell and a cursor cell, inclusive, in
   * reading order. Set by a DRAG — a plain click never selects, it clears —
   * and the painter inverts exactly those cells while Ctrl+C / right-click
   * copies them through OSC 52. Columns, not just rows: a drag from the middle
   * of a word copies from that character, which is what the hand asked for.
   */
  selection?: SelectionRange | null
  /**
   * Who is working right now (Hermes' agents dock): one row per crew seat,
   * fed from the run's Factory events. The harness owns the list; the screen
   * only draws it. Empty/absent hides the dock entirely.
   */
  crew?: CrewRow[]
  /**
   * The live CHAT turn: which seat is answering and what it is doing now.
   *
   * The chat was the one turn whose bottom line named NOTHING real: only a
   * BUILD filled the crew dock, so a chat fell back to a rotating decorative
   * verb ("winding…") that read like a progress bar and said nothing (B185).
   * A chat turn sets this, and the activity line says the truth: who is
   * answering, and whether it is thinking or answering.
   */
  chatActivity?: { role: string; detail: string } | null
}

/** One seat in the live crew dock. */
export interface CrewRow {
  /** Factory role id (`planner`, `coder`, `tester`, …). */
  role: string
  /**
   * The lane this seat runs in (`duel-0`, `vote-1`, `relay-2`).
   *
   * A team run puts several seats in the SAME role (two coder lanes in a
   * duel, three reviewer ballots in a vote), and one row per role could only
   * ever show the last of them. The lane label is the identity that keeps
   * them apart: a lane row and a plain seat row of the same role are two
   * different rows and never merge.
   */
  lane?: string
  phase: 'queued' | 'working' | 'verifying' | 'reviewing' | 'repairing' | 'done' | 'failed'
  /** Last concrete thing seen (`read_file`, `attempt 2`), not a restatement. */
  detail?: string
  /** Phase start (ms epoch), for the elapsed clock. */
  startedAt?: number
}

const CREW_GLYPH: Record<CrewRow['phase'], { glyph: string; tone: MsgTone }> = {
  queued: { glyph: '○', tone: 'dim' },
  working: { glyph: '⠋', tone: 'cyan' },
  verifying: { glyph: '◉', tone: 'cyan' },
  reviewing: { glyph: '❦', tone: 'cyan' },
  repairing: { glyph: '✧', tone: 'yellow' },
  done: { glyph: '✓', tone: 'green' },
  failed: { glyph: '✗', tone: 'red' },
}

/**
 * The lane facts a lane event carries (pure).
 *
 * The bus is authoritative: a field that is missing is missing, never
 * invented. The payload may arrive as the event payload itself or as the
 * whole event, so both shapes are read the same way.
 */
function laneFacts(payload?: Record<string, unknown>): Record<string, unknown> {
  if (!payload) return {}
  const inner = payload.payload
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return payload
}

/**
 * Fold one Factory event into the crew dock. Pure: the caller owns the array,
 * which keeps the transition rules assertable without a live run.
 *
 * The event vocabulary is the orchestrator's real one. `agent.completed` marks
 * a seat done; a later `task.failed` flips every live seat to failed, because
 * "the run died" is the truth the dock should end on — not a row of green
 * checks above a red result card.
 *
 * `payload` carries the lane facts of a team event (`lane`, `model`, `role`,
 * `ok`, `score`, `detail`); it is optional, so every seat-only event folds
 * exactly as before.
 */
export function crewUpdate(
  rows: CrewRow[],
  type: string,
  role?: string,
  detail?: string,
  status?: string,
  payload?: Record<string, unknown>,
): CrewRow[] {
  const now = Date.now()
  // A lane row and a seat row are different animals: the lane label is part
  // of the identity, so a plain `coder` seat never absorbs `coder duel-0`.
  const sameLane = (row: CrewRow, lane?: string): boolean =>
    (row.lane ?? undefined) === (lane ?? undefined)
  const upsert = (
    name: string,
    phase: CrewRow['phase'],
    extra?: string,
    lane?: string,
  ): void => {
    const existing = rows.find(row => row.role === name && sameLane(row, lane))
    if (!existing) {
      rows.push({
        role: name,
        ...(lane ? { lane } : {}),
        phase,
        detail: extra,
        startedAt: now,
      })
      return
    }
    // A phase change restarts the clock; a detail-only update does not.
    if (existing.phase !== phase) existing.startedAt = now
    existing.phase = phase
    if (extra) existing.detail = extra
  }
  const settle = (phase: CrewRow['phase']): void => {
    for (const row of rows) {
      if (row.phase === 'done' || row.phase === 'failed') continue
      row.phase = phase
      row.startedAt = now
    }
  }

  if (type === 'task.created') {
    // A new run owns a new dock: the previous run's settled rows must not sit
    // above it pretending to be current.
    rows.length = 0
    return rows
  }
  if (type === 'agent.started') { upsert(role ?? 'agent', 'working'); return rows }
  if (type === 'agent.completed') {
    // The orchestrator reports a DEAD seat as `agent.completed` with a failed
    // status — there is no `agent.failed` event. The dock used to call that
    // "done", so a run whose model never answered still showed a green tick
    // next to the seat that produced nothing.
    const verdict = (status ?? '').trim().toLowerCase()
    const phase: CrewRow['phase'] = verdict === 'failed' || verdict === 'error'
      ? 'failed'
      : verdict === 'aborted' || verdict === 'cancelled'
        ? 'failed'
        : 'done'
    upsert(role ?? 'agent', phase, phase === 'failed' ? (detail ?? 'failed') : detail)
    return rows
  }
  if (type === 'verification.started') { upsert(role ?? 'tester', 'verifying'); return rows }
  if (type === 'verification.completed') { upsert(role ?? 'tester', 'done'); return rows }
  if (type === 'review.started') { upsert(role ?? 'reviewer', 'reviewing'); return rows }
  if (type === 'review.completed') { upsert(role ?? 'reviewer', 'done'); return rows }
  if (type === 'repair.started') { upsert(role ?? 'planner', 'repairing', detail); return rows }
  if (type === 'tool.called' && role) {
    // Tool activity refines a live row; it never creates one (a tool can only
    // run inside a seat that already started). The plain seat row wins: a
    // lane row is driven by the lane events, not by one seat's tool calls.
    const row = rows.find(r => r.role === role && r.lane === undefined) ?? rows.find(r => r.role === role)
    if (row && row.phase !== 'done' && row.phase !== 'failed') {
      row.phase = 'working'
      if (detail) row.detail = detail
    }
    return rows
  }
  if (type === 'agent.activity' && role) {
    // Live activity refines the seat's row the same way a tool call does: the
    // dock says WHAT the seat is doing right now, so the header is never a
    // bare spinner while a model thinks.
    const row = rows.find(r => r.role === role && r.lane === undefined) ?? rows.find(r => r.role === role)
    if (row && row.phase !== 'done' && row.phase !== 'failed' && detail) {
      row.detail = detail
    }
    return rows
  }
  if (
    type === 'lane.started' ||
    type === 'lane.completed' ||
    type === 'lane.scored'
  ) {
    // Team lanes: several seats share one role, so the lane label is the
    // identity. `coder duel-0` and a plain `coder` seat are two rows and
    // never merge into one.
    const facts = laneFacts(payload)
    const lane =
      typeof facts.lane === 'string' && facts.lane.trim()
        ? facts.lane.trim()
        : undefined
    const laneRole =
      typeof facts.role === 'string' && facts.role.trim()
        ? facts.role.trim()
        : (role ?? 'agent')
    const model =
      typeof facts.model === 'string' ? facts.model.trim() : ''
    if (type === 'lane.started') {
      upsert(laneRole, 'working', model || 'default model', lane)
      return rows
    }
    if (type === 'lane.completed') {
      // A lane that already carries a richer detail (its score) keeps it.
      const current = rows.find(
        row => row.role === laneRole && sameLane(row, lane),
      )
      const extra = current?.detail ? undefined : (model || undefined)
      upsert(laneRole, facts.ok === true ? 'done' : 'failed', extra, lane)
      return rows
    }
    // lane.scored: the grade is the last concrete thing the row can say. It
    // never invents a verdict, so the phase stays what the lane actually did.
    const score =
      typeof facts.score === 'number' && Number.isFinite(facts.score)
        ? facts.score
        : null
    const note =
      typeof facts.detail === 'string' ? facts.detail.trim() : ''
    const text =
      score === null
        ? (note || 'no score')
        : (note ? `${score} - ${note}` : String(score))
    const current = rows.find(
      row => row.role === laneRole && sameLane(row, lane),
    )
    if (!current) {
      upsert(laneRole, 'done', text, lane)
      return rows
    }
    current.detail = text
    return rows
  }
  if (type === 'task.completed') { settle('done'); return rows }
  if (type === 'task.failed' || type === 'task.blocked') { settle('failed'); return rows }
  return rows
}

/** Live seats = the ones the header counts. Finished rows still list. */
function liveCrew(rows: CrewRow[]): CrewRow[] {
  return rows.filter(row => row.phase !== 'done' && row.phase !== 'failed')
}

/**
 * The crew dock above the meter, in Hermes' agents grammar:
 *
 *     ▾ 3 live agents · /agents for the roster
 *     ⠋ planner      working · read_file        12s
 *     ◉ tester       verifying · npm test        4s
 *
 * Two sizes, chosen by the caller's height, not by a key: a short window gets
 * the collapsed `▸` line (Hermes' collapsed dock) because four rows of dock
 * would leave no transcript. Finished rows stay until the next request so the
 * run's shape is still readable when the result card lands.
 */
export function crewStripRows(state: ScreenState, width: number, height: number, now = Date.now()): string[] {
  const rows = state.crew ?? []
  if (rows.length === 0) return []
  const w = Math.max(20, width)
  const live = liveCrew(rows).length
  const summary = live > 0
    ? `▾ ${live} live agent${live === 1 ? '' : 's'}`
    : `▸ ${rows.length} seat${rows.length === 1 ? '' : 's'} settled`
  // Collapsed form: one row, naming the busiest seats rather than hiding them.
  if (height < 30 || w < 64) {
    const names = liveCrew(rows).map(row => row.lane ? `${row.role} ${row.lane}` : row.role).slice(0, 3).join(', ')
    const tail = names ? ` · ${names}` : ''
    return [clipVisible(`${summary}${tail}`, w)]
  }
  const out: string[] = [clipVisible(tone('cyan', summary), w)]
  // The dock is bounded: four seats is the whole crew; more than that is a
  // bug in the caller, and the row count must not eat the transcript.
  for (const row of rows.slice(0, 4)) {
    const g = CREW_GLYPH[row.phase]
    // A lane row names its lane: `coder duel-0` is one seat of a duel, not
    // the coder seat.
    const label = row.lane ? `${row.role} ${row.lane}` : row.role
    const elapsed = row.phase === 'working' || row.phase === 'verifying' || row.phase === 'reviewing' || row.phase === 'repairing'
      ? formatElapsed(now - (row.startedAt ?? now))
      : ''
    const detail = row.detail ? ` · ${row.detail}` : ''
    const plain = `  ${g.glyph} ${label.padEnd(14)} ${row.phase}${detail}`
    const text = `  ${tone(g.tone, g.glyph)} ${tone('plain', label.padEnd(14))} ${tone(g.tone === 'green' || g.tone === 'red' ? g.tone : 'dim', row.phase)}${tone('dim', detail)}`
    out.push(clipVisible(elapsed && visibleWidth(plain) + elapsed.length + 1 <= w ? `${text}${tone('dim', ` ${elapsed}`)}` : text, w))
  }
  return out
}

/** `12s` / `2m 14s` — the dock's compact clock. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${total}s`
}

export interface SidePanel {
  title: string
  /** Tokens spent so far in this session (0 when unknown). */
  tokens: number
  /**
   * Tokens the LAST request actually carried — the window pressure.
   *
   * `tokens` is cumulative SPEND, so using it for `ctx` printed nonsense the
   * operator correctly read as a bug: `ctx 29.3K/13.0K` — 225% of a window
   * that has never held 29K. Only the most recent request measures how full
   * the context is; the session total belongs in `Σ`.
   */
  contextTokens?: number
  /** Context ceiling for the active route (0 = unknown). */
  limit: number
  /**
   * Rail body override: what the panel shows INSTEAD of the Context block.
   *
   * The harness owns the content — crew seats, route, session id, command
   * count — because it is the only layer that knows what is true; the screen
   * owns the layout. Section labels sit at column 0, values are indented two
   * spaces (the Hermes banner grammar: "Available Tools / Skills" columns).
   * Absent rows fall back to the Context block, which is the session ledger.
   */
  rows?: Array<{ text: string; tone: MsgTone }>
}

/**
 * The banner's two column widths, exported so the harness can build rows that
 * FIT the right column instead of being clipped mid-word by the renderer.
 */
export function bannerColumns(w: number): { inner: number; left: number; right: number } {
  // Hermes Panel(padding=(0,2)): two cells inside each border. `inner` is the
  // content width left after both paddings, so a row built as
  // `│  left  right  │` is exactly `w` cells.
  const inner = Math.max(16, w - 6)
  let right = w >= 96 ? Math.min(58, Math.max(30, Math.floor(inner * 0.44))) : 0
  // The hero art is the tesseract cube at up to 30 cells and must never be
  // cropped: a half-cube reads as corruption, not art. When the catalog would
  // squeeze the art, the catalog gives up the cells instead.
  if (right > 0) right = Math.min(right, Math.max(20, inner - 2 - 32))
  return { inner, left: right > 0 ? inner - right - 2 : inner, right }
}

export function initialState(title: string, meta: string): ScreenState {
  return { title, meta, messages: [], input: '', cursor: 0, status: '', busy: false, dialog: null, scroll: 0, pager: null, toast: null, updateNotice: null, composerLabel: null, side: null, home: false }
}

/**
 * Hermes' answer to a command response taller than the window. `lines` is the
 * whole answer (each entry one row); the pager pages through it with the same
 * keys Hermes binds and the same two position strings.
 *
 * Returns the opened pager so a caller can drive it directly (and so the
 * screen test can assert on the clip math without a PTY).
 */
export function pagerWindow(lines: string[], height: number, offset: number): { shown: string[]; offset: number; atEnd: boolean } {
  const page = Math.max(1, height)
  const max = Math.max(0, lines.length - page)
  const at = Math.max(0, Math.min(offset, max))
  return { shown: lines.slice(at, at + page), offset: at, atEnd: at >= max }
}

/**
 * The pager's page size: the number of answer rows one window shows. Chrome is
 * the centred title (2 rows when present) plus the position line (1). BOTH the
 * frame and the key handlers read this, so Enter can never page by a step the
 * window cannot show.
 */
export function pagerWindowSize(height: number, hasTitle: boolean): number {
  return Math.max(1, height - 1 - (hasTitle ? 2 : 0))
}

/**
 * The pager's position line, Hermes' two forms verbatim: `(X/N)` while there
 * is more below, `end · … (N lines)` on the last page.
 */
export function pagerHint(total: number, shownThrough: number, atEnd: boolean): string {
  if (atEnd) return `end · ↑↓/jk · b/PgUp back · g top · Esc/q close (${total} lines)`
  return `↑↓/jk line · Enter/Space/PgDn page · b/PgUp back · g/G top/bottom · Esc/q close (${Math.min(shownThrough, total)}/${total})`
}

/** Todo-plan row (opencode todo-item grammar): status box + content. */
export function todoRow(status: 'done' | 'doing' | 'todo', content: string): ScreenMessage {
  if (status === 'done') return { text: `[✓] ${content}`, tone: 'green' }
  if (status === 'doing') return { text: `[•] ${content}`, tone: 'yellow' }
  return { text: `[ ] ${content}`, tone: 'dim' }
}

/**
 * Wednesday mark.
 *
 * The previous crest was three rows of block art meant to read as a "W". It
 * did not: `█▀▀█ █▀▀▀█ █▀▀▄` over `█ ▀█ █  █ █  █` renders as noise at any
 * terminal size, and on a narrow window it looked like a corrupted glyph run
 * rather than a logo — which is the same class of bug as the corrupted
 * box-chars the brand spec warns about.
 *
 * Brand spec rule 12: a mark must read at 32px, and rule 1: black eats the
 * frame, bone type floating on it. So the mark is TYPE — the house rose
 * carrying the name — which is crisp at any size and cannot shear. The heavy
 * silhouette work belongs to the gate plate, which is real artwork sampled into
 * cells; text is the right tool where there is no room for art.
 */
export function wednesdayMark(width = Number.POSITIVE_INFINITY): string[] {
  const name = tone('cyan', `${glyph('rose')} `) + tone('bold', 'WEDNESDAY')
  // The brand one-liner, same words as the website hero. 48 columns; below
  // that it was clipped mid-word ("Small open mod"), which reads as a
  // rendering fault rather than a short line, so it is dropped whole and
  // the name carries the page.
  const tagline = 'Small open models, staffed as a coding team'
  return visibleWidth(name) + visibleWidth(tagline) <= width ? [name, tone('dim', tagline)] : [name]
}

/** Compact one-line mark for the title bar (the header adds its own ❦). */
export function wednesdayCompact(): string {
  return 'WEDNESDAY'
}

/**
 * Brand glyph vocabulary (spec rule 13: one cell, one idea — rose, thorn,
 * skull, hand, crescent, dagger, twinkle. Never generic dingbats).
 *
 * The table now lives in ./marks.ts, transcribed from the decode key in
 * wednesday-theme/tui-design.html, so the design record and the CLI cannot
 * drift. Re-exported here because screen.ts is the module the harness imports.
 */
export const GLYPH = MARKS

export type GlyphName = keyof typeof MARKS

export { markFor, supportsOrnamental }

export function glyph(name: GlyphName, ornamental = supportsOrnamental()): string {
  return markGlyph(name, ornamental)
}

/** Todo row with brand marks: thorn-done, bloom-doing, hollow-todo. */
export function brandTodoRow(status: 'done' | 'doing' | 'todo', content: string): ScreenMessage {
  // A finished plan item is a closed floret (sage); the item in flight is a
  // lit twinkle (amber = a light source). Both are one idea per cell.
  if (status === 'done') return { text: `[${glyph('floret')}] ${content}`, tone: 'green' }
  if (status === 'doing') return { text: `[${glyph('twinkle')}] ${content}`, tone: 'yellow' }
  return { text: `[ ] ${content}`, tone: 'dim' }
}

interface MdSeg { text: string; tone: MsgTone }

/** One markdown-ish line → tinted segments (headers bold, `code` amber). */
export function mdSeg(line: string): MdSeg[] {
  const head = /^(#{1,3})\s+(.*)$/.exec(line)
  if (head) return [{ text: head[2] ?? '', tone: 'bold' }]
  const out: MdSeg[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), tone: 'plain' })
    const inner = m[0].replace(/^(`|\*\*)|(`|\*\*)$/g, '')
    out.push({ text: inner, tone: m[0].startsWith('`') ? 'yellow' : 'bold' })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), tone: 'plain' })
  if (out.length === 0) out.push({ text: line, tone: 'plain' })
  return out
}

export function mdLine(line: string): string {
  return mdSeg(line).map(s => tone(s.tone, s.text)).join('')
}

export type DiffKind = 'same' | 'add' | 'del' | 'hunk'

export interface DiffLine { kind: DiffKind; text: string }

/**
 * Minimal line differ (LCS over hashed lines, capped inputs): enough for
 * review-size patches in the terminal. Not a general diff tool.
 */
export function diffLines(oldText: string, newText: string, file: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length * b.length > 40_000) {
    return [{ kind: 'hunk', text: `@@ ${file} (too large for terminal diff)` }]
  }
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1]! + 1) : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = [{ kind: 'hunk', text: `@@ ${file}` }]
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: `  ${a[i]}` }); i++; j++ }
    else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) { out.push({ kind: 'del', text: `- ${a[i]}` }); i++ }
    else { out.push({ kind: 'add', text: `+ ${b[j]}` }); j++ }
  }
  while (i < n) { out.push({ kind: 'del', text: `- ${a[i]}` }); i++ }
  while (j < m) { out.push({ kind: 'add', text: `+ ${b[j]}` }); j++ }
  return out
}

/**
 * Read `git diff` output as display rows.
 *
 * The patch is already a diff, so it is never re-diffed: git's own line prefix
 * is the kind. File headers (`diff --git`, `index`, `---`, `+++`, mode lines)
 * carry nothing an operator reads, so they are dropped; hunk headers are kept
 * because they say where in the file the change sits.
 *
 * No synthetic file header is prepended: naming the file is the CALLER's
 * decision (`@@ path vs HEAD · +2 -1` is one header, not two), and a parser
 * that invents display rows cannot be used for anything but this one caller.
 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const raw of patch.split('\n')) {
    if (!raw) continue
    // Headers first: `--- a/x` and `+++ b/x` would otherwise read as a removed
    // and an added line, which is exactly the lie a diff must not tell.
    if (/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |Binary files )/.test(raw)) continue
    if (raw.startsWith('@@')) { out.push({ kind: 'hunk', text: raw }); continue }
    if (raw.startsWith('+')) { out.push({ kind: 'add', text: raw }); continue }
    if (raw.startsWith('-')) { out.push({ kind: 'del', text: raw }); continue }
    // A context line keeps git's leading space so the marker column lines up
    // with `+` and `-` (same convention as `diffLines`).
    out.push({ kind: 'same', text: ` ${raw}` })
  }
  return out
}

export function diffTone(kind: DiffKind): MsgTone {
  if (kind === 'add') return 'green'
  if (kind === 'del') return 'red'
  if (kind === 'hunk') return 'cyan'
  return 'dim'
}

export interface SelectOption {
  title: string
  desc?: string
  footer?: string
  value: string
  /** Section header rows (non-selectable, e.g. "Recent"). */
  section?: string
}

/**
 * Void-on-violet fill for the ARMED approval action (design record D1: the
 * selection is carried by void-on-violet). Violet is the focus tone and this
 * is the one focused action on the screen. The amber fill that lived here
 * until 2026-10-16 read as a highlighter stain against the plum page (user
 * review), and the design record's own rule is that no accent becomes a fill
 * larger than a dot. Amber still marks what is LIT (the awaiting hand, the
 * repair twinkle) — as a one-cell mark, never as a fill.
 */
export function armedFill(text: string): string {
  return `\x1b[38;5;${THEME.bg}m\x1b[48;5;${THEME.accent}m${text}\x1b[0m`
}

/** Non-selectable section header row inside a select list. */
export function selectSection(title: string): SelectOption {
  return { title, value: '', section: title }
}

/**
 * Options left after the typed filter, BEST MATCH FIRST.
 *
 * The first live palette run exposed the trap in the old substring-only
 * filter: typing `review` matched `/run` because its description says
 * "preview", and `/run` comes first in PALETTE — so Enter opened the `/run`
 * argument prompt, then treated the next command as a task id. Typing `new`
 * matched `/update` ("a newer release") the same way. A command palette that
 * silently runs a different command than the one typed is worse than no
 * palette, so matches are ranked like a completion list:
 *
 *   0  exact title        (leading `/` ignored: both `new` and `/new` work)
 *   1  title prefix
 *   2  title substring
 *   3  description substring
 *   4  fuzzy title        (`mdl` finds `/model` — qwen-code's subsequence rule)
 *
 * Ties keep their original order, and RECENCY breaks them: the commands the
 * operator actually uses float up among equals. Recency never promotes a
 * command that does not match — a command the operator never typed must not
 * appear because they typed it often elsewhere.
 *
 * Sections stay attached to the options that follow them, so grouped lists
 * (models, crews) do not lose their shape.
 * With no matches the section headers survive: an empty grouped plate still
 * explains itself, and `screen-test` pins that.
 *
 * @param recent command values used recently, most recent first (optional).
 */
export function selectMatching(
  options: SelectOption[],
  filter: string,
  height: number,
  recent: readonly string[] = [],
): SelectOption[] {
  const q = filter.trim().toLowerCase().replace(/^\//, '')
  // Recency is a TIE-BREAK, never an override: the rank comes first, so an
  // exact match still beats a recent prefix.
  const recency = new Map<string, number>()
  recent.forEach((value, index) => recency.set(value.toLowerCase(), recent.length - index))
  const rankOf = (option: SelectOption): number => {
    const title = option.title.toLowerCase().replace(/^\//, '')
    if (title === q) return 0
    if (title.startsWith(q)) return 1
    if (title.includes(q)) return 2
    if ((option.desc ?? '').toLowerCase().includes(q)) return 3
    // The fuzzy fallback: a SUBSEQUENCE of the title, so `mdl` finds
    // `/model`. It ranks below every real match — a fuzzy hit is a guess,
    // and a guess must never outrank a command that literally matched.
    if (q && fuzzyScore(q, title) !== null) return 4
    return 9
  }
  const indexed = q
    ? options.map((option, i) => ({ option, i, rank: option.section !== undefined ? 0 : rankOf(option) }))
    : options.map((option, i) => ({ option, i, rank: 0 }))
  // Group pickables under the section header that introduces them, then rank
  // INSIDE each group. Sorting the flat list would detach a header from the
  // options it names.
  const groups: Array<{ section: SelectOption | null; picks: typeof indexed }> = []
  let current: { section: SelectOption | null; picks: typeof indexed } = { section: null, picks: [] }
  for (const entry of indexed) {
    if (entry.option.section !== undefined) {
      groups.push(current)
      current = { section: entry.option, picks: [] }
      continue
    }
    if (entry.rank >= 9) continue
    current.picks.push(entry)
  }
  groups.push(current)
  const ordered: SelectOption[] = []
  for (const group of groups) {
    if (group.section) ordered.push(group.section)
    group.picks
      .slice()
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        // Recency breaks a tie: the command the operator used last comes
        // first among equals. The original order is the final tiebreak, so
        // the list stays stable when nothing was used recently.
        const ra = recency.get(a.option.value.toLowerCase()) ?? 0
        const rb = recency.get(b.option.value.toLowerCase()) ?? 0
        if (ra !== rb) return rb - ra
        return a.i - b.i
      })
      .forEach(entry => ordered.push(entry.option))
  }
  // Budget pickables, not rows: section headers are chrome, and letting them
  // consume the slice hid real options below them. Always keep at least one
  // pickable when any match, so a tiny terminal still offers a choice instead
  // of an empty plate where Enter can only cancel.
  const picks = ordered.filter(o => o.section === undefined)
  const budget = Math.max(1, height - 6)
  const kept = picks.slice(0, budget)
  // Preserve order: walk the ranked list, keeping sections and kept picks.
  const keptSet = new Set(kept)
  return ordered.filter(o => o.section !== undefined || keptSet.has(o))
}

/**
 * Panel geometry for an overlay drawn over the live screen: the rows plus the
 * column where each row starts, so a click maps back to a row.
 */
export interface Overlay {
  rows: string[]
  left: number
  top: number
  width: number
  /** Row index (within `rows`) of each selectable option, in order. */
  optionRows: number[]
}

/** Marker row prefix so hit-testing knows which rows are selectable. */
/** Marker prefix on rows a mouse click can select (stripped when drawn). */
export const SELECT_ROW_MARK = '~sel~'
const SELECT_MARK = SELECT_ROW_MARK

/**
 * Make a plate row opaque and exactly `width` wide (opencode dialog surface):
 * content behind the plate must not bleed through it. The active row already
 * carries its own amber wash, so it is only padded.
 */
export function plateRow(row: string, width: number): string {
  const clean = row.startsWith(SELECT_ROW_MARK) ? row.slice(SELECT_ROW_MARK.length) : row
  const padded = padVisible(clean, width)
  return padded.includes('\x1b[48;5;') ? padded : panelBg(padded)
}

/** Build overlay geometry from drawn rows (centred, page-floating). */
export function overlayFromRows(rows: string[], panelWidth: number, terminalWidth: number, height: number, top?: number): Overlay {
  // The width the caller ACTUALLY drew at, never a floor of our own. This had a
  // `Math.max(20, ...)` that disagreed with `selectLines`: the rows were built 18
  // wide and the geometry centred them as if they were 20, so the plate sat a
  // column off-centre at every narrow size. Two functions must not each invent
  // their own idea of how wide the panel is.
  const plate = Math.max(1, Math.min(panelWidth, terminalWidth))
  const left = Math.max(0, Math.floor((terminalWidth - plate) / 2))
  const row = top ?? Math.max(0, Math.floor((height - rows.length) / 2))
  const optionRows: number[] = []
  rows.forEach((r, i) => { if (r.startsWith(SELECT_MARK)) optionRows.push(i) })
  return { rows, left, top: row, width: plate, optionRows }
}

/**
 * Draw the filterable select list as a real bordered plate (design record
 * frame G1): wrought-iron rails, a title row with `esc` opposite, the typed
 * query, grouped options, a hint footer.
 *
 * The border is the point. The plate used to be a bare block of text on a
 * background wash with no frame of its own, so the one overlay in the UI did
 * not look like anything else in it — reported as "the popup does not go with
 * our UI", and its options read as a foreign widget for the same reason.
 *
 * The active row is marked `›` in Nevermore violet (G1/G2), not an amber
 * wash: the wash is opencode's selection colour and the brand spends amber on
 * approval only. Selectable rows are tagged with SELECT_MARK so a mouse click
 * maps back to an option. Pure — no TTY, no listeners — so the design board
 * renders the real overlay.
 */
export function selectLines(
  title: string,
  options: SelectOption[],
  filter: string,
  active: number,
  width: number,
  height: number,
  /**
   * Reports the window that was actually drawn: the index of the FIRST visible
   * pickable and how many rows the window holds.
   *
   * The caller needs it to map a click on a drawn row back to the option that
   * row stands for. Without it a click in a SCROLLED list picks the wrong
   * entry — the slot in the window is not the index in the list, so clicking
   * the 60th model on screen activated the first one.
   */
  onWindow?: (first: number, size: number) => void,
  /**
   * Command values used recently, most recent first — the recency tie-break
   * (see `selectMatching`). Empty by default: a plate with no history keeps
   * the declared order.
   */
  recent: readonly string[] = [],
): string[] {
  const w = fitWidth(width)
  const h = fitHeight(height)
  // Outer width INCLUDES the rails, and it is exactly the width the caller
  // draws at (`plateRow(row, geometry.width)`), so the rails and the painted
  // surface can never disagree.
  //
  // It is the TERMINAL width, with no minimum of its own. There used to be a
  // floor of 20 columns "so the layout stays legible on a narrow window", which
  // is exactly backwards: it made the plate WIDER than a narrow window, so at 6
  // columns the command plate painted 20 and the terminal scrolled the page out
  // from under the operator. Legibility below 20 columns is a lesser problem
  // than not fitting, and the caller decides the real width.
  const outer = Math.max(1, w)
  const inner = Math.max(1, outer - 4) // two rails plus a space each side
  const bar = '─'.repeat(inner + 2)
  // Depth: lit top edge, body verticals, cast bottom edge. Same CHARACTERS as
  // before — a floating plate with one border colour on all four edges sits
  // FLAT on the page, which is what made it read as a pasted block of text.
  const topRail = `${bevel('╭', 'top')}${bevel(bar, 'top')}${bevel('╮', 'top')}`
  const botRail = `${bevel('╰', 'bottom')}${bevel(bar, 'bottom')}${bevel('╯', 'bottom')}`
  const edge = (text: string): string =>
    `${bevel('│', 'side')} ${padVisible(clipVisible(text, inner), inner)} ${bevel('│', 'side')}`
  // Chrome: top rail, title, query, spacer, hint, bottom rail.
  const chrome = 6
  // Generous height so selectMatching does not pre-truncate: the WINDOW below
  // decides what fits, and it always keeps the active row in view.
  const list = selectMatching(options, filter, h + options.length + 8, recent)
  const pickables = list.filter(o => o.section === undefined)
  const current = Math.min(Math.max(0, active), Math.max(0, pickables.length - 1))
  const budget = Math.max(1, h - chrome)
  /** One option row: caret for the active one, dim description either way. */
  const optionRow = (opt: SelectOption, isCurrent: boolean): string => {
    const desc = opt.desc ? `  ${opt.desc}` : ''
    const foot = opt.footer ? `  ${opt.footer}` : ''
    const body = isCurrent
      ? `  ${tone('cyan', '›')} ${tone('bold', opt.title)}${tone('dim', desc)}`
      : `    ${tone('plain', opt.title)}${tone('dim', `${desc}${foot}`)}`
    return `${SELECT_MARK}${edge(body)}`
  }
  /**
   * Rows for pickables [first, first + size). Sections inside the window are
   * kept; ones outside it are dropped rather than drawn headless.
   */
  const window = (first: number, size: number): string[] => {
    const rows: Array<{ at: number; head: boolean; row: string }> = []
    let seen = -1
    for (const opt of list) {
      if (opt.section !== undefined) {
        // A header belongs to the pickables that FOLLOW it, so it is keyed by
        // the last pickable seen: one sitting at `first - 1` is exactly the
        // header the first visible option needs.
        rows.push({ at: seen, head: true, row: edge(tone('dim', clipVisible(`  ${opt.section}`, inner))) })
        continue
      }
      seen += 1
      rows.push({ at: seen, head: false, row: optionRow(opt, seen === current) })
    }
    const last = first + size
    return rows
      .filter(entry => entry.at >= (entry.head ? first - 1 : first) && entry.at < last)
      .map(entry => entry.row)
  }
  // Shrink the window until the plate fits the terminal height. The active row
  // is always inside it, so Enter can never pick something invisible.
  //
  // The hint and the bottom rail are part of `rows` INSIDE the loop: budgeting
  // them outside made the fit test two rows optimistic, so a plate that needed
  // shrinking was accepted at 11 rows in a 10-row terminal and the bottom rail
  // fell off the bottom of the window.
  let size = Math.min(budget, Math.max(1, pickables.length))
  let first = Math.max(0, Math.min(current - Math.floor(size / 2), pickables.length - size))
  let rows: string[] = []
  const total = options.filter(o => o.section === undefined).length
  for (;;) {
    // Re-centre on the ACTIVE row every pass. Clamping alone left the window
    // anchored where it started when the size shrank, so on a short terminal
    // the highlighted row fell off the bottom of its own list — the caret
    // vanished while Enter still picked that row.
    first = Math.max(0, Math.min(current - Math.floor(size / 2), Math.max(0, pickables.length - size)))
    const shown = Math.min(size, pickables.length)
    const count = filter && shown < total
      ? ` · ${shown}/${total}`
      : first > 0 || first + size < pickables.length
        ? ` · ${first + 1}-${Math.min(pickables.length, first + size)}/${pickables.length}`
        : ''
    // Short hint on a narrow plate: a clipped "return se" is worse than a
    // shorter honest one, and the keys still work. The counter only rides along
    // when it FITS — a clipped "· 1" reads as a broken number, not a count.
    const foot = ['↑/↓ move · return select · esc cancel', '↑↓ · enter · esc', '']
      .map(base => `${base}${count}`)
      .find(line => visibleWidth(line) <= inner) ?? '↑↓ · enter · esc'
    rows = [
      topRail,
      // Title left, `esc` right — the opencode dialog header grammar.
      edge(`${tone('bold', title)}${' '.repeat(Math.max(1, inner - title.length - 3))}${tone('dim', 'esc')}`),
      // Query row: what has been typed, or the prompt. Reads as an input.
      filter ? edge(clipVisible(filter, inner)) : edge(tone('dim', 'type to filter')),
      edge(''),
      ...window(first, size),
    ]
    if (pickables.length === 0) {
      // An explicit row, not a blank plate: blank reads as frozen, while
      // "(no matches)" tells the operator to keep typing or Esc out. Enter with
      // no matches is a no-op (stays open), never a dismiss.
      rows.splice(4, 0, edge(tone('dim', clipVisible('  (no matches — keep typing, or Esc to close)', inner))))
    }
    rows.push(edge(tone('dim', foot)))
    rows.push(botRail)
    if (rows.length <= h || size <= 1) break
    size -= 1
  }
  // The window that survived the shrink loop — the drawn slice of the list.
  onWindow?.(first, size)
  return rows
}

/**
 * Filterable select list as a FLOATING OVERLAY (opencode DialogSelect
 * grammar, brand plate G1): the live screen stays painted underneath, the
 * plate floats CENTRED on the page, and the mouse takes part — hover moves the
 * active row, a click picks it, a click on the background dismisses.
 *
 * Resolves the chosen value, or undefined on cancel.
 */
export async function runSelect(
  out: NodeJS.WriteStream,
  width: number,
  height: number,
  title: string,
  options: SelectOption[],
  base?: () => string,
  initialFilter = '',
  // Accepted for callers that pass the screen; the geometry is page-centred now
  // and no longer reads the composer's position (which is what used to make the
  // first paint land in the wrong rows).
  screen?: Screen,
  /**
   * Command values used recently, most recent first. Recency breaks a tie
   * among equally good matches, so the command the operator actually uses
   * comes first — and NEVER promotes a command that does not match.
   */
  recent: readonly string[] = [],
): Promise<string | undefined> {
  let filter = initialFilter
  let active = 0
  let detach: () => void = () => {}
  return new Promise(resolve => {
    // The live size, re-read on every paint: a resized window must redraw the
    // plate at the new size instead of leaving the old pixels and the old hit
    // map behind (see Screen.onResize). Both branches are normalised through
    // fitWidth/fitHeight: reading the wrong key here once produced NaN columns,
    // which silently painted the plate at "row NaN" — invisible, untestable.
    const size = (): { w: number; h: number } => {
      const dims = screen?.dimensions()
      return dims
        ? { w: fitWidth(dims.width), h: fitHeight(dims.height) }
        : { w: fitWidth(width), h: fitHeight(height) }
    }
    // A bordered plate needs five columns for its rails plus a gutter each side,
    // and six rows for its chrome. Below that it cannot be drawn without
    // overflowing the terminal - and a terminal handed more cells than it has
    // answers by scrolling the page out from under the operator. So the plate
    // declines to open: Esc-equivalent, no menu, no damage.
    //
    // Dragging a window edge passes through exactly these sizes, so this is an
    // ordinary path, not an exotic one. A menu that flickers away is much better
    // than a frame that tears.
    {
      const dims = size()
      if (dims.w < MIN_PLATE_COLS || dims.h < MIN_PLATE_ROWS) {
        resolve(undefined)
        return
      }
    }
    const pickables = (): SelectOption[] => selectMatching(options, filter, size().h + options.length + 8, recent).filter(o => o.section === undefined)
    // Never negative: `w - 6` is negative on a very narrow window, and a negative
  // width used to be "rescued" by the plate's own floor, which is how a 1-column
  // terminal ended up with a 20-column menu.
  const panelWidth = (w: number): number => Math.max(1, Math.min(w - 6, Math.max(34, Math.floor(w * 0.62))))
    /**
     * The window the plate actually drew: the first visible pickable and the
     * number of rows it holds. A click is a slot in that window, and the slot
     * is only an option index once the window's start is added.
     */
    let windowFirst = 0
    let windowSize = 0
    const plate = (w: number, h: number): string[] => selectLines(
      title, options, filter, active, panelWidth(w), h,
      (first, size) => { windowFirst = first; windowSize = size },
      recent,
    )
    let geometry = { top: 0, left: 0, width: 0, height: 0, optionRows: [] as number[] }
    /** Last painted overlay cells, for the incremental repaint. */
    let paintedPatches: Patch[] = []
    /** Which option the pointer is over, or -1 when off the plate. */
    const optionAt = (x: number, y: number): number => {
      if (x <= geometry.left || x > geometry.left + geometry.width) return -1
      const row = y - 1 - geometry.top
      const slot = geometry.optionRows.indexOf(row)
      // The drawn rows are the WINDOW's slice of the list, so the slot plus the
      // window's first index is the option's index in the list. Using the slot
      // alone picked the first option on screen when the operator clicked the
      // sixtieth — the list was scrolled, the slot was not.
      return slot >= 0 ? windowFirst + slot : -1
    }
    /** Paint the live screen, then float the plate over it (background stays). */
    /**
     * Repaint the overlay.
     *
     * `full` forces the base frame out again; otherwise only the plate rows that
     * changed are written. The distinction is the difference between "hovering
     * moves a caret" and "hovering repaints the terminal 60 times a second".
     */
    const draw = (full = true): void => {
      // Centred on the PAGE, not stacked on the composer. The plate used to be
      // pinned directly above the input box, so the option list read as part of
      // the composer at the bottom of the screen instead of a menu in the
      // middle of the window — reported as "the menu should be in the centre".
      // Geometry no longer depends on where the composer sits, which also
      // removes the stale-first-paint trap the old ceiling arithmetic had.
      const { w, h } = size()
      const rows = plate(w, h)
      const place = overlayFromRows(rows, panelWidth(w), w, h)
      geometry = {
        top: place.top,
        left: place.left,
        width: place.width,
        height: rows.length,
        optionRows: place.optionRows,
      }
      // Clamp to the MATCHING LIST, never to the drawn window.
      //
      // The old clamp used the number of option rows the plate could SHOW, so
      // the caret died at the end of the first screenful: `/model` listed 85
      // models, the plate drew 50, and arrow-down stopped at 50 with 35 models
      // unreachable below (operator report, 2026-11-04). `selectLines` already
      // scrolls the window so the active row is always visible, so the clamp
      // only has to keep the index inside the list.
      const total = pickables().length
      if (total > 0) active = Math.min(Math.max(0, active), total - 1)
      // ESC[H FIRST. The base frame is the full height, and the cursor is left
      // wherever the composer's caret was — so without an explicit home the
      // frame is written from mid-screen, the terminal scrolls, and every
      // keystroke inside the plate moves the whole page.
      //
      // The base frame is re-emitted ONLY when it can have changed (a key, a
      // filter change, a scroll, a resize). A hover that just moves the caret
      // repaints the two plate rows that differ and nothing else: re-emitting a
      // 4 KB full-screen frame for each of the ~60 motion events a second a
      // moving mouse produces is what made the terminal feel frozen, because
      // the writes pile up faster than the console can absorb them.
      const painted = rows.map(row => plateRow(row, geometry.width))
      // Every cell this overlay owns, as addressable patches.
      //
      // The cast shadow lives OUTSIDE the plate (one row below, one column
      // right), so it has to be part of the same bookkeeping. Tracking only the
      // plate rows - the obvious implementation - means a geometry change (a
      // filter that narrows the list, a resize) silently leaves the old shadow
      // behind on a row nobody repaints. That is the same class of bug as a
      // stale frame, so it is diffed the same way.
      const patches: Patch[] = painted.map((row, i) => ({
        row: geometry.top + i,
        col: geometry.left + 1,
        text: row,
      }))
      // Bottom shadow: one row under the plate, starting one column in, so it
      // reads as light falling from above-left. Clamped to the terminal, and
      // skipped entirely when the plate sits on the last row.
      const shadowRowIndex = geometry.top + geometry.height
      const shadowCols = Math.min(geometry.width - 1, w - geometry.left - 1)
      if (shadowRowIndex < h && shadowCols > 0) {
        patches.push({
          row: shadowRowIndex,
          col: geometry.left + 2,
          text: shadowRow(shadowCols),
        })
      }
      // Right shadow: one column past the plate's right edge, one row lower
      // than the top rail, so the corner of the shadow stays open.
      const shadowColIndex = geometry.left + geometry.width + 1
      if (shadowColIndex <= w && geometry.height > 1) {
        for (let i = 1; i < geometry.height; i++) {
          patches.push({ row: geometry.top + i, col: shadowColIndex, text: shadowColumn() })
        }
      }
      if (full) {
        // Record what is now on screen BEFORE writing, so the next incremental
        // pass compares against reality rather than against intent.
        paintedPatches = patches
        // Through the same tail-clearing repaint as the frame. Joining the frame
        // with `\n` clears nothing: a plate opened after the window narrowed
        // would leave the old layout's right-hand column on screen, with the
        // plate floating on top of a ghost.
        let paint = base
          ? (screen ? screen.fullRepaint(base().split('\n'), w, h) : '\x1b[H' + base())
          : '\x1b[H'
        patches.forEach(p => {
          paint += `\x1b[${p.row + 1};${p.col}H${p.text}`
        })
        out.write(paint + '\x1b[?25l')
        return
      }
      // Patch-diff repaint: write only the cells whose content changed, each
      // addressed in place. No home, no base frame.
      let paint = ''
      const previous = new Map(paintedPatches.map(p => [`${p.row}:${p.col}`, p.text]))
      const nextKeys = new Set(patches.map(p => `${p.row}:${p.col}`))
      // Cells this overlay no longer owns. A shrinking or moving plate leaves
      // these behind, and a diff that only ADDS is not a diff - it is a leak:
      // the first run of this test found 75 orphaned shadow cells, a stripe of
      // texture across the page that no key could clear.
      const orphanRows = new Set(
        paintedPatches.filter(p => !nextKeys.has(`${p.row}:${p.col}`)).map(p => p.row),
      )
      if (orphanRows.size > 0) {
        // Lift the overlay by giving the PAGE back, not blanks: the plate and
        // its shadow are painted OVER the live frame, so restoring a cell means
        // restoring the frame's own content there. Repainting the whole row is
        // the only safe way to do that, because the frame rows carry SGR codes
        // and indexing them by visible column walks straight into an escape.
        const frameRows = base ? base().split('\n') : []
        for (const r of orphanRows) {
          if (r < 0 || r >= h) continue
          paint += `\x1b[${r + 1};1H${clipVisible(frameRows[r] ?? '', w)}`
        }
      }
      patches.forEach(p => {
        // A row that was just restored from the frame has had its overlay cells
        // wiped, so every patch on it is rewritten even when unchanged.
        if (orphanRows.has(p.row) || previous.get(`${p.row}:${p.col}`) !== p.text) {
          paint += `\x1b[${p.row + 1};${p.col}H${p.text}`
        }
      })
      paintedPatches = patches
      if (paint) out.write(paint)
    }
    let finished = false
    const done = (value: string | undefined): void => {
      if (finished) return
      finished = true
      detach()
      resolve(value)
    }
    const onKey = (key: TerminalKey): void => {
      if (finished) return
      // Same self-heal as the composer, before the key is handled.
      if (screen && screen.syncSize(out)) draw()
      if (key.ctrl && key.name === 'c') { done(undefined); return }
      // Caret-only moves repaint INCREMENTALLY; a filter change repaints the
      // whole frame, because the list itself changed.
      //
      // A full draw on every arrow key re-emitted the entire base frame, and
      // Windows Terminal paints that as a full-screen blink — "the menu blinks
      // when I move with the keyboard" (operator report, 2026-11-04). The
      // incremental path writes only the two rows whose caret moved.
      let caretOnly = false
      switch (key.name) {
        case 'escape': done(undefined); return
        case 'return': {
          const pick = pickables()[active]
          if (pick) { done(pick.value); return }
          // No matches: a typed slash command is an ESCAPE HATCH, not a dead
          // end. `/exit` typed into the model plate used to sit there while
          // Enter did nothing, and every later command was appended to the
          // filter — the "palette swallowed my session" trap. Returning the
          // line lets the caller dispatch it; Esc still cancels cleanly.
          const typed = filter.trim()
          if (typed.startsWith('/') && typed.length > 1) { done(typed); return }
          // Otherwise stay open (keep typing or Esc). Resolving undefined here
          // would read as a cancel and be indistinguishable from Esc.
          break
        }
        case 'up': active = Math.max(0, active - 1); caretOnly = true; break
        case 'down': active = Math.min(Math.max(0, pickables().length - 1), active + 1); caretOnly = true; break
        case 'pageup': active = Math.max(0, active - 5); caretOnly = true; break
        case 'pagedown': active = Math.min(Math.max(0, pickables().length - 1), active + 5); caretOnly = true; break
        case 'home': active = 0; caretOnly = true; break
        case 'end': active = Math.max(0, pickables().length - 1); caretOnly = true; break
        case 'backspace': filter = filter.slice(0, -1); active = 0; break
        // Named keys we don't bind (left/right/delete/insert/arrows) must
        // never reach the printable branch: their sequences contain '[D' etc,
        // which would corrupt the filter with literal brackets.
        case 'left':
        case 'right':
        case 'delete':
        case 'insert':
          break
        default:
          // Accept printable RUNS, not just single chars: the decoder emits a
          // paste as one multi-character sequence, and the old length===1 gate
          // dropped it whole so pasting into the filter did nothing.
          // Escape sequences never type: only raw printable text appends.
          if (!key.ctrl && !key.meta && key.sequence.length >= 1 && !key.sequence.startsWith('\x1b')) {
            const printable = [...key.sequence].filter(ch => {
              const code = ch.charCodeAt(0)
              return code >= 32 && code !== 127
            }).join('')
            if (printable) { filter += printable; active = 0 }
          }
      }
      draw(caretOnly ? false : true)
    }
    // Mouse (opencode grammar): hover previews the row, a click commits it.
    // A click OUTSIDE the plate dismisses; a click on plate chrome (title,
    // filter, section, footer) is ignored — dismissing there made every
    // mis-click cancel the plate instead of doing nothing.
    const mouse = (event: MouseEvent): void => {
      if (finished) return
      if (event.wheel) {
        active = Math.min(Math.max(0, pickables().length - 1), Math.max(0, active + (event.button === 0 ? -1 : 1)))
        draw(false)
        return
      }
      if (event.press && !event.motion) {
        const slot = optionAt(event.x, event.y)
        if (slot >= 0) {
          const pick = pickables()[slot]
          done(pick?.value)
          return
        }
        const insideX = event.x > geometry.left && event.x <= geometry.left + geometry.width
        const insideY = event.y - 1 >= geometry.top && event.y - 1 < geometry.top + geometry.height
        // Inside the plate but not on a row: chrome click, ignore it.
        if (insideX && insideY) return
        done(undefined)
        return
      }
      if (event.motion) {
        const slot = optionAt(event.x, event.y)
        // Hover repaints INCREMENTALLY. A moving mouse produces a continuous
        // stream of motion reports; re-emitting the whole screen for each one is
        // what made the terminal freeze (measured: 200 events per 16ms frame
        // cost 73ms of painting, and the console fell behind its own writes).
        if (slot >= 0 && slot !== active) { active = slot; draw(false) }
      }
    }
    // `hover: true` asks the terminal for motion reports. It costs native text
    // selection, so it is scoped to this modal plate and dropped on detach —
    // and it is the only reason hover preview ever worked at all: the session
    // used to arm `?1002h` (button-motion only), which never delivers a
    // hover, so the documented "hover highlights a row" could not happen in a
    // real terminal no matter what the handler did.
    const stopInput = attachInput({
      key: onKey,
      // Paste filters the plate; newlines become spaces so a multi-line paste
      // stays one search line, and terminal escapes are stripped so a copied
      // coloured log cannot paint into the plate. Nothing submits by paste.
      paste: text => {
        if (finished) return
        const printable = pasteText(text).replace(/\n+/g, ' ')
        if (!printable) return
        filter += printable
        active = 0
        draw()
      },
      mouse,
      hover: true,
      out,
    })
    // A resized window redraws the plate: without this the page repaints under
    // a plate that is still the old size, so its pixels and its hit map are both
    // stale — clicking a row that LOOKS drawn does nothing.
    // A resize genuinely changes the geometry, so it IS a full repaint.
    const stopResize = screen ? screen.onResize(() => draw()) : () => {}
    // Claim the surface: the spinner must not paint through the plate.
    screen?.beginOverlay()
    detach = () => {
      stopResize()
      stopInput()
      // The plate painted over the frame, so our cache no longer describes what
      // is on screen. Without this the caller's next `render()` diffs against
      // the PRE-plate frame, matches every row, and leaves the plate on screen.
      screen?.endOverlay()
    }
    draw()
  })
}

/** Vertical cursor move inside the multi-line composer. Returns false when
 * already on the edge row (caller falls back to history). Column sticks. */
export function moveCursorRow(state: { input: string; cursor: number }, dir: -1 | 1): boolean {
  const lines = state.input.split('\n')
  const before = state.input.slice(0, state.cursor)
  const row = before.split('\n').length - 1
  const col = state.cursor - (before.lastIndexOf('\n') + 1)
  const next = row + dir
  if (next < 0 || next >= lines.length) return false
  let pos = 0
  for (let i = 0; i < next; i++) pos += (lines[i] ?? '').length + 1
  state.cursor = Math.min(pos + col, pos + (lines[next] ?? '').length)
  return true
}

/** Rounded panel box in the opencode dialog language. */
export function roundBox(title: string, body: string[], width: number, titleTone: MsgTone = 'cyan'): string[] {
  const inner = Math.max(10, width - 4)
  const lines = [`╭─ ${title} ${'─'.repeat(Math.max(0, inner - title.length - 3))}╮`]
  for (const b of body) lines.push(`│ ${padVisible(clipVisible(b, inner), inner)} │`)
  lines.push(`╰${'─'.repeat(inner + 2)}╯`)
  return lines.map((l, i) => (i === 0 ? tone(titleTone, l) : l))
}

/**
 * Wrought-iron panel (brand rule 4: thin 1px violet-iron border, 8px
 * radius in HTML → square box-chars in the terminal). Panel body sits on
 * plum ink so nested content reads as a plate, not floating text.
 */
export function ironPanel(title: string, body: string[], width: number, toneName: MsgTone = 'cyan'): string[] {
  const inner = Math.max(12, width - 4)
  const rule = '─'.repeat(inner + 2)
  const out = [
    tone(toneName, `╭${'─'.repeat(inner + 2)}╮`),
    tone(toneName, `╟─ ${title} ${'─'.repeat(Math.max(0, inner - title.length - 3))}╢`),
  ]
  for (const b of body) out.push(`${tone('dim', '│')} ${padVisible(clipVisible(b, inner), inner)} ${tone('dim', '│')}`)
  out.push(tone(toneName, `╰${rule}╯`))
  return out
}

/**
 * Boot splash (design board frame A0): the one screen with no composer and no
 * status line, so every row can go to the name. The crest is the existing
 * block-art mark, the wordmark is the 5 × 8 half-block table (data, not a
 * typeface), and the rule under it is a single row of accent cells — a cell
 * has only two colours to spend, so the rule is its own pass.
 *
 * Any keypress moves on to the home page; nothing here is interactive.
 */
export function bootSplashRows(width: number): string[] {
  // Never claim more columns than the caller has. The floor of 40 meant a
  // 24-column window got 40-column rows, which overflowed the frame and
  // scrolled the splash away.
  const w = Math.max(12, width)
  const centre = (text: string): string => {
    const clipped = clipVisible(text, w)
    return ' '.repeat(Math.max(0, Math.floor((w - visibleWidth(clipped)) / 2))) + clipped
  }
  const block: string[] = []
  // The brand mark first: the 4D cube (tesseract) as a still wireframe,
  // drawn only when the window can hold it whole — a clipped cube reads as
  // corrupted art, the same class of bug as clipped box-chars.
  if (w >= 36) {
    for (const row of tesseractRows(Math.min(w - 6, 30), 8, 0.9)) block.push(centre(tone(row.tone, row.text)))
    block.push('')
  }
  // The mark block already carries the tagline when it fits; below that it is
  // dropped whole rather than clipped mid-word.
  for (const row of wednesdayMark(w)) block.push(centre(row))
  // Half-block cells (square sub-pixels), same fill as the home wordmark: the
  // two identity frames are one design, not two textures. The last row is the
  // feet, already toned by the table.
  const wordmark = wordmarkRows(w)
  if (wordmark.length) {
    block.push('')
    for (const row of wordmark) block.push(centre(tone(row.tone, row.text)))
    // The single violet flourish: one accent row, never a second one.
    const ruleWidth = Math.min(w - 4, Math.max(4, visibleWidth(wordmark[0]?.text ?? '')))
    block.push(centre(tone('cyan', '─'.repeat(ruleWidth))))
  }
  return block
}

export class Screen {
  private out: NodeJS.WriteStream
  private width: number
  private height: number
  private entered = false
  private spin = 0
  private lastRoom = 10
  /**
   * Terminal focus (DECSET 1004). The home tesseract is the only thing that
   * repaints on a timer, and there is no point burning a CPU core animating a
   * window nobody is looking at — opencode pauses its render loop the same
   * way. Regaining focus forces one full repaint, because a terminal may have
   * dropped or reflowed rows while it was in the background.
   */
  private focused = true
  /** True while the kitty keyboard protocol is pushed (must be popped once). */
  private kittyArmed = false

  /**
   * The step the last PgUp used. PgDn subtracts exactly this, because drawing
   * the pager row shrinks the page between the two presses.
   */
  private pageStep: number | null = null
  /** Wheel acceleration state (Hermes' wheelAccel, native/xterm paths). */
  private wheelAccel: WheelAccelState = initWheelAccelForHost()
  /**
   * The state whose transcript the stream currently shows. Watchers that only
   * own a key (the build gate, Esc during a run) still need a target for a
   * wheel tick; readLine/watchRun keep this pointing at the live screen.
   */
  private lastState: ScreenState | null = null
  /** Where a left-button drag started (1-based frame cell), until it moves. */
  private dragAnchor: { row: number; col: number } | null = null
  /** Set when Ctrl+P asked for the palette; read by the next readLine call. */
  pendingPalette = false
  /**
   * The STOP control's hit box: the frame row and the columns of the button
   * drawn on the activity line while a turn is live.
   *
   * Esc was the only way to stop a turn, and the promise lived in a line of
   * prose. The button is drawn by the frame builder and measured by the same
   * builder, so the pixels and the hit box cannot drift apart (B187).
   */
  stopButton: { row: number; col: number; end: number } | null = null
  /**
   * Deliver a mouse press at a frame cell.
   *
   * The mouse path is otherwise reachable only through a real terminal, and
   * the stop control's hit box is exactly the kind of thing a test must be
   * able to poke: "the button is drawn" and "the button works" are two
   * different claims.
   *
   * @returns true when the press hit the stop control.
   */
  clickAt(state: ScreenState | null, row: number, col: number, button = 0): boolean {
    const event: MouseEvent = { button, x: col, y: row, wheel: false, motion: false, press: true }
    const hit = this.stopClick(state, event)
    if (!hit) this.selectEvent(state, event)
    return hit
  }
  /**
   * What the STOP control does. Set while a run watcher is attached (the
   * same callback Esc triggers), cleared when it detaches.
   */
  onStop: (() => void) | null = null
  /**
   * The draft the completion was computed for.
   *
   * The completion is recomputed only when the draft or the caret actually
   * moved: the frame repaints nine times a second while the brand mark turns,
   * and ranking thirty commands on every tick would be waste. The key is the
   * draft plus the caret position, because moving the caret changes what is
   * being completed.
   */
  private completionKey = ''
  /**
   * The draft whose completion panel the operator dismissed with Esc.
   *
   * The dismissal is armed against the TEXT: the next keystroke changes the
   * text and re-arms the panel, but moving the caret does not. Without this,
   * one Esc press left a panel that came back on the very next arrow key.
   */
  private completionDismissedFor: string | null = null
  /**
   * The search position the transcript was last scrolled to.
   *
   * The search brings its active hit into view — but only when the search
   * MOVED. Without this key the page would be yanked back to the hit on
   * every repaint, and the operator's own scrolling would be impossible
   * while a search was open.
   */
  private searchScrollKey = ''
  /** Set when Esc asked to interrupt a run (opencode footer promise). */
  requestAbort = false
  /**
   * The PASTE PAYLOADS behind the labels in the current draft.
   *
   * A paste is untrusted input, and a large one is unreadable in a composer
   * that shows eight rows: so it collapses to a label (`[pasted 1234 chars]`)
   * and the payload waits here until the draft is submitted. The caller
   * decides what the payload BECOMES — framed material for the model on the
   * request path, raw text on the command path (a command's argument is
   * something the app RUNS, not something a model reads).
   *
   * Ported from Qwen Code (Apache-2.0); see `paste-framing.ts`.
   */
  pendingPastes: Map<string, string> = new Map()
  /**
   * The session's paste counter.
   *
   * It never goes backwards, so two pastes of the SAME SIZE in one session
   * still get distinct labels — a label that stood for two different payloads
   * would send the wrong text to the model.
   */
  private pasteSeq = 0
  /**
   * Collapse a paste to a label when it is too big to read in the composer.
   *
   * Returns the text to insert: the label for a large paste, the text itself
   * for a small one. The payload of a large paste goes into the pending map.
   */
  private collapsePaste(text: string): string {
    if (!isLargePaste(text)) return text
    this.pasteSeq += 1
    const label = pastePlaceholder([...text].length, this.pasteSeq)
    this.pendingPastes.set(label, text)
    return label
  }
  /**
   * Put a recalled history entry back in the composer.
   *
   * A request that carried a paste is stored FRAMED, so the payload survives
   * the round trip; recalling it has to UNFRAME it: the composer shows the
   * operator's own characters with the paste collapsed back to its label, and
   * the payload waits in the pending map so the NEXT submit frames it again.
   * Without the map, a resubmit would send the bare label — the framing would
   * be a one-time accident instead of a rule.
   *
   * An entry whose payload is gone (a session restored from a transcript,
   * which keeps only the collapsed form) loses the label instead: square
   * brackets in front of the model would read as the operator's own words.
   */
  private recallDraft(state: ScreenState, entry: string): void {
    const restored = restorePasteDraft(entry)
    this.pendingPastes = restored.pending
    state.input = stripUnresolvedPlaceholders(restored.text, restored.pending)
    state.cursor = state.input.length
    // The counter moves past the ids the recall just used: a paste that comes
    // next must not reuse a label that already stands for another payload.
    for (const label of restored.pending.keys()) {
      const id = /\[pasted \d+ chars(?: #(\d+))?\]/.exec(label)?.[1]
      this.pasteSeq = Math.max(this.pasteSeq, id ? Number(id) : 1)
    }
  }
  /**
   * Visible column where the composer's input text starts. The cursor is
   * placed RELATIVE to this, because the box is centred on the home page and
   * flush left on the stream view — assuming column 1 parks the caret in the
   * margin beside the box.
   */
  private composerLeft = 1
  /** First visual row shown when the composer scrolls (wrapping + cap). */
  private composerVisualStart = 0
  /** Rotation angle of the home-page tesseract; advanced by the anim timer. */
  private cubeAngle = 0.9
  /** Home-page brand animation timer (null when the cube is still). */
  private cubeTimer: ReturnType<typeof setInterval> | null = null
  /** The state the cube animates, set on every home render. */
  private cubeState: ScreenState | null = null
  /** Cursor's visual row relative to the shown window. */
  private composerCursorVisual = 0
  /** Cursor's column inside its visual row (0-based, within inner). */
  private composerCursorCol = 0
  constructor(out: NodeJS.WriteStream = stdout, width?: number, height?: number) {
    this.out = out
    this.width = width ?? out.columns ?? 80
    this.height = height ?? out.rows ?? 24
    // A Screen built without an explicit size follows the LIVE terminal; every
    // test pins its size, the real harness never does (B93).
    this.followWidth = width === undefined
    this.followHeight = height === undefined
  }

  /** No explicit width given: the frame tracks the live terminal (B93). */
  private followWidth: boolean
  /** No explicit height given: the frame tracks the live terminal (B93). */
  private followHeight: boolean

  /**
   * Re-read the live terminal size before laying out. `stdout.on('resize')`
   * plus the per-keystroke `syncSize` heal MOST resizes, but a resize whose
   * event the console drops stays stale until the next keypress — and the
   * 120 ms spinner repaints the whole time in between, which is exactly the
   * clipped-Context-panel shape (B93). Two property reads per render are
   * free; `resize()` only fires when they actually moved, so steady state
   * costs nothing.
   *
   * Skipped while an overlay owns the screen (it paints at its own live size
   * via `dimensions()` and repaints itself) and for pinned test sizes.
   */
  private syncLiveSize(): void {
    if (this.overlayOpen()) return
    const w = this.followWidth ? this.out.columns : undefined
    const h = this.followHeight ? this.out.rows : undefined
    const width = typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : this.width
    const height = typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : this.height
    if (width !== this.width || height !== this.height) this.resize(width, height)
  }

  private resizeListeners = new Set<() => void>()

  /**
   * Current drawing size. Overlays read this instead of the width/height they
   * were opened with, so a resized window redraws them at the new size.
   */
  dimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /**
   * Run `listener` on every terminal resize, until the returned stop is called.
   *
   * Overlays paint on top of the frame rather than through it, so `render()` on
   * its own leaves them stale: dragging the window narrower with the command
   * plate open repainted the page underneath and left the plate's old pixels —
   * and its old hit map — on screen. Every overlay subscribes here instead.
   */
  onResize(listener: () => void): () => void {
    this.resizeListeners.add(listener)
    return () => { this.resizeListeners.delete(listener) }
  }

  resize(width: number, height: number): void {
    traceNote(`screen.resize ${width}x${height}`)
    this.width = width
    this.height = height
    // A real terminal resize is authoritative about its own contents: columns
    // that fall outside the window are gone, not stale. Recording the new extent
    // also keeps the tail-clear from OVERSHOOTING - padding a row out to the
    // previous width would write more columns than the terminal now has, and
    // every row would wrap. Padding is therefore only ever applied when the
    // frame width shrank WITHOUT the terminal being told, which is the one case
    // where the residue genuinely outlives the window.
    this.paintedWidth = width
    this.paintedHeight = height
    // Every row changes meaning at a new width, so the cache is worthless now.
    this.invalidate()
    for (const listener of [...this.resizeListeners]) {
      try { listener() } catch { /* one bad overlay must not break the others */ }
    }
  }

  /**
   * Enter the alternate screen and show the home page. NO splash.
   *
   * The boot splash was painted here and then overwritten by the first real
   * frame one tick later, so all it ever did was flash the crest for a fraction
   * of a second ("flash screen when i first start"). The splash survives as a
   * DESIGNED frame (design board A0, rendered by `preview.ts` from
   * `bootSplashRows`) rather than as a startup flash nobody asked for.
   *
   * NO mouse reporting here: the stream's input owner arms Hermes' wheel
   * preset when it attaches and detach() disarms it, so the pointer is never
   * left captured by a process that no longer reads it. Overlays arm their
   * own (hover-capable) preset for their lifetime.
   */
  enter(): void {
    if (this.entered) return
    this.entered = true
    traceNote('screen.enter')
    // Input protocols are armed for the WHOLE session, in one place:
    //  - 2004 bracketed paste: a pasted block can never be read as keystrokes,
    //    so a CRLF paste cannot submit the composer mid-way;
    //  - 1004 focus reporting: the animated mark pauses while the window is
    //    in the background;
    //  - kitty flag 1 (disambiguate): Shift+Enter, Ctrl+Enter and Ctrl+letter
    //    arrive as unambiguous CSI-u reports instead of Esc/Tab/CR lookalikes.
    // `WEDNESDAY_LEGACY_INPUT=1` keeps the screen but sends none of them, the
    // escape hatch for a terminal with a broken implementation (they are all
    // ignored by terminals that do not know them).
    const modern = modernInput()
    this.kittyArmed = modern
    this.out.write(`\x1b[?1049h\x1b[H\x1b[?25l${modern ? PASTE_ENABLE + FOCUS_ENABLE + KITTY_PUSH : ''}`)
    // One raw-mode transition for the whole session. Per-interaction toggling
    // flushed the ConPTY input queue and ate the operator's next keypress
    // (see attachInput); arming once here also keeps Ctrl+C from becoming a
    // SIGINT that kills the process mid-prompt, because the key paths own it.
    try { if (stdin.isTTY) stdin.setRawMode(true) } catch { /* piped */ }
    // The alternate screen starts blank: nothing on it came from us, so the
    // cached frame would wrongly claim every row already matches - and no
    // residue of ours is out there to clear either.
    this.paintedWidth = 0
    this.paintedHeight = 0
    this.invalidate()
  }

  /**
   * Paint the boot splash (design board A0) on demand.
   *
   * Not called during startup any more — see `enter()`. It stays as an explicit
   * call for the design board and for any future deliberate intro.
   */
  showSplash(): void {
    const w = fitWidth(this.width)
    const h = fitHeight(this.height)
    const block = bootSplashRows(w)
    const top = Math.max(0, Math.floor((h - block.length) / 2))
    const rows: string[] = Array.from({ length: h }, () => '')
    block.forEach((line, i) => {
      if (top + i < h) rows[top + i] = padVisible(line, w)
    })
    this.out.write(this.fullRepaint(rows, w, h))
  }

  exit(): void {
    if (!this.entered) return
    this.entered = false
    if (this.cubeTimer) { clearInterval(this.cubeTimer); this.cubeTimer = null }
    this.cubeState = null
    traceNote('screen.exit')
    // Belt and braces: every overlay disarms its own reporting on detach, but
    // an abnormal path (a throw between attach and detach) must never leave a
    // process holding the terminal's mouse — the classic stuck-cursor bug.
    try { this.out.write(mouseDisarm()) } catch { /* ignore */ }
    // Pop the keyboard protocol and drop the passive modes. A kitty push that
    // is never popped leaves the operator's next shell application reading
    // CSI-u reports it does not expect, which is worse than any feature here.
    let leave = ''
    if (this.kittyArmed) { leave += KITTY_POP; this.kittyArmed = false }
    leave += FOCUS_DISABLE + PASTE_DISABLE
    try { this.out.write(leave) } catch { /* ignore */ }
    // `?7h` is the safety net for a paint that died between `?7l` and its
    // restore: a terminal left with autowrap off turns every long line into
    // overwritten text instead of a wrap.
    this.out.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
    // Hand the terminal's line discipline back. Raw mode was armed once in
    // enter(); leaving it on past the session gives the operator a shell with
    // echo off and no Ctrl+C.
    try { if (stdin.isTTY) stdin.setRawMode(false) } catch { /* ignore */ }
    try { stdin.pause() } catch { /* already closed */ }
  }

  tick(): void {
    // A full cycle is 64 ticks: 8 verbs × 8 ticks each. 64 is a multiple of the
    // scanner's 4-phase pattern, so the scanner never skips a phase at the wrap
    // (the old 14-tick cycle did, once every ~1.7s).
    this.spin = (this.spin + 1) % (BUSY_VERBS.length * 8)
  }

  /** The current spin tick, for callers that animate off it (spinnerTick). */
  get spinIndex(): number {
    return this.spin
  }

  /**
   * One mouse report from the stream. Wheel up/down moves the transcript by
   * Hermes' accelerated step; every other report is ignored (the wheel preset
   * also delivers clicks, and a click on the transcript must not act).
   *
   * `state` is the screen the stream currently owns. `lastState` covers the
   * short windows where a key watcher (build gate) owns input but the wheel
   * should still work.
   */
  private wheelEvent(state: ScreenState | null, event: MouseEvent): void {
    if (!state || !event.wheel || event.motion) return
    // SGR buttons 64/65 decode to 0/1: 0 = wheel up (older), 1 = wheel down.
    const dir: -1 | 1 = event.button === 0 ? -1 : 1
    const rows = computeWheelStep(this.wheelAccel, dir, Date.now())
    if (rows === 0) return // deferred direction flip (encoder bounce probe)
    const next = Math.max(0, Math.min(this.lastMaxScroll, state.scroll - dir * rows))
    traceNote(`wheel dir=${dir} rows=${rows} scroll=${state.scroll}->${next} max=${this.lastMaxScroll}`)
    if (next === state.scroll) return
    state.scroll = next
    this.render(state)
  }

  /**
   * Mouse text selection over the transcript (opencode grammar): left-press
   * starts a selection at that frame row, drag extends it, release keeps it.
   * Right-click copies the current selection. The wheel is not selection.
   *
   * Selection lives in FRAME rows so the painter can highlight exactly what
   * the terminal reports, and copy reads `lastFrame` (ANSI-stripped), so what
   * you see is what lands on the clipboard.
   */
  private selectEvent(state: ScreenState | null, event: MouseEvent): void {
    if (!state || event.wheel) return
    // The STOP control is checked FIRST: a click on the button must never
    // start a text selection, and the selection must never swallow the stop.
    if (this.stopClick(state, event)) return
    // A left PRESS only clears and arms the drag: the selection appears when
    // the hand MOVES. Before this every click selected a whole line, and
    // there was no click anywhere that could remove a selection again.
    if (event.press && !event.motion && event.button === 0) {
      this.dragAnchor = { row: event.y, col: event.x }
      if (state.selection) {
        state.selection = null
        this.render(state)
      }
      return
    }
    if (event.motion && event.button === 0) {
      const anchor = this.dragAnchor
      if (!anchor) return
      // A motion report for the anchor cell itself is not a drag yet.
      if (!state.selection && anchor.row === event.y && anchor.col === event.x) return
      state.selection = { row: anchor.row, col: anchor.col, toRow: event.y, toCol: event.x }
      this.render(state)
      return
    }
    // Release of the left button ends the drag and KEEPS the selection; a
    // later click anywhere is what removes it.
    if (!event.press && event.button === 0) { this.dragAnchor = null; return }
    // Right-click release with a selection: copy it (mouse-only copy path).
    if (!event.press && event.button === 2 && state.selection) {
      this.dragAnchor = null
      this.copySelectionReceipt(state)
    }
  }

  /**
   * The STOP control, by mouse.
   *
   * One action, two ways: Esc and the button on the activity line perform the
   * SAME interrupt, so the operator never has to guess whether the app is
   * listening. The hit box is the one the frame builder measured when it
   * painted the button, so a resize cannot leave a button on screen that
   * clicks nothing.
   *
   * @returns true when the click was the stop button.
   */
  private stopClick(state: ScreenState | null, event: MouseEvent): boolean {
    const button = this.stopButton
    if (!button || !state || event.wheel || event.motion) return false
    // An overlay paints over the frame: the button is not on screen any more,
    // so its hit box is not live either.
    if (this.overlayOpen()) return false
    if (!event.press || event.button !== 0) return false
    if (event.y !== button.row || event.x < button.col || event.x > button.end) return false
    this.requestAbort = true
    this.onStop?.()
    return true
  }

  /**
   * Copy the current selection and say so. One path for all three ways to
   * copy (right-click, Ctrl+C while composing, Ctrl+C while a run is live)
   * so the toast, the cleared selection and the clipboard can never drift.
   *
   * Returns false when there was no selection: callers that treat Ctrl+C as
   * "interrupt" must only do so when there is nothing to copy.
   */
  private copySelectionReceipt(state: ScreenState | null): boolean {
    if (!state?.selection) return false
    const n = this.copySelection(state)
    state.selection = null
    this.notify(state, n > 0 ? `copied ${n} line${n === 1 ? '' : 's'} to the clipboard` : 'selection is empty — nothing copied')
    return true
  }

  /**
   * Copy the selected frame rows to the clipboard. OSC 52 is the terminal
   * clipboard protocol; on Windows also pipe through `clip.exe` because
   * conhost ignores OSC 52. Returns the number of lines copied (0 = empty).
   */
  copySelection(state: ScreenState): number {
    const sel = state.selection
    if (!sel) return 0
    const range = normaliseSelection(sel)
    const first = Math.max(1, range.row)
    const last = Math.min(this.lastFrame.length, range.toRow)
    const lines: string[] = []
    for (let row = first; row <= last; row++) {
      const plain = (this.lastFrame[row - 1] ?? '').replace(ANSI_RE, '')
      const width = columnsOf(plain)
      // Cell-exact columns: the first row starts at the anchor, the last row
      // ends after the cursor cell, everything between is whole.
      const start = row === range.row ? Math.max(0, range.col - 1) : 0
      const end = row === range.toRow ? Math.max(start, range.toCol) : width
      const a = indexAtColumn(plain, Math.min(start, width))
      const b = indexAtColumn(plain, Math.min(end, width))
      lines.push(plain.slice(a, b).replace(/[ \t]+$/g, ''))
    }
    const text = lines.join('\n')
    if (!text.trim()) return 0
    try {
      // OSC 52, wrapped for tmux/screen when the environment says so: an
      // unwrapped sequence inside tmux is swallowed and copy looks broken.
      this.out.write(osc52Sequence(text))
    } catch { /* terminal without OSC 52 — the Windows path below covers it */ }
    if (process.platform === 'win32') {
      // `clip.exe` reads redirected stdin in the CONSOLE code page, not UTF-8,
      // so every box character, star and arrow in our own frame landed in the
      // clipboard as mojibake — copy worked and the paste was garbage. Plain
      // ASCII keeps the fast, dependency-free path; anything else is handed to
      // PowerShell through base64, which is encoding-proof because no text
      // ever crosses the command line.
      try {
        if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) {
          const encoded = Buffer.from(text, 'utf8').toString('base64')
          spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $t`,
          ], { windowsHide: true })
        } else {
          spawnSync('clip', { input: text, windowsHide: true })
        }
      } catch { /* no clip.exe/powershell — the toast still tells the operator what happened */ }
    }
    return lines.length
  }

  /** Wrap the selected frame rows in inverse video at paint time. */
  private highlightSelection(state: ScreenState, body: string): string {
    const sel = state.selection
    if (!sel) return body
    const range = normaliseSelection(sel)
    const rows = body.split('\n')
    const first = Math.max(1, range.row)
    const last = Math.min(rows.length, range.toRow)
    for (let row = first; row <= last; row++) {
      const start = row === range.row ? Math.max(0, range.col - 1) : 0
      const end = row === range.toRow ? Math.max(start, range.toCol) : Number.POSITIVE_INFINITY
      rows[row - 1] = inverseColumns(rows[row - 1] ?? '', start, end)
    }
    return rows.join('\n')
  }

  /**
   * The home page owns the animated brand mark (brand rule 14: a mark moves
   * when it is the active state). A ~9 fps timer advances the tesseract's
   * rotation and repaints; it stops the moment the page is left, an overlay
   * owns the surface, the stream is not a TTY (tests/pipes get one still
   * frame), or WEDNESDAY_NO_ANIM=1 is set.
   */
  private driveCube(state: ScreenState): void {
    if (state.home && !state.dialog) this.cubeState = state
    const s = this.cubeState
    const want = !!s && s.home && !s.dialog && !this.overlayOpen() && this.focused
      && !!this.out.isTTY && (process.env.WEDNESDAY_NO_ANIM ?? '') !== '1'
    if (want && !this.cubeTimer) {
      this.cubeTimer = setInterval(() => {
        const live = this.cubeState
        if (!live || !live.home || this.overlayOpen() || !this.focused) {
          // Backgrounded window: stop the timer entirely, not just this tick.
          if (!this.focused && this.cubeTimer) { clearInterval(this.cubeTimer); this.cubeTimer = null }
          return
        }
        this.cubeAngle += 0.16
        this.render(live)
      }, 110)
      if (typeof this.cubeTimer.unref === 'function') this.cubeTimer.unref()
    } else if (!want && this.cubeTimer) {
      clearInterval(this.cubeTimer)
      this.cubeTimer = null
    }
  }

  /**
   * The right-edge transcript scrollbar, Hermes grammar: a `│` track and a `█`
   * thumb, one column wide, positioned from the same offset the renderer uses.
   * Returns one string per viewport row (empty when the transcript fits).
   */
  private scrollbarRows(total: number, viewport: number, scroll: number): string[] {
    const rows: string[] = Array.from({ length: viewport }, () => '')
    if (viewport <= 0 || total <= viewport) return rows
    const thumb = Math.max(1, Math.round((viewport * viewport) / total))
    const travel = Math.max(1, viewport - thumb)
    const maxScroll = Math.max(1, total - viewport)
    const pos = Math.max(0, Math.min(maxScroll, maxScroll - scroll))
    const top = Math.round((pos / maxScroll) * travel)
    for (let i = 0; i < viewport; i++) {
      rows[i] = i >= top && i < top + thumb ? tone('plain', '█') : tone('dim', '│')
    }
    return rows
  }

  /**
   * Rows a message will occupy at the given width, using the SAME layout the
   * frame uses (panel rows reflow, plain rows wrap). `push` needs this to keep
   * a scrolled-up reader anchored when new output arrives below them.
   */
  private messageRows(message: ScreenMessage, width: number): number {
    if (message.panel) return answerPanel(message.panel, width).length
    const plain = message.text.replace(ANSI_RE, '')
    return Math.max(1, wrap(plain, Math.max(1, width)).length)
  }

  /**
   * Terminal focus changed (DECSET 1004). Losing focus stops the home mark's
   * timer; regaining it repaints ONE FULL frame, because a terminal may have
   * reflowed or dropped rows while the app was not painting and the row cache
   * would otherwise keep writing a diff into a page that no longer matches.
   */
  onFocus(state: ScreenState | null, focused: boolean): void {
    const was = this.focused
    this.focused = focused
    if (focused && !was) {
      const target = state ?? this.lastState
      if (target) {
        this.invalidate()
        this.render(target)
      }
    }
  }

  /** True while the terminal window has focus (and animation is allowed). */
  get hasFocus(): boolean {
    return this.focused
  }

  /**
   * Listen for Esc/Ctrl+C while a run is live. `readLine` is not reading
   * during `submitAndRun`, so without this the footer promise ("esc
   * interrupts") could never fire — the key had no listener at all.
   * Returns a stop function; call it when the run ends.
   */
  watchInterrupt(onInterrupt: () => void): () => void {
    // The STOP button on the activity line performs the SAME interrupt as
    // Esc: one action, two ways to ask for it.
    this.onStop = onInterrupt
    const stop = attachInput({
      key: key => {
        // Copy wins over interrupt when text is selected: a drag is an
        // explicit "this text" gesture, and aborting the run under it is the
        // worst possible answer. `lastState` is the screen the watcher paints.
        if (key.ctrl && key.name === 'c' && this.copySelectionReceipt(this.lastState)) return
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          this.requestAbort = true
          onInterrupt()
        }
      },
      focus: focused => this.onFocus(this.lastState, focused),
      // The build/analysis window still owns the transcript: a wheel tick
      // scrolls it instead of going nowhere, and a drag selects text.
      mouse: event => { this.wheelEvent(this.lastState, event); this.selectEvent(this.lastState, event) },
      out: this.out,
    })
    return () => { stop(); this.requestAbort = false; this.onStop = null }
  }

  /**
   * Keyboard while a run is live: Esc/Ctrl+C interrupt, and everything else
   * composes the NEXT request instead of vanishing.
   *
   * A working agent should not make the operator sit on their hands. Typing
   * during a run used to be swallowed by `watchInterrupt` (only Esc and Ctrl+C
   * were read), so a person who lined up three tasks watched their words
   * disappear. The draft is editable here exactly like the composer; Enter
   * hands it to `onQueue` and clears the box, and the queued line runs as soon
   * as the current task finishes.
   */
  watchRun(
    state: ScreenState,
    onInterrupt: () => void,
    onQueue: (text: string) => void,
    onSlash?: () => void,
  ): () => void {
    this.lastState = state
    // The STOP button on the activity line performs the SAME interrupt as
    // Esc: one action, two ways to ask for it.
    this.onStop = onInterrupt
    const insert = (text: string): void => {
      if (!text) return
      state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor)
      state.cursor += text.length
    }
    const stop = attachInput({
      key: key => {
        if (key.ctrl && key.name === 'c' && this.copySelectionReceipt(state)) return
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          this.requestAbort = true
          onInterrupt()
          return
        }
        if (key.name === 'return') {
          if (state.input.trim()) onQueue(state.input)
          return
        }
        if (key.name === 'backspace') {
          if (key.ctrl || key.meta) {
            const from = prevWordStart(state.input, state.cursor)
            state.input = state.input.slice(0, from) + state.input.slice(state.cursor)
            state.cursor = from
          } else if (state.cursor > 0) {
            state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor)
            state.cursor -= 1
          }
          this.render(state)
          return
        }
        if (key.name === 'left') {
          state.cursor = key.ctrl || key.meta ? prevWordStart(state.input, state.cursor) : Math.max(0, state.cursor - 1)
          this.render(state)
          return
        }
        if (key.name === 'right') {
          state.cursor = key.ctrl || key.meta ? nextWordEnd(state.input, state.cursor) : Math.min(state.input.length, state.cursor + 1)
          this.render(state)
          return
        }
        if (key.name === 'delete') {
          const to = key.ctrl || key.meta ? nextWordEnd(state.input, state.cursor) : Math.min(state.input.length, state.cursor + 1)
          if (to > state.cursor) state.input = state.input.slice(0, state.cursor) + state.input.slice(to)
          this.render(state)
          return
        }
        if (key.name === 'home' || (key.ctrl && key.name === 'a')) { state.cursor = 0; this.render(state); return }
        if (key.name === 'end' || (key.ctrl && key.name === 'e')) { state.cursor = state.input.length; this.render(state); return }
        if (key.ctrl && key.name === 'u') {
          state.input = state.input.slice(state.cursor)
          state.cursor = 0
          this.render(state)
          return
        }
        if (key.ctrl && key.name === 'k') {
          state.input = state.input.slice(0, state.cursor)
          this.render(state)
          return
        }
        if (key.ctrl && key.name === 'w') {
          const from = prevWordStart(state.input, state.cursor)
          state.input = state.input.slice(0, from) + state.input.slice(state.cursor)
          state.cursor = from
          this.render(state)
          return
        }
        if (key.ctrl || key.meta) return
        const printable = [...(key.sequence ?? '')].filter(ch => {
          const code = ch.charCodeAt(0)
          return code >= 32 && code !== 127
        }).join('')
        if (!printable) return
        const before = state.input.slice(0, state.cursor)
        insert(printable)
        // A lone "/" on an empty draft opens the command plate IMMEDIATELY,
        // exactly as it does on the idle composer (opencode grammar) — before
        // this branch, typing "/" mid-run only queued a literal "/" and the
        // menu never appeared, which read as "commands do not work while a
        // task runs".
        if (state.input === '/' && before === '' && printable === '/') {
          state.input = ''
          state.cursor = 0
          this.pendingPalette = true
          this.render(state)
          onSlash?.()
          return
        }
        this.render(state)
      },
      paste: raw => {
        // Same rule as the idle composer: text goes in as a block (newlines
        // kept), terminal escapes/controls stripped, nothing runs, and a
        // pasted "/" never opens the plate. A LARGE paste collapses to a label
        // here too — the queued request is framed for the model when the queue
        // is drained, and a wall of text in the composer helps nobody.
        const text = pasteText(raw)
        if (!text) return
        insert(this.collapsePaste(text))
        this.render(state)
      },
      focus: focused => this.onFocus(state, focused),
      mouse: event => { this.wheelEvent(state, event); this.selectEvent(state, event) },
      out: this.out,
    })
    return () => { stop(); this.requestAbort = false; this.pendingPalette = false; this.onStop = null }
  }


  push(state: ScreenState, message: ScreenMessage): void {
    // Sticky follow, Hermes grammar: at the tail the view follows new output;
    // scrolled up, the same rows stay on screen. `scroll` counts rows above
    // the newest line, so keeping the reader anchored means adding the rows
    // this message contributes below them.
    const w = fitWidth(this.width)
    const transcriptWidth = Math.max(1, w - (w >= 8 ? 2 : 0))
    const added = this.messageRows(message, transcriptWidth)
    state.messages.push(message)
    if (state.messages.length > 200) state.messages.splice(0, state.messages.length - 200)
    if (state.scroll > 0) state.scroll += added
    state.toast = null
    this.render(state)
  }

  /**
   * ONE row, rewritten in place.
   *
   * A live row is found by its key, never by its index: the transcript caps
   * at 200 messages and any other push can move the row, so an index would
   * rewrite the WRONG line — and a row that is rewritten by index is how a
   * second run silently overwrites the first run's receipt (B186).
   *
   * The key must be unique per unit of work (per turn, per run). A key
   * reused across two turns makes the second turn eat the first turn's row.
   */
  live(state: ScreenState, key: string, message: ScreenMessage): void {
    const marked: ScreenMessage = { ...message, live: key }
    const index = state.messages.findIndex(m => m.live === key)
    if (index < 0) {
      this.push(state, marked)
      return
    }
    // A rewrite changes the row's HEIGHT (the answer grows), so the scroll
    // arithmetic has to know: `push` adds rows, a rewrite can add or remove
    // them. Measuring both sides is the only way the reader's position
    // survives a live row that grows under them.
    const w = fitWidth(this.width)
    const transcriptWidth = Math.max(1, w - (w >= 8 ? 2 : 0))
    const before = this.messageRows(state.messages[index]!, transcriptWidth)
    const after = this.messageRows(marked, transcriptWidth)
    state.messages[index] = marked
    if (state.scroll > 0) state.scroll = Math.max(0, state.scroll + (after - before))
    this.render(state)
  }

  /**
   * The attention bell (2026-11-07).
   *
   * The bytes go through the screen's OWN writer, never through
   * process.stdout: the screen owns an alternate buffer, and a raw write to
   * a different handle can land in the middle of a painted frame.
   *
   * A bell that cannot be written is not an error. It is a courtesy, and a
   * courtesy must never be the thing that breaks a run.
   */
  bell(bytes: string): void {
    if (!bytes) return
    try {
      this.out.write(bytes)
    } catch {
      // A closed terminal is not a failure the operator can act on.
    }
  }

  /** Transient notice (opencode toast grammar): shown until next push. */
  notify(state: ScreenState, text: string, ms = 4000): void {
    state.toast = text
    this.render(state)
    // Board E1: a notice expires instead of sitting forever. The timer is
    // unref'd so it never holds the process open; a newer toast wins.
    const seen = text
    const timer = setTimeout(() => {
      if (state.toast === seen) {
        state.toast = null
        try { this.render(state) } catch { /* session may be gone */ }
      }
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * Composer rows (top rail + one row per logical line + bottom rail), the
   * same block the stream view and the home page both draw.
   */
  /**
   * The completion for the current draft, or null.
   *
   * Recomputed only when the draft or the caret moved (see `completionKey`).
   * The file index is LAZY: `completionFor` asks for it only when the operator
   * has actually typed an `@`, so the common case — typing a command — never
   * touches the filesystem.
   */
  private computeCompletion(state: ScreenState): CompletionState | null {
    const commands = state.completionCommands
    // While the transcript search is open the composer is not the focus: two
    // panels over one screen is one panel too many.
    if (!commands || commands.length === 0 || state.dialog || state.search) return null
    return completionFor(state.input, state.cursor, {
      commands,
      files: state.completionFiles,
      recent: state.completionRecent,
    })
  }

  /**
   * Keep `state.completion` in step with the draft.
   *
   * The completion is recomputed ONLY when the draft or the caret moved: the
   * frame repaints eight times a second while the brand mark turns, and
   * ranking thirty commands on every tick would be waste. When nothing
   * moved, the existing state is kept — that is what preserves the ACTIVE
   * INDEX after an Up/Down press.
   */
  private refreshCompletion(state: ScreenState): void {
    const key = `${state.cursor}\u0000${state.input}`
    if (key === this.completionKey) return
    this.completionKey = key
    // A dismissal is armed against the TEXT, not the caret: moving the caret
    // must not re-open a panel the operator deliberately closed.
    if (this.completionDismissedFor === state.input) {
      state.completion = null
      return
    }
    this.completionDismissedFor = null
    const next = this.computeCompletion(state)
    // The invariant "the active index is always inside the list" is enforced
    // by the engine, not by luck: a list that shrinks under a moved selection
    // must not leave the operator pointing past its own end (B176).
    state.completion = next ? clampActive(next) : null
  }

  /**
   * Accept the active candidate into the draft.
   *
   * The candidate replaces the token the caret was in; the rest of the draft
   * survives. The caret lands right after the inserted NAME — before the
   * trailing space, so the operator can keep typing the argument.
   *
   * @returns true when something was accepted.
   */
  private acceptCompletion(state: ScreenState): boolean {
    const completion = state.completion
    if (!completion || completion.items.length === 0) return false
    const item = completion.items[completion.active]
    if (!item) return false
    // A ghost that is an ARGUMENT HINT (`/tasks` -> `<id>`) is a hint, not
    // text: accepting it would type `<id>` into the draft.
    if (!completion.panel && completion.exact) return false
    const next = completion.panel
      ? acceptedText(state.input, completion)
      : acceptedGhostText(state.input, completion)
    const before = state.input.slice(0, completion.start)
    const after = state.input.slice(completion.end)
    const inserted = next.length - before.length - after.length
    state.input = next
    // The caret lands at the END of the inserted text — INCLUDING the space a
    // command gets. A caret left right after the command name would sit back
    // inside the token it just completed, and the panel would reopen on the
    // same candidate the operator just accepted (B189).
    state.cursor = completion.start + inserted
    state.completion = null
    this.completionKey = ''
    return true
  }

  /**
   * The completion panel: the candidates, drawn above the composer.
   *
   * qwen-code's rule: a completion at the LINE START opens a list; one in the
   * MIDDLE of a sentence is ghost text only, because a three-letter
   * completion must not steal the screen the operator is reading.
   *
   * The list shows a window of the candidates around the active one, so the
   * active row is ALWAYS visible — an active row outside the window is the
   * B176 bug in a new hat.
   */
  private completionRows(state: ScreenState, width: number): string[] {
    const completion = state.completion
    if (!completion || !completion.panel || completion.items.length === 0) return []
    const active = Math.max(0, Math.min(completion.active, completion.items.length - 1))
    const total = completion.items.length
    // The window follows the active row and never runs off either end.
    let first = Math.max(0, Math.min(active - Math.floor(COMPLETION_VISIBLE / 2), total - COMPLETION_VISIBLE))
    if (total <= COMPLETION_VISIBLE) first = 0
    const last = Math.min(total, first + COMPLETION_VISIBLE)
    const rows: string[] = []
    const label = completion.items[active]?.kind === 'command' ? 'commands' : 'files'
    const more = total > COMPLETION_VISIBLE
      ? ` · ${first + 1}-${last} of ${total}`
      : ` · ${total}`
    rows.push(clipVisible(`${tone('cyan', '▸')} ${tone('dim', `${label}${more} · ↑↓ move · tab accept · esc dismiss`)}`, width))
    for (let i = first; i < last; i++) {
      const item = completion.items[i]!
      const on = i === active
      const mark = on ? tone('cyan', '❯') : ' '
      const name = item.label.padEnd(16)
      const body = `${mark} ${name}${item.detail ? tone('dim', ` ${item.detail}`) : ''}`
      rows.push(on ? tone('bold', clipVisible(body, width)) : clipVisible(body, width))
    }
    return rows
  }

  /**
   * The search panel: the query, the counter and the ways out.
   *
   * The COUNTER is the point of the panel. A search that finds something but
   * cannot say how much more there is leaves the operator pressing Enter
   * forever, wondering whether they have reached the end. `3/12` says both
   * where they are and how much is left.
   *
   * The keys in the hint are the keys that are actually bound — the search
   * panel is the one place where a lie about a key is worst, because the
   * operator is already typing.
   */
  private searchRow(state: ScreenState, width: number): string {
    const search = state.search
    if (!search) return ''
    const counter = searchLabel(search.active, search.total)
    const left = `${tone('cyan', '▸')} ${search.query ? tone('bold', search.query) : tone('dim', 'type to search the transcript…')}`
    const right = tone('dim', `${counter} · enter next · shift+enter prev · esc close`)
    const gap = width - visibleWidth(left) - visibleWidth(right)
    const body = gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : `${left} ${right}`
    return clipVisible(body, width)
  }

  private composerRows(state: ScreenState, w: number): string[] {
    // Hermes' prompt: two full-width rules and a lit caret. No box — the box
    // was the one element that made Wednesday read as a different product.
    //
    // The rules are BEAMS now (2026-11-04): the violet ramp is dark at the
    // edges and lit in the middle, so the composer reads as a HUD rail rather
    // than two grey hyphens. Characters are untouched (`─`), so every layout
    // assertion and every wrap/scroll measurement still holds.
    const rule = (marker?: string): string => {
      const tail = marker ? ` ${marker}` : ''
      const beam = glowRule(Math.max(1, w - tail.length))
      return tail ? `${beam}${tone('cyan', tail)}` : beam
    }
    const inner = Math.max(1, w - 2)
    const MAX_VISUAL = 8
    const inputLines = state.input.split('\n')
    const visual: Array<{ text: string; blank: boolean }> = []
    for (const ln of inputLines) {
      if (ln === '') { visual.push({ text: '', blank: true }); continue }
      const parts = wrap(ln, inner)
      if (parts.length === 0) { visual.push({ text: '', blank: true }); continue }
      for (const part of parts) visual.push({ text: part, blank: false })
    }
    // Cursor's visual row: wrapped segments before the cursor plus the segment
    // offset inside its logical line.
    const beforeCursor = state.input.slice(0, state.cursor)
    const beforeLines = beforeCursor.split('\n')
    let cursorVisual = 0
    for (let li = 0; li < beforeLines.length - 1; li++) {
      cursorVisual += Math.max(1, wrap(beforeLines[li]!, inner).length)
    }
    const lastLine = beforeLines[beforeLines.length - 1] ?? ''
    const curLogical = state.input.slice(0, state.cursor).split('\n').length - 1
    const curText = state.input.split('\n')[curLogical] ?? ''
    const curSegs = curText === '' ? [''] : wrap(curText, inner)
    let curOff = lastLine.length
    let cursorColVisual = 0
    for (const seg of curSegs) {
      if (curOff <= seg.length) { cursorColVisual = curOff; break }
      curOff -= seg.length + 1
      cursorColVisual = seg.length
    }
    cursorVisual += Math.min(curSegs.length - 1, Math.floor(lastLine.length / Math.max(1, inner)))
    cursorVisual = Math.min(cursorVisual, Math.max(0, visual.length - 1))
    cursorColVisual = Math.max(0, Math.min(inner, cursorColVisual))
    let start = 0
    let hiddenAbove = 0
    let hiddenBelow = 0
    if (visual.length > MAX_VISUAL) {
      start = Math.min(Math.max(0, cursorVisual - MAX_VISUAL + 1), visual.length - MAX_VISUAL)
      hiddenAbove = start
      hiddenBelow = visual.length - (start + MAX_VISUAL)
    }
    const shown = visual.slice(start, start + MAX_VISUAL)
    const empty = state.input === ''
    // The GHOST TEXT (qwen-code's `midInputGhostText`): the rest of the best
    // candidate, shown dim AT THE CARET. It is a suggestion, not content, so
    // it is drawn dim and never becomes part of the draft.
    const ghost = state.completion?.panel === false ? state.completion.ghost : ''
    const ghostRow = ghost ? cursorVisual - start : -1
    const ghostCol = ghost ? cursorColVisual : 0
    // The prompt's own hint: a configuration question first (readConfigLine
    // writes it into status), then the harness's invitation. While a run is
    // live the activity line above the meter carries the busy hints, so the
    // prompt keeps its invitation instead of repeating them.
    const hint = empty
      ? (state.busy
        ? (state.placeholder || 'Type / to browse commands, or Ctrl+P for the palette')
        : (state.status || state.placeholder || 'Type a request, or / for commands'))
      : ''
    const rows: string[] = [rule(hiddenAbove > 0 ? `▲${hiddenAbove}` : undefined)]
    shown.forEach((row, i) => {
      const prefix = i === 0 ? `${tone('cyan', '❯')} ` : '  '
      let body = empty ? tone('dim', clipVisible(hint, inner)) : row.text
      // Splice the ghost in at the caret, on the caret's own row.
      if (i === ghostRow && ghost) {
        const at = Math.max(0, Math.min(ghostCol, body.length))
        body = `${body.slice(0, at)}${tone('dim', ghost)}${body.slice(at)}`
      }
      rows.push(clipVisible(`${prefix}${body}`, w))
    })
    rows.push(rule(hiddenBelow > 0 ? `▼${hiddenBelow}` : undefined))
    this.composerVisualStart = start
    this.composerCursorVisual = cursorVisual - start
    this.composerCursorCol = cursorColVisual
    return rows
  }

  /**
   * The status meter (Hermes' battery / model / ctx / bar / clock line):
   * context spend, the model answering, the session clock and the turn clock.
   *
   * Segments are dropped WHOLE from the right as the terminal narrows — a
   * half-drawn bar or a model id cut mid-word reads as a rendering fault, and
   * Hermes' own width tiers (wide / medium / narrow) are the model for that.
   */
  private meterRow(state: ScreenState, w: number): string {
    const tokens = state.side?.tokens ?? 0
    // `ctx` is WINDOW PRESSURE, not session spend: the last request's prompt.
    // A cumulative count divided by the window printed `29.3K/13.0K` — bigger
    // than the window it claims to measure — which reads as a front-end bug.
    const contextTokens = state.side?.contextTokens ?? tokens
    const limit = state.side?.limit ?? 0
    const pct = limit > 0 ? Math.min(100, Math.round((contextTokens / limit) * 100)) : null
    // Hermes names the single model answering. Wednesday routes a pipeline, so
    // when the seats disagree the honest label is the crew, not one seat's id.
    const model = state.crewLabel ?? state.composerLabel ?? 'wednesday'
    // The provider prefix ate the name (`openrouter/nvidia/nemot…`, operator
    // screenshot 2026-11-04). The route is implied by the model id and already
    // visible in `/status`; the meter shows the model.
    const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
    const modelShort = bare.length > 26 ? `${bare.slice(0, 25)}…` : bare
    const compact = (n: number): string => n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n)
    const ctxTone: MsgTone = pct === null ? 'dim' : pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'dim'
    const live = state.busy && state.turnStartedAt != null
    const turnMs = live ? Date.now() - (state.turnStartedAt ?? Date.now()) : (state.turnMs ?? 0)
    const sessionMs = state.startedAt ? Date.now() - state.startedAt : 0
    const wide = w >= 76
    const medium = w >= 52
    // One idea per segment, and each idea ONCE: the old row said 0% twice (a
    // `⚡ 0%` badge and a `[░░] 0%` bar), showed two clocks (1m 20s and a 0s
    // turn), and used emoji (`⚡ ☤ ⏲`) that Windows Terminal rendered as
    // coloured pictographs — operator report: "flash emuji ... looks os bad"
    // (2026-11-04). Identity, pressure, time.
    const segments: string[] = []
    // The model segment is ALWAYS segment 0. The previous version wrote the
    // shortened label into segment 1 — which is the ctx slot — so narrowing the
    // meter REPLACED the context reading with a second model and brought the
    // `☤` pictograph back (operator screenshot, 2026-11-04). One builder, one
    // segment, one mark.
    const modelSegment = (label: string): string => `${tone('cyan', '✦')} ${tone('bold', label)}`
    segments.push(modelSegment(modelShort))
    if (medium && limit > 0) segments.push(tone(ctxTone, `ctx ${compact(contextTokens)}/${compact(limit)}${pct === null ? '' : ` ${pct}%`}`))
    const branch = gitBranch(process.cwd())
    if (wide && branch) segments.push(tone('dim', `⎇ ${branch}`))
    if (medium) segments.push(tone('dim', this.meterDuration(sessionMs)))
    // The turn clock only exists while a turn is running; an idle `0s` was the
    // second clock the meter did not need.
    if (wide && live) segments.push(tone('dim', `turn ${this.meterDuration(turnMs)}`))
    // Hermes' last segment: the session's whole token spend, `Σ1.2K`. Only
    // once there is something to count — `Σ0` is noise, not a receipt.
    if (wide && tokens > 0) segments.push(tone('dim', `Σ${compact(tokens)}`))
    const sep = tone('dim', wide ? ' │ ' : ' · ')
    // Drop whole segments from the right as the terminal narrows — a half-drawn
    // bar or a model id cut mid-word reads as a rendering fault. The model and
    // the ctx reading survive longest: the model is abbreviated before the
    // context pressure is lost.
    while (segments.length > 2 && visibleWidth(` ${segments.join(sep)}`) > w) segments.pop()
    // The model id is the one segment that must never be cut mid-word
    // (`qwen2.5-coder-3b-in` in the operator's 2026-11-04 screenshot): shorten
    // it with an ellipsis, then drop it, rather than slicing characters.
    let label = modelShort
    while (segments.length > 1 && visibleWidth(` ${segments.join(sep)}`) > w && visibleWidth(label) > 6) {
      label = `${label.slice(0, -2)}…`
      segments[0] = modelSegment(label)
    }
    // Still too wide: the right-hand segments go, one whole segment at a time.
    while (segments.length > 1 && visibleWidth(` ${segments.join(sep)}`) > w) segments.pop()
    // The model alone and still too wide: shorten it again to a readable floor
    // rather than letting the row clip the id mid-word.
    while (segments.length === 1 && visibleWidth(` ${segments[0]}`) > w && visibleWidth(label) > 4) {
      label = `${label.slice(0, -2)}…`
      segments[0] = modelSegment(label)
    }
    return clipVisible(` ${segments.join(sep)}`, w)
  }

  /** Compact duration for the meter: 8s, 2m 3s, 1h 2m. */
  private meterDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }

  /**
   * The banner (Hermes' start frame): a rounded panel whose top border carries
   * the version, a left column with the mark and the session's identity, and a
   * right column listing what the session HAS (crew, command groups) with a
   * summary line. A capability panel is not a receipt for work that has not
   * happened; it says what the session is, the way Hermes lists toolsets and
   * skills before the first message.
   */
  private bannerRows(state: ScreenState, w: number, h: number): string[] {
    const cols = bannerColumns(w)
    const leftW = cols.left
    const rightW = cols.right
    const model = (state.crewLabel ?? state.composerLabel ?? 'wednesday').split('/').pop() ?? 'wednesday'
    const limit = state.side?.limit ?? 0
    const provider = (process.env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || 'openrouter'
    // Hermes' banner is a HERO ART on the left, then model / cwd / session at the
    // bottom of that column; the right column is the capability catalog. The
    // wordmark is not in the panel — it prints above it on a tall, wide screen.
    // Brand rule: the banner's hero art IS the 4D cube — the tesseract mark
    // (same shape as site/icon.svg), drawn as braille wireframe and animated
    // on the home page via cubeAngle. The old baked gate plate is gone from
    // the product.
    const art: string[] = leftW >= 24 && h >= 20
      ? tesseractRows(Math.min(leftW, 30), Math.min(9, Math.max(3, h - 16)), this.cubeAngle)
          .map(row => tone(row.tone, clipVisible(row.text, leftW)))
      : []
    // Hermes drops WHOLE meter segments instead of cutting a word: a clipped
    // `openroute` reads as a broken build, not a tight column. Same rule here —
    // model first, then context, then provider, each only if it still fits.
    const fitAtBoundary = (text: string, room: number): string => {
      if (text.length <= room) return text
      const cut = text.slice(0, Math.max(2, room - 1))
      const boundary = cut.lastIndexOf('-')
      return `${(boundary > 2 ? cut.slice(0, boundary) : cut).slice(0, Math.max(2, room - 1))}…`
    }
    const modelLabel = fitAtBoundary(model, leftW)
    const ctx = limit > 0 ? `${Math.round(limit / 1024)}K context` : ''
    const extras: string[] = []
    if (ctx && `${modelLabel} · ${ctx}`.length <= leftW) extras.push(ctx)
    if (provider && `${modelLabel} · ${[...extras, provider].join(' · ')}`.length <= leftW) extras.push(provider)
    const info: string[] = []
    info.push(`${tone('cyan', modelLabel)}${extras.length ? tone('dim', ` · ${extras.join(' · ')}`) : ''}`)
    // The banner names the CREW when the seats answer, but a route-only pick
    // left it looking frozen on the old seat model (operator, 2026-11-05:
    // "i select nemotron lighting ... still qwen showing in home tab"). Show
    // the selected route as its own dim line whenever it differs from the
    // seats — one glance explains why the run still uses the seats.
    const routeModel = (state.composerLabel ?? '').trim()
    const seatModel = (state.crewLabel ?? '').trim()
    if (routeModel && seatModel && routeModel !== seatModel) {
      info.push(tone('dim', clipVisible(`route ${routeModel}`, leftW)))
    }
    info.push(tone('dim', clipVisible(process.cwd(), leftW)))
    if (state.sessionId) info.push(tone('dim', `Session: ${state.sessionId}`))
    const right: string[] = []
    for (const row of state.side?.rows ?? []) {
      // Capability headings are the HUD's section plates: a brand star, the
      // group in caps, then a violet-grey rule to the column edge. Every other
      // row is `label: values`, so the label is lit and the values recede.
      if (row.text === 'Available Crew' || row.text === 'Available Commands') {
        const label = row.text.toUpperCase()
        const room = Math.max(0, rightW - visibleWidth(label) - 3)
        right.push(`${tone('cyan', '✦')} ${tone('bold', label)} ${bevel('─'.repeat(room), 'side')}`)
        continue
      }
      if (row.text === '') { right.push(''); continue }
      const at = row.text.indexOf(': ')
      if (at > 0 && row.tone === 'dim') {
        right.push(`${tone('cyan', row.text.slice(0, at))}${tone('dim', row.text.slice(at))}`)
        continue
      }
      right.push(tone(row.tone, clipVisible(row.text, rightW)))
    }
    const rows = Math.max(art.length + info.length + 1, right.length, 3)
    const left: string[] = []
    if (art.length) left.push(...art)
    while (left.length < rows - info.length) left.push('')
    left.push(...info)
    const body: string[] = []
    for (let i = 0; i < rows; i++) {
      const l = padVisible(clipVisible(left[i] ?? '', leftW), leftW)
      const r = rightW > 0 ? padVisible(clipVisible(right[i] ?? '', rightW), rightW) : ''
      // Hermes Panel(padding=(0,2)): two cells inside each edge, two between
      // the grid columns. The verticals wear the body edge, so the panel is a
      // lit surface and not a default-foreground box.
      body.push(`${bevel('│', 'side')}  ${l}${rightW > 0 ? `  ${r}` : ''}  ${bevel('│', 'side')}`)
    }
    const titleText = state.bannerTitle?.trim()
    const topInner = Math.max(0, w - 2)
    const decorated = titleText ? ` ✦ ${titleText} ` : ''
    const lead = decorated ? Math.max(0, Math.floor((topInner - visibleWidth(decorated)) / 2)) : 0
    const top = decorated
      ? `${bevel('╭', 'top')}${bevel('─'.repeat(lead), 'side')}${tone('cyan', ' ✦ ')}${tone('bold', `${titleText} `)}${bevel('─'.repeat(Math.max(0, topInner - lead - visibleWidth(decorated))), 'side')}${bevel('╮', 'top')}`
      : `${bevel('╭', 'top')}${bevel('─'.repeat(topInner), 'side')}${bevel('╮', 'top')}`
    return [top, ...body, `${bevel('╰', 'bottom')}${bevel('─'.repeat(topInner), 'bottom')}${bevel('╯', 'bottom')}`]
  }

  /**
   * Hermes' compact banner (`╔═══╗`): two content rows and a double rule, used
   * when the window cannot hold the hero panel. Same information order — the
   * name + tagline first, the version second.
   */
  private compactBannerRows(state: ScreenState, w: number): string[] {
    const width = Math.max(4, Math.min(w - 2, 88))
    const inner = width - 2
    // Hermes clips this line, but a name cut mid-word (`frontier-gra`) reads as
    // a bug. Trim at the last whole word and mark the cut instead.
    const tag = 'small open models, staffed as a coding team'
    const fitWords = (text: string, room: number): string => {
      if (text.length <= room) return text
      const cut = text.slice(0, Math.max(1, room - 1))
      const at = cut.lastIndexOf(' ')
      return `${at > 0 ? cut.slice(0, at) : cut}…`
    }
    const tagline = fitWords(` · ${tag}`, inner - 12)
    const version = state.bannerTitle ?? 'wednesday'
    const line = (text: string): string => `║ ${padVisible(clipVisible(text, inner), inner)} ║`
    return [
      tone('cyan', `╔${'═'.repeat(width)}╗`),
      line(`${tone('cyan', '✦')} ${tone('bold', 'WEDNESDAY')}${tone('dim', tagline)}`),
      line(tone('dim', version)),
      tone('cyan', `╚${'═'.repeat(width)}╝`),
    ]
  }

  /**
   * The pager frame: Hermes' page — the title centred, the answer windowed,
   * the position line under it. `enter` pages, `esc/q` closes; the body gets
   * everything the chrome does not take, but never zero.
   */
  private pagerFrame(state: ScreenState, w: number, h: number): string[] {
    const pager = state.pager!
    const title = pager.title.trim()
    // The page's title IS the HUD plate now: the same star-and-rail heading
    // the home panel uses, so a command answer belongs to the same product as
    // the start page instead of looking like a second app's transcript.
    const titleRow = title ? hudPlate(title, w) : ''
    const rows: string[] = []
    if (titleRow) { rows.push(titleRow); rows.push('') }
    // The window and the key step are ONE number (pagerWindowSize): the frame
    // and Enter can never disagree about how much a page is.
    const window = pagerWindowSize(h, !!title)
    const { shown, offset, atEnd } = pagerWindow(pager.lines, window, pager.offset)
    const hint = pagerHint(pager.lines.length, offset + shown.length, atEnd)
    for (let i = 0; i < window; i++) {
      const line = shown[i]
      // Reports (status/doctor/help) carry the URLs an operator wants to open;
      // link the row before clipping so the zero-width OSC 8 wrapper cannot
      // change what the width maths sees.
      rows.push(line === undefined ? '' : clipVisible(autoLinkRow(hudLine(line, w)), w))
    }
    // The hint row doubles as the pager's receipt row: a copy made here must
    // say so HERE, because the stream's toast row is not painted while the
    // pager owns the window. Without it Ctrl+C looked dead on the one surface
    // an operator reads before copying.
    const hintRow = state.toast
      ? tone('cyan', clipVisible(`${toastMark()} ${state.toast}`, w))
      : tone('dim', clipVisible(hint, w))
    rows.push(hintRow)
    // Selection is painted here as well as in the stream: the pager is a
    // reading surface, so a drag must show the rows it will copy.
    return this.highlightSelection(state, rows.join('\n')).split('\n').slice(0, h)
  }

  /**
   * Open Hermes' pager over the whole window, MODAL like the approval gate:
   * the promise resolves when the pager closes, and the caller must await it —
   * an un-awaited page let the next `readLine` attach a second input listener
   * while the pager still owned the keyboard, so every key was processed twice
   * (`G` paged the pager AND typed a G into the composer behind it).
   *
   * Keys are Hermes' own: `↑↓/jk` line, `enter/space/pgdn` page (auto-close on
   * the last page), `b/pgup` back, `g/G` top/bottom, `esc/q` close. The wheel
   * scrolls too — a pager is a reading surface and the hand is already there.
   */
  page(state: ScreenState, title: string, lines: string[]): Promise<void> {
    // A report usually repeats its own name as its first line ("Wednesday
    // Status", "Wednesday Doctor"). The pager's plate is that title now, so
    // the body copy is dropped rather than printed twice in a row.
    const head = lines[0]?.trim().toLowerCase() ?? ''
    const plainTitle = title.trim().toLowerCase()
    const body = head === plainTitle || head === `wednesday ${plainTitle}`
      ? lines.slice(lines[1] === '' ? 2 : 1)
      : lines
    state.pager = { title, lines: body, offset: 0 }
    this.invalidate()
    this.render(state)
    // The page size is the frame's own window, computed LIVE on every move:
    // the first version captured `h` at open, so a resize mid-read paged by a
    // stale step (the window showed N rows, Enter jumped N-2) and the offset
    // drifted off what the frame could show. `pagerWindowSize` below is the
    // single source both the frame and the keys read.
    return new Promise(resolve => {
      const close = (): void => {
        detach()
        state.pager = null
        this.invalidate()
        this.render(state)
        resolve()
      }
      const move = (delta: number | 'top' | 'bottom'): void => {
        if (!state.pager) return
        // LIVE page size: a resize mid-read changes the window, and paging by
        // the size captured at open would drift off what the frame shows.
        const pageSize = pagerWindowSize(fitHeight(this.height), !!state.pager.title.trim())
        const max = Math.max(0, state.pager.lines.length - pageSize)
        const step = delta === 'top' ? -state.pager.lines.length : delta === 'bottom' ? state.pager.lines.length : delta
        const next = Math.max(0, Math.min(state.pager.offset + step, max))
        if (next === state.pager.offset) return
        state.pager.offset = next
        this.invalidate()
        this.render(state)
      }
      const detach = attachInput({
        key: key => {
          // A selection made on the pager is the operator pointing at text;
          // Ctrl+C copies it instead of closing the page. Without this the one
          // surface built for reading was the one place copy did not work.
          if (key.ctrl && key.name === 'c' && this.copySelectionReceipt(state)) return
          const ch = (key.sequence ?? '').toLowerCase()
          if (key.name === 'escape' || (key.ctrl && key.name === 'c') || ch === 'q') { close(); return }
          if (key.name === 'up' || ch === 'k') { move(-1); return }
          if (key.name === 'down' || ch === 'j') { move(1); return }
          if (key.name === 'pageup' || ch === 'b') { move(-pageSize); return }
          // `G` (bottom) must be tested on the RAW sequence: lowercasing first
          // would fold it into `g` (top) and make the two Hermes keys the same.
          if (key.sequence === 'G') { move('bottom'); return }
          if (ch === 'g') { move('top'); return }
          if (key.name === 'return' || key.sequence === ' ' || key.name === 'pagedown') {
            if (!state.pager) return
            const pageSize = pagerWindowSize(fitHeight(this.height), !!state.pager.title.trim())
            const max = Math.max(0, state.pager.lines.length - pageSize)
            if (state.pager.offset >= max) { close(); return }
            move(pageSize)
            return
          }
        },
        mouse: event => {
          // Drag-select and right-click copy work on the pager too: it paints
          // `lastFrame`, so what is highlighted is exactly what is copied.
          this.selectEvent(state, event)
          if (!event.wheel || event.motion) return
          const dir: -1 | 1 = event.button === 0 ? -1 : 1
          // offset counts from the TOP, the transcript's scroll from the
          // BOTTOM: wheel-up (dir -1) must move toward offset 0 here, the
          // opposite sign of the stream. The first version negated it and the
          // wheel scrolled the pager backwards.
          move(dir * 3)
        },
        out: this.out,
      })
    })
  }

  private homeFrame(state: ScreenState, w: number, h: number): string[] {
    // Hermes' start page: the wordmark (when it fits) ABOVE the hero panel,
    // then welcome + tip, then the bottom-anchored meter and prompt. Below 95
    // columns, or on a short window, the compact `╔═╗` banner takes over.
    const compact = w < 95 || h < 26
    const banner = compact ? this.compactBannerRows(state, w) : this.bannerRows(state, w, h)
    const prompt = this.composerRows(state, w)
    const meter = this.meterRow(state, w)
    // A home-page action (a model switch, a reconnect) has no transcript to
    // push into, so its receipt is the toast row directly above the meter.
    const toast = state.toast
      ? [tone('cyan', clipVisible(`${toastMark()} ${state.toast}`, w))]
      : []
    // The update banner rides directly above the meter, bottom-anchored with
    // the rest of the tail, so it is on the home screen at every height while
    // a newer release exists — not a stream line that scrolls away.
    const notice = state.updateNotice
      ? [tone('yellow', clipVisible(`▲ ${state.updateNotice}`, w))]
      : []
    const tail = [...toast, ...notice, meter, ...prompt]
    // Identity art, richest first: the wordmark above the banner (the cube
    // lives INSIDE the banner's left column now — one brand mark, one place).
    // Each block drops WHOLE when the page cannot hold it — a clipped glyph
    // reads as corruption, never as a smaller logo.
    //
    // Centred, with the brand one-liner under it and a violet beam under the
    // banner: the page reads as a title plate, not as text pinned to column 1.
    const centre = (text: string, room: number): string => {
      const vis = visibleWidth(text)
      return ' '.repeat(Math.max(0, Math.floor((room - vis) / 2))) + text
    }
    const mark = !compact ? wordmarkRows(w - 4) : []
    const caption = 'small open models, staffed as a coding team'
    const markBlock: string[] = []
    if (mark.length > 0 && visibleWidth(mark[0]!.text) <= w - 4) {
      for (const row of mark) markBlock.push(centre(tone(row.tone, row.text), w))
      if (w >= caption.length + 10) markBlock.push(centre(tone('dim', `· ${caption} ·`), w))
    }
    const horizon = glowRule(w)
    const head: string[] = []
    const logoFits = markBlock.length > 0
      && markBlock.length + 1 + banner.length + 1 + 3 + tail.length <= h
    if (logoFits) {
      head.push(...markBlock)
      head.push('')
    }
    // The banner is the page. When the window cannot hold it whole, the
    // identity line carries the screen instead of a frame with its bottom
    // chopped off - a broken border reads as a crash.
    if (h >= head.length + banner.length + tail.length + 3) {
      head.push(...banner)
      // The horizon is the one pure-decoration row, so it yields first: a beam
      // that pushes the welcome (or the prompt) off the page is a worse page.
      if (h >= head.length + 1 + tail.length + 5) head.push(horizon)
    } else {
      const model = state.composerLabel ?? 'wednesday'
      head.push(`${tone('cyan', model)}${tone('dim', ` · ${process.cwd()}`)}`)
      if (state.sessionId && h >= 18) head.push(tone('dim', `Session: ${state.sessionId}`))
    }
    head.push('')
    if (h >= head.length + tail.length + 3) {
      // Hermes wraps the welcome line rather than clipping it, and its tip can
      // run to two rows. A chopped sentence at 60 columns is worse than a
      // shorter page.
      const welcome = wrap('Welcome to Wednesday! Type your message or /help for commands.', Math.max(20, w))
      if (welcome.length === 1) {
        head.push(`${tone('plain', 'Welcome to Wednesday!')}${tone('dim', ' Type your message or /help for commands.')}`)
      } else {
        head.push(tone('plain', welcome[0] ?? ''))
        for (const line of welcome.slice(1)) head.push(tone('dim', line))
      }
      if (state.tip && h >= head.length + tail.length + 5) {
        for (const line of wrap(`✦ Tip: ${state.tip}`, Math.max(20, w))) head.push(tone('dim', line))
      }
      head.push('')
    }
    // Bottom-anchored: Hermes' prompt sits under a scrolling transcript, so the
    // meter and prompt are the last rows of the page at every height.
    const room = Math.max(0, h - tail.length)
    const rows = head.slice(0, room)
    while (rows.length < room) rows.push('')
    rows.push(...tail)
    this.composerTop = rows.length - prompt.length
    this.composerLeft = 0
    this.lastRoom = Math.max(1, room - head.length)
    return rows.slice(0, h).map(line => padVisible(clipVisible(line, w), w))
  }  /**
   * The current frame as ANSI text, WITHOUT the cursor-addressing write.
   * Overlays call this to repaint the live screen beneath a floating plate —
   * that is what keeps the background visible behind a popup.
   */
  frame(state: ScreenState): string {
    this.syncLiveSize()
    // The STOP control's hit box belongs to the frame that DREW it. A new
    // frame starts without one, so a button that scrolled away cannot be
    // clicked from its old position.
    this.stopButton = null
    const w = fitWidth(this.width)
    const h = fitHeight(this.height)
    // The pager owns the window exactly as the approval gate does: no banner,
    // no composer, no meter. A command's answer is the whole screen.
    if (state.pager && !state.dialog) {
      this.lastFrame = this.pagerFrame(state, w, h).map(line => padVisible(line, w))
      return this.lastFrame.join('\n')
    }
    if (state.home && !state.dialog) {
      this.lastRoom = Math.max(1, h - 8)
      this.lastFrame = this.homeFrame(state, w, h).map(line => padVisible(line, w))
      // homeFrame knows where its own prompt starts (the banner's frame also
      // contains `╭`, so searching for the first corner found the BANNER and
      // parked the caret on it). Trust the builder.
      return this.lastFrame.join('\n')
    }
    // No header: the banner is the header and it belongs to the start page,
    // exactly as Hermes' banner scrolls away once the session begins. The
    // transcript starts at row 1, which is three more rows for the work.
    const contentWidth = w
    // Hermes' transcript is narrower than its composer: one cell of padding
    // plus a one-cell scrollbar gutter at the right edge. The gutter is
    // reserved even when nothing scrolls, so text never rewraps the moment the
    // bar appears (the exact reason Hermes reserves it).
    const streamGutter = w >= 8 ? 2 : 0
    const transcriptWidth = Math.max(1, w - streamGutter)
    const lines: string[] = []

    // The card's own chrome is 5 rows (title, prompt, blank, buttons, hint) and
    // the frame spends 3 on the header plus 1 on the status line. The body gets
    // what is left, but NEVER zero: a card that says "Ready to run" without
    // saying what is about to run is the one thing this screen must not do, and
    // the old `h - 12` budget dropped every field on a 12-row window.
    const bodyBudget = Math.max(1, h - 9)
    const labelRoom = Math.max(6, Math.min(12, Math.floor(contentWidth / 4)))
    const valueRoom = Math.max(8, contentWidth - labelRoom - 4)
    // Each field is a GROUP of rows (label line + wrapped continuations), so the
    // budget can drop whole fields instead of slicing a value in half.
    // Each row remembers whether it really has a label (B92). A row that does
    // not is prose, and the renderer must not slice a label out of it.
    interface BodyRow { text: string; label: boolean }
    const groups: BodyRow[][] = []
    if (state.dialog) {
      for (const raw of state.dialog.body.split('\n')) {
        const at = raw.indexOf(': ')
        if (at < 0) {
          // Prose: wrap it as one block, indented under the value column, and
          // mark it label-less so the renderer leaves the text whole (B92).
          //
          // The wrap width is `valueRoom`, NOT `valueRoom + labelRoom`: the row
          // already carries `labelRoom + 2` spaces of indent, and the card adds
          // its rail. Wrapping wider than the room actually available silently
          // clips the tail — `clipVisible` eats it and the sentence loses its
          // last word with nothing to say so.
          groups.push(wrap(raw, valueRoom).map(part => ({ text: `${' '.repeat(labelRoom + 2)}${part}`, label: false })))
          continue
        }
        const label = raw.slice(0, at)
        const parts = wrap(raw.slice(at + 2), valueRoom)
        groups.push([
          { text: `${label.padEnd(labelRoom)}${parts[0] ?? ''}`, label: true },
          ...parts.slice(1).map(part => ({ text: `${' '.repeat(labelRoom)}${part}`, label: true })),
        ])
      }
    }
    // Fields are cut FROM THE END, never the start: the objective is the first
    // field and the one thing this card must never lose, and the previous
    // `slice(-budget)` kept the tail — on a 12-row window it showed the file
    // list and hid what was about to be run.
    const budget = Math.max(1, h - 9)
    const kept: BodyRow[] = []
    const receipt: BodyRow = { text: '', label: false }
    let dropped = 0
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!
      if (kept.length + group.length <= budget) { kept.push(...group); continue }
      if (kept.length === 0) {
        // The objective alone does not fit. Show its first line; the fold
        // below SAYS how much is hidden — a silently clipped value is the
        // "hidden thing" complaint, and this is the field that matters most.
        kept.push(group[0]!)
        dropped += group.length - 1
      } else {
        dropped += group.length
      }
      // Every field after this one is gone too, so the fold counts the
      // whole missing tail, not only the row that did not fit — a
      // `+2 more line(s)` under an empty Time/Create list read as "two
      // lines lost", not "the run's only proof never made it".
      for (let j = i + 1; j < groups.length; j++) dropped += groups[j]!.length
      break
    }
    // Say what was left out rather than truncating in silence. ONE row,
    // never two: the old code emitted a fold row both inside the budget
    // loop and again here, so a 12-row window printed two identical
    // `… +3 more line(s)` lines back to back.
    if (dropped > 0 && kept.length < budget) kept.push({ ...receipt, text: `${' '.repeat(labelRoom + 2)}… +${dropped} more line(s)` })
    const dialogBody = kept
    // title + body + blank + buttons + hint + prompt. Budget the PROMPT row even
    // when it is empty: under-counting here grows the stream room past the frame
    // and the card's last row falls off the bottom.
    const dialogRows = state.dialog ? dialogBody.length + 7 : 0
    const toastRows = state.toast ? 1 : 0
    // Requests queued while a run is live (Hermes' queue panel): the count and
    // the list sit directly above the meter, so a queued request is never
    // invisible just because the composer is busy.
    const queued = state.dialog ? [] : state.queued ?? []
    const queueRows = queued.length ? queued.length + 1 : 0
    // The crew dock (Hermes' agents panel) sits above the queue: who is
    // working, on what, for how long. Measured on every frame because the
    // collapsed/expanded choice depends on the terminal's height.
    const crewRows = state.dialog ? [] : crewStripRows(state, contentWidth, h)
    // The sticky-prompt row is ALWAYS reserved in the session view: appearing
    // only while scrolled would shrink the page mid-scroll, so the transcript
    // jumped a row and PgDn could not return to the newest line exactly.
    const pagerRows = state.dialog ? 0 : 1
    // Live activity line above the meter (Hermes' spinner line above its
    // status bar). It carries the interrupt/queue hints for the whole run,
    // which the empty-prompt placeholder cannot do once a draft is typed.
    const busyRows = !state.dialog && state.busy ? 1 : 0
    // The prompt height is MEASURED, not assumed: a multiline draft wraps and
    // caps at 8 visual rows, so a fixed count undercounted the chrome and the
    // closing rule fell off the frame.
    const boxRows: string[] = state.dialog ? [] : this.composerRows(state, contentWidth)
    // The completion panel sits directly ABOVE the composer, so the list it
    // draws is never hidden behind the prompt. Its rows are counted in the
    // chrome: a panel that pushed the transcript off the frame would make the
    // page jump every time a completion opened.
    const completionRows = state.dialog ? [] : this.completionRows(state, contentWidth)
    // The search panel sits above the composer too, and takes the completion
    // panel's place: while the search is open the composer is not the focus.
    // Its ROW COUNT is reserved here — the count is known — and its CONTENT
    // is drawn after the hits have been found, because the counter in it is
    // only true once they have been.
    const searchRowCount = state.dialog || !state.search ? 0 : 1
    const chrome = boxRows.length + 1 + busyRows + pagerRows + queueRows + crewRows.length + dialogRows + toastRows + completionRows.length + searchRowCount // prompt + meter + activity + pager + queue + crew + dialog + toast + completion + search
    const room = Math.max(1, h - chrome)
    this.lastRoom = room
    const wrapped: Array<{ text: string; tone: MsgTone }> = []
    // Where each operator prompt starts and ends in the wrapped transcript.
    // The sticky line needs this: Hermes shows `❯ last prompt` only when no
    // user message is on screen and the newest one is above the viewport.
    const userMarks: Array<{ start: number; end: number; text: string }> = []
    for (const m of state.messages) {
      const start = wrapped.length
      // A response panel is laid out at THIS width, so a resize reflows it.
      if (m.panel) {
        for (const row of answerPanel(m.panel, transcriptWidth)) wrapped.push(row)
      } else {
        // Wrap on VISIBLE columns: a styled line must wrap like a plain one.
        const plain = m.text.replace(ANSI_RE, '')
        for (const part of wrap(plain, Math.max(1, transcriptWidth))) {
          wrapped.push({ text: part === '' ? '' : part, tone: m.tone })
        }
        if (m.text.startsWith('❯ ')) userMarks.push({ start, end: wrapped.length, text: m.text.slice(2) })
      }
    }
    // ── Transcript search (Ctrl+F) ────────────────────────────────────────
    // The hits are found in the RENDERED transcript (the wrapped rows), not
    // in the raw messages: the operator reads the wrapped page, and a phrase
    // that straddles a wrap is ONE phrase to them and two to the message
    // list.
    const search = state.search
    let hits: SearchMatch[] = []
    let searchRow = ''
    if (search) {
      hits = findMatches(wrapped.map(row => row.text), search.query)
      search.total = hits.length
      search.active = hits.length === 0
        ? 0
        : Math.max(0, Math.min(search.active, hits.length - 1))
      // Bring the active hit into view — but ONLY when the search moved.
      // The operator's own scrolling must not be fought over by a search that
      // has not changed.
      const key = `${search.query}\u0000${search.active}\u0000${search.total}`
      if (key !== this.searchScrollKey) {
        this.searchScrollKey = key
        const row = hits[search.active]?.segments[0]?.row
        if (row !== undefined) {
          state.scroll = Math.max(0, wrapped.length - row - 1 - Math.floor(room / 2))
        }
      }
      // The panel is drawn AFTER the hits: its counter has to be true.
      searchRow = this.searchRow(state, contentWidth)
    }
    const maxScroll = Math.max(0, wrapped.length - room)
    state.scroll = Math.min(state.scroll, maxScroll)
    // Published for the composer: PgUp/PgDn page against this ceiling, so the
    // stored offset can never run past the rows that exist.
    this.lastMaxScroll = maxScroll
    const visible = state.scroll === 0 ? wrapped.slice(-room) : wrapped.slice(-room - state.scroll, -state.scroll)
    // The first WRAPPED row on screen. The search marks rows by their index
    // in the wrapped transcript, so the visible rows have to be mapped back.
    const firstVisibleRow = state.scroll === 0
      ? Math.max(0, wrapped.length - room)
      : Math.max(0, wrapped.length - room - state.scroll)
    // Hermes' sticky prompt: scrolled away from the tail, the last thing the
    // operator asked stays visible above the composer. Shown only when no user
    // message is on screen — once one is visible the transcript speaks for
    // itself and the line would repeat it.
    const visibleEnd = wrapped.length - state.scroll
    const visibleStart = Math.max(0, visibleEnd - room)
    let stickyPrompt = ''
    if (state.scroll > 0 && !userMarks.some(mark => mark.end > visibleStart && mark.start < visibleEnd)) {
      for (let i = userMarks.length - 1; i >= 0; i--) {
        const mark = userMarks[i]!
        if (mark.end <= visibleStart) {
          stickyPrompt = mark.text.replace(/\s+/g, ' ').trim()
          break
        }
      }
    }
    if (state.toast) lines.push(tone('cyan', clipVisible(`${toastMark()} ${state.toast}`, contentWidth)))
    // Plain transcript rows, Hermes grammar: tone carries the meaning, not a
    // side rail. The rail was opencode's; it made every row a quote. The
    // scrollbar gutter is part of every transcript row, blank when the
    // transcript fits, so a long session has the same right edge as a short one.
    const bars = this.scrollbarRows(wrapped.length, room, state.scroll)
    // The search hits, grouped by the row they are on. The ACTIVE hit is
    // drawn in reverse video and the others on a violet wash: the operator
    // must be able to see at a glance which one the counter is talking about.
    const hitsByRow = new Map<number, Array<{ start: number; end: number; active: boolean }>>()
    if (hits.length) {
      hits.forEach((hit, index) => {
        for (const segment of hit.segments) {
          const list = hitsByRow.get(segment.row) ?? []
          list.push({ start: segment.start, end: segment.end, active: index === search?.active })
          hitsByRow.set(segment.row, list)
        }
      })
    }
    for (let i = 0; i < room; i++) {
      const v = visible[i]
      // Bare URLs in a transcript row become OSC 8 hyperlinks. Link the PLAIN
      // row first: running the detector over SGR-styled text let the URL match
      // swallow the trailing reset byte and put it INSIDE the OSC 8 parameter.
      // The row is already wrapped, so the zero-width OSC 8 wrapper cannot
      // change the column maths (ANSI_RE strips them).
      let text = v ? autoLinkRow(v.text) : ''
      // The search mark goes on AFTER the links: the OSC 8 wrapper is
      // zero-width, so the plain-text offsets the search reports still land
      // on the same characters.
      const rowHits = v ? hitsByRow.get(firstVisibleRow + i) : undefined
      if (rowHits) {
        for (const hit of rowHits) {
          text = highlightPlainRange(
            text,
            hit.start,
            hit.end,
            hit.active ? '\x1b[7m' : '\x1b[48;2;93;67;160m',
            hit.active ? '\x1b[27m' : '\x1b[49m',
          )
        }
      }
      const body = v ? clipVisible(tone(v.tone, text), transcriptWidth) : ''
      lines.push(padVisible(body, transcriptWidth) + (streamGutter ? ` ${bars[i] ?? ' '}` : ''))
    }

    if (state.dialog) {
      // Approval gate, Hermes grammar: a double-ruled warn panel, the plan as
      // reviewable lines, numbered choices under a `▸` cursor, one key-hint row.
      const d = state.dialog
      const innerW = Math.max(4, contentWidth - 4)
      const top = `╔${'═'.repeat(Math.max(0, contentWidth - 2))}╗`
      const bottom = `╚${'═'.repeat(Math.max(0, contentWidth - 2))}╝`
      const row = (text: string): string => `║ ${padVisible(clipVisible(text, innerW), innerW)} ║`
      lines.push(tone('yellow', clipVisible(top, contentWidth)))
      lines.push(row(`${tone('yellow', d.headline ?? '⚠ approval required')}${tone('dim', ` · ${d.title}`)}`))
      // `dialogBody` already carries the label column. A label is dim, its value
      // plain, so the eye lands on what is about to happen. A prose row keeps
      // its words whole (B92) and sits under the panel's left padding.
      for (const b of dialogBody) {
        if (!b.label) {
          lines.push(row(tone('plain', b.text.trimStart())))
          continue
        }
        lines.push(row(`${tone('dim', padVisible(b.text.slice(0, labelRoom).trimEnd(), labelRoom))}  ${b.text.slice(labelRoom)}`))
      }
      if (d.prompt.trim()) lines.push(row(tone('bold', d.prompt)))
      const focus = d.focus === 'run' ? 'run' : 'cancel'
      const choices = d.choices ?? APPROVAL_CHOICES
      for (const choice of choiceRows(focus, choices, innerW)) lines.push(row(choice))
      lines.push(row(tone('dim', d.hint ?? approvalHint(innerW))))
      lines.push(tone('yellow', clipVisible(bottom, contentWidth)))
    } else {
      // Footer, bottom up (Hermes grammar): activity line, pager note, queue
      // panel, meter, then the prompt. The prompt is LAST so the caret row is
      // always the second-to-last row of the frame.
      if (state.busy) {
        const spin = `${scannerFrame(this.spin)} `
        const base = `${tone('cyan', spin)}${tone('dim', state.status || busyStatus(this.spin))}`
        // Hermes puts the live clock beside the spinner; drop it whole on a
        // narrow window rather than clipping the hints that follow it.
        const clock = state.turnStartedAt
          ? tone('dim', ` ${this.meterDuration(Date.now() - state.turnStartedAt)}`)
          : ''
        const left = base + clock
        // The STOP control (2026-11-04): a live turn must be stoppable with
        // the MOUSE, not only with Esc. The button is drawn on the frame and
        // carries its own hit box, so what the operator sees is what the
        // click hits. It is right-aligned: the left side carries the status
        // text, and a control that sits ON the status text is a control that
        // covers the truth.
        const stopMark = glyph('stop')
        const stopLabel = `${stopMark} stop`
        const leftWidth = visibleWidth(left)
        const labelWidth = visibleWidth(stopLabel)
        const gap = contentWidth - leftWidth - labelWidth
        let body = left
        let stopCol = 0
        let stopEnd = 0
        if (gap >= 2) {
          body = left + ' '.repeat(gap) + tone('red', stopLabel)
          stopCol = leftWidth + gap + 1
          stopEnd = stopCol + labelWidth - 1
        } else if (contentWidth - leftWidth >= 1) {
          // Too narrow for the word: the MARK alone is still a button.
          body = left + ' '.repeat(contentWidth - leftWidth - 1) + tone('red', stopMark)
          stopCol = contentWidth
          stopEnd = contentWidth
        }
        this.stopButton = stopCol > 0 ? { row: lines.length + 1, col: stopCol, end: stopEnd } : null
        lines.push(clipVisible(body, contentWidth))
      } else {
        this.stopButton = null
      }
      // Sticky prompt, Hermes grammar: scrolled away from the tail, the last
      // request the operator made sits directly above the meter, prefixed with
      // the same `❯` as the composer. The row is always reserved (see
      // `pagerRows`) so scrolling never changes the page size; the scrollbar
      // and PgUp/PgDn are the way back, exactly as in Hermes.
      //
      // The JUMP-TO-LATEST marker rides on the same row, right-aligned: when
      // the operator has scrolled into the past, the way back has to be
      // visible. It names the key that does it (Enter on an empty draft), so
      // it is a promise the app keeps.
      let stickyRow = stickyPrompt
        ? clipVisible(`${tone('cyan', '❯ ')}${tone('dim', stickyPrompt)}`, contentWidth)
        : ''
      if (state.scroll > 0) {
        const jump = tone('cyan', '▼ latest') + tone('dim', ' · enter')
        const gap = contentWidth - visibleWidth(stickyRow) - visibleWidth(jump)
        stickyRow = gap >= 2 ? `${stickyRow}${' '.repeat(gap)}${jump}` : jump
      }
      lines.push(stickyRow)
      // Queue panel above the meter (Hermes grammar): a request typed while a
      // run is live is visibly waiting, with its position and the ways to
      // inspect it, instead of vanishing into a toast.
      if (crewRows.length) for (const row of crewRows) lines.push(row)
      if (queued.length) {
        // The hint must be TRUE. It used to advertise `/queue list` and
        // `Ctrl+R collapse` — neither exists: there is no `/queue` command
        // and Ctrl+R is unbound. A panel that names two keys it does not
        // have teaches the operator to distrust every other hint in the app
        // (B188).
        lines.push(clipVisible(`${tone('cyan', 'Queue')}${tone('dim', ` · ${queued.length} waiting · they run when this turn ends`)}`, contentWidth))
        queued.forEach((request, i) => {
          lines.push(tone('dim', clipVisible(`  ${i + 1}. ${request}`, contentWidth)))
        })
      }
      // The meter sits directly above the prompt (Hermes: `⚡ … │ ☤ model │ …`).
      lines.push(this.meterRow(state, contentWidth))
      // The completion panel sits between the meter and the prompt: the
      // candidates the operator is choosing from, right above the caret.
      if (completionRows.length) for (const row of completionRows) lines.push(row)
      // The search panel takes the completion panel's place: while the search
      // is open, the composer is not the focus, and two panels over one
      // screen is one panel too many.
      if (searchRow) lines.push(searchRow)
      // Same prompt block the home page uses — one builder, two layouts.
      this.composerTop = lines.length
      this.composerLeft = 0
      for (const row of boxRows) lines.push(row)
    }

    // Frame discipline: every row padded to the full visible width and the
    // tail cleared with ESC[0J. Without this, shorter frames leave stale
    // rows behind (old messages re-appearing under the composer).
    // The frame is EXACTLY h rows: short writes (e.g. the dialog path with no
    // side panel) must pad, or the terminal keeps the previous frame's tail.
    // Every row is clipped to the terminal width as the LAST step, whatever any
    // helper upstream believed. `padVisible` only pads and never truncates, so
    // without this a single over-wide row - a degenerate terminal size, a box
    // with a floor on its inner width, a glyph that does not fit - hands the
    // terminal more cells than it has and the whole frame wraps and scrolls.
    // Clipping here makes overflowing the terminal structurally impossible
    // rather than a property every caller has to remember.
    const frameRows = lines.slice(0, h).map(line => padVisible(clipVisible(line, w), w))
    while (frameRows.length < h) frameRows.push(' '.repeat(w))
    this.lastFrame = frameRows
    return frameRows.join('\n')
  }

  /** Rows of the last frame (overlays reuse them; tests assert on them). */
  lastFrame: string[] = []

  /**
   * Rows of scrollback that exist ABOVE the newest line, measured during the last
   * `frame()`. Paging clamps against this: without a real ceiling the stored
   * offset grows while the drawn slice stops moving, and PgUp reads as dead.
   */
  lastMaxScroll = 0

  /**
   * 0-based row of the composer's top rail in the last frame. Overlays float
   * above it, so the plate lands correctly on both layouts (composer at the
   * bottom on the stream view, centred on home).
   */
  composerTop = 0

  /**
   * The full frame as the terminal currently shows it.
   *
   * Repaints are incremental (only changed rows are written), so the raw byte
   * stream is no longer a complete frame — it is a patch. Tests, previews and
   * anyone debugging a layout need the whole thing, and this is it: the same
   * rows the renderer produced, in order, at the terminal's width.
   */
  painted(): string[] {
    return [...this.paintedFrame]
  }

  /** Rows currently on screen, so the next paint can diff against them. */
  private paintedFrame: string[] = []
  /** Set when the screen content outside our control changed (a resize, a clear). */
  private forceFullRepaint = true

  /**
   * The longest the app will trust its own memory of the screen.
   *
   * The dirty-row diff is sound only while the terminal still shows the rows
   * the app last wrote; the terminal can move under the app (a console that
   * scrolled, a reflow, an event the console dropped) and then the diff keeps
   * rewriting the rows it believes changed into a page that shifted. Nothing
   * on the app side can see that from here — but a quiet moment can undo it.
   * After this long without a paint, the next render rewrites every row no
   * matter what the diff thinks. The cost is one full frame after a pause,
   * which is exactly when a human is reading and a wrong row is most visible.
   */
  private lastPaintAt = Date.now()

  /**
   * Write the frame, touching only the rows that differ from what is already
   * on screen.
   *
   * `ESC[H` + the whole body + `ESC[0J` on every call is correct and expensive:
   * at 8 repaints a second (the spinner) that is ~34 KB/s of escape sequences
   * for a screen whose only moving part is one scanner row. Addressing the
   * changed rows in place costs a few hundred bytes per tick instead.
   *
   * `ESC[0J` is only emitted on a full repaint, because clearing to the end of
   * screen would erase the rows a diff deliberately left alone.
   *
   * Returns the bytes to write, so the caller can put the cursor where it
   * belongs in the SAME write. The paint hides the cursor: the frame is
   * written from the home position, so a visible cursor would sit in the
   * top-left corner for the length of the write (operator, 2026-11-04: a
   * blinking artifact in the top-left of the home page).
   */
  private paintFrame(body: string, previous: string[], w: number, h: number, full: boolean): string {
    const rows = body.split('\n')
    // Nothing changed: write nothing at all. This is the common case for the
    // spinner (a tick where the scanner happened to repeat) and for any render
    // triggered by state that does not affect pixels.
    if (!full && previous.length === h && rows.length === h && rows.every((row, i) => row === previous[i])) return ''
    const changed: number[] = []
    for (let i = 0; i < h; i++) {
      if (full || rows[i] !== previous[i]) changed.push(i)
    }
    if (changed.length === h) {
      const paint = this.fullRepaint(rows, w, h)
      this.paintedFrame = rows
      return paint
    }
    // Home first (3 bytes, and every overlay and test relies on the frame
    // starting with it), then only the rows that differ, each addressed in
    // place. `ESC[0J` is deliberately NOT emitted here: it would erase the
    // rows the diff left alone. Autowrap is off for the same reason as in
    // `fullRepaint`: a changed row can be exactly `w` wide (the composer
    // rails), and ConPTY otherwise lets the next row's address fall through.
    //
    // The cursor is HIDDEN for the whole paint. It is homed first and left
    // there, so a visible cursor would flash in the corner of the screen while
    // the frame is written — and because every repaint re-parks it, the
    // terminal's own blink timer restarts nine times a second, which is the
    // "blinking artifact in the top-left" the operator reported. The caller
    // positions and shows it in the same write.
    let paint = `\x1b[?25l\x1b[?7l\x1b[H${SYNC_OUTPUT_START}`
    for (const i of changed) paint += `\x1b[${i + 1};1H${clipVisible(rows[i] ?? '', w)}`
    paint += `${SYNC_OUTPUT_END}\x1b[H\x1b[?7h`
    this.paintedFrame = rows
    return paint
  }

  /**
   * The extent of the frame currently on the terminal.
   *
   * Needed because `ESC[0J` cannot do the job it looks like it does: it erases
   * from the CURSOR to the end of the screen, and after a frame write the
   * cursor is on the LAST row. So when the window was previously WIDER - a
   * dragged window, a maximised one, a split restored - every row kept the old
   * frame's content to the right of the new one, and the operator saw a ghost
   * of the previous layout: two Context panels side by side, stale text hanging
   * off the right edge. Reported from a screenshot, and reproduced at 190 -> 132
   * columns: 88 stale cells across 29 rows.
   *
   * The residue is cleared by WRITING the blank cells it needs rather than by
   * an erase sequence. `ESC[K` looks like the answer and is not: writing the
   * last column leaves the cursor there with a pending wrap, and `ESC[K` then
   * erases that very cell. Explicit blanks have no such edge - and no
   * dependence on pending-wrap or ONLCR behaviour, which is the class of
   * assumption that has already produced two wrong "fixes" in this file.
   */
  private paintedWidth = 0
  private paintedHeight = 0

  /**
   * Terminal-ready text for a full repaint of `rows`, clearing the residue a
   * narrower window left behind. Returns the text; records the new extent.
   */
  fullRepaint(rows: string[], w: number, h: number): string {
    const padCols = Math.max(0, this.paintedWidth - w)
    const padRows = Math.max(0, this.paintedHeight - h)
    const pad = padCols > 0 ? ' '.repeat(padCols) : ''
    // AUTOWRAP OFF FOR THE PAINT. Every row here is padded to exactly `w`, so
    // the cursor sits in the terminal's pending-wrap state at the end of each
    // one. ConPTY re-renders what it receives, and with wrap pending it drops
    // the cursor address before the next row and lets the text run on: the
    // meter row swallowed the composer's first `─`, that row swallowed `❯`, and
    // the frame arrived as a one-column staircase at the bottom of the page
    // (reproduced through a real ConPTY at 120x36 and 80x24; feeding the same
    // bytes straight to xterm was always perfect). Turning wrap off makes a
    // full row end AT the last cell instead of past it, so every explicit
    // `ESC[row;1H` survives and nothing depends on wrap behaviour. Wrap is
    // restored from the home position, because enabling it while the cursor is
    // still on the last cell can wrap immediately.
    //
    // The cursor is HIDDEN for the paint: the frame is written from the home
    // position, so a visible cursor would sit in the top-left corner while the
    // frame lands. The caller positions and shows it in the same write.
    //
    // The whole paint is wrapped in SYNCHRONIZED OUTPUT, so the terminal
    // presents the frame in one go instead of row by row. A half-drawn page
    // is the kind of detail an operator notices without being able to name
    // it — and once they have seen it, every later frame looks broken.
    //
    // The mode opens AFTER the cursor is hidden and the frame is homed: those
    // two are not drawing, and the hide-then-home order is the contract the
    // overlay and the tests rely on.
    let out = `\x1b[?25l\x1b[?7l\x1b[H${SYNC_OUTPUT_START}`
    for (let i = 0; i < h; i++) {
      // A row the frame did not produce is written BLANK. Addressing a row and
      // writing nothing leaves whatever was there - which is the stale-row bug
      // in a different costume, and the reason this writes every row rather
      // than joining `rows` and hoping the count matched.
      out += `\x1b[${i + 1};1H${rows[i] === undefined ? ' '.repeat(w) : clipVisible(rows[i], w)}${pad}`
    }
    for (let i = 0; i < padRows; i++) {
      out += `\x1b[${h + 1 + i};1H${' '.repeat(w)}`
    }
    out += `${SYNC_OUTPUT_END}\x1b[H\x1b[?7h`
    this.paintedWidth = w
    this.paintedHeight = h
    return out
  }

  /**
   * Re-read the terminal size and resize if it moved. Reports whether it did.
   *
   * `stdout.on('resize')` is the right mechanism and it IS wired - but a console
   * that misses the event leaves the app painting a frame narrower than its
   * window, with the Context panel stranded in the middle of the screen and dead
   * space to the right of it. Reported from a screenshot, twice, with the window
   * plainly wider than the frame.
   *
   * So the size is re-checked at moments when a human is already waiting: a
   * keypress. Two property reads, and a resize only when they disagree - after
   * which the app heals itself on the next interaction instead of staying wrong
   * until it is restarted.
   *
   * This is the reachable half of the fix. `fullRepaint`'s tail-clear is the
   * mechanism that was MISSING for tidying up afterwards; without a way to
   * repaint a row's right-hand region there was no way to remove a ghost even
   * once the width was right. The two belong together.
   */
  syncSize(stream: { columns?: number; rows?: number }): boolean {
    const w = stream.columns
    const h = stream.rows
    if (typeof w !== 'number' || typeof h !== 'number') return false
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false
    if (w === this.width && h === this.height) return false
    this.resize(w, h)
    return true
  }

  /**
   * Force the next `render()` to repaint everything. Needed after anything that
   * changes the screen behind the app's back — leaving and re-entering the
   * alternate screen, a terminal resize, or an overlay that painted over the
   * frame and then detached.
   */
  invalidate(): void {
    this.forceFullRepaint = true
  }

  /**
   * How many floating overlays currently own the screen surface.
   *
   * A plate is painted OVER the frame, so anything that repaints the frame
   * while one is open paints straight through it. That is not hypothetical: the
   * 120ms spinner repaints on every tick of a live run, so opening the command
   * plate mid-run punched a moving hole in the menu eight times a second and
   * burned the bytes doing it.
   *
   * This is a QUESTION, not a lock. `render()` deliberately keeps working while
   * an overlay is up, and the spinner asks this before painting. The earlier
   * version made `render()` return early instead, which is tidier but has a
   * catastrophic failure mode: an overlay that failed to detach - a missed
   * input event, a throw between begin and end - would silence every
   * subsequent render and freeze the session with no way back. That is exactly
   * the "nothing works, only ctrl+c" report this all started from. A counter
   * that can only pause an animation is the right place for the risk.
   */
  private overlayDepth = 0

  /** True while a floating overlay is painting over the frame. */
  overlayOpen(): boolean {
    return this.overlayDepth > 0
  }

  /** An overlay is painting over the frame: callers should not repaint it. */
  beginOverlay(): void {
    this.overlayDepth += 1
  }

  /** The overlay is gone: the frame must come back in full, not by diff. */
  endOverlay(): void {
    this.overlayDepth = Math.max(0, this.overlayDepth - 1)
    if (this.overlayDepth === 0) this.invalidate()
  }

  render(state: ScreenState): void {
    // The completion follows the draft. It is refreshed HERE (not in the key
    // handler) so every path that changes the text — typing, paste, history
    // recall, a word-wise edit — gets a correct completion for free.
    this.refreshCompletion(state)
    this.driveCube(state)
    // A floating overlay (command plate) paints and owns the surface itself;
    // a base repaint here would write UNDER it and clobber the plate rows —
    // which is exactly what happens while a run is live and events keep
    // pushing while the operator browses the palette.
    if (this.overlayOpen()) return
    this.syncLiveSize()
    const w = fitWidth(this.width)
    const h = fitHeight(this.height)
    const body = this.highlightSelection(state, this.frame(state))
    // Dirty-row repaint. The spinner repaints the whole frame 8 times a second
    // while a run is live, and in almost every tick only ONE row has changed
    // (the scanner). Re-emitting the entire screen each time is what made the
    // console fall behind its own writes and the session feel frozen, so a
    // repaint that changes nothing writes nothing, and a repaint that changes
    // one row writes one row.
    //
    // `force` bypasses the check for the paths that must always emit (entering,
    // clearing, a resize that changed the width).
    // Idle heal: after a quiet moment the glass may have moved without us; pay
    // for one full frame and stop trusting the diff (see `lastPaintAt`).
    const idle = Date.now() - this.lastPaintAt > IDLE_HEAL_MS
    const paint = this.paintFrame(body, this.paintedFrame, w, h, this.forceFullRepaint || idle)
    this.forceFullRepaint = false
    this.lastPaintAt = Date.now()
    if (!state.dialog) {
      // The composer sits wherever the layout put it (bottom on the stream
      // view, centred on home), so find its top rail instead of assuming.
      // Rows/cols come from composerRows' wrapped visual mapping: logical
      // lines wrap, so a logical offset is NOT a column.
      const cursorRow = this.composerCursorVisual
      const cursorCol = this.composerCursorCol
      // `composerTop` is 0-based (the index of the `╭` rail) but cursor
      // addressing is 1-based, so the body row is `composerTop + 2`. Using
      // `+ 1` addressed the TOP RAIL, parking the blinking caret on the model
      // label instead of in the input line — invisible on a busy screen and
      // plainly wrong on a small one.
      const row = Math.min(h, Math.max(1, this.composerTop + 2 + cursorRow))
      // The caret sits after the prompt's `❯ ` (two columns, 0-based), so the
      // 1-based terminal column is composerLeft + 3 + cursorCol.
      const inside = this.composerLeft + 3
      const col = Math.min(w, inside + Math.min(cursorCol, Math.max(1, w - inside - 1)))
      // ONE write: the frame, the cursor's place and the cursor's visibility.
      // Split across two writes, the terminal renders the frame with the
      // cursor still parked where the paint left it — the top-left corner —
      // and the operator saw a blinking artifact there (operator, 2026-11-04).
      this.out.write(`${paint}\x1b[${row};${col}H\x1b[?25h`)
    } else {
      this.out.write(`${paint}\x1b[?25l`)
    }
  }

  /**
   * Secret input: keys never reach the frame.
   *
   * `readLine` echoes into the composer, which is right for a request and wrong
   * for an API key. This keeps the draft in a local string, shows a bullet per
   * character in the status line, and hands the value only to the caller. No
   * history, no stream, no screen scrollback — nothing to leak by scrolling.
   */
  readSecret(state: ScreenState, prompt: string): Promise<string | undefined> {
    this.lastState = state
    return new Promise(resolve => {
      let value = ''
      const paint = (): void => {
        const mask = value ? ` ${'•'.repeat(Math.min(value.length, 40))}` : ''
        state.status = `${prompt}${mask} · enter saves · esc cancels`
        this.render(state)
      }
      const done = (answer: string | undefined): void => {
        stop()
        state.status = ''
        this.render(state)
        resolve(answer)
      }
      paint()
      const stop = attachInput({
        key: key => {
          if (key.ctrl && key.name === 'c') { done(undefined); return }
          if (key.name === 'escape') { done(undefined); return }
          if (key.name === 'return') { done(value); return }
          if (key.name === 'backspace') {
            if (value) { value = value.slice(0, -1); paint() }
            return
          }
          if (key.ctrl || key.meta) return
          const printable = [...(key.sequence ?? '')].filter(ch => {
            const code = ch.charCodeAt(0)
            return code >= 32 && code !== 127
          }).join('')
          if (!printable) return
          value += printable
          paint()
        },
        mouse: event => this.wheelEvent(state, event),
        // Pasting an API key is the normal way to enter one; bracketed paste
        // must still land in the secret buffer (never in the frame/trace).
        // Secrets are one line: the same sanitiser, minus newlines.
        paste: text => {
          const clean = pasteText(text).replace(/\n/g, '')
          if (!clean) return
          value += clean
          paint()
        },
        out: this.out,
      })
    })
  }

  /**
   * Line input with history, echoing inside our own input box.
   *
   * `ctrlC` decides what Ctrl+C means here. On the MAIN composer it is the
   * universal "leave this app" key, so one press only clears the draft and
   * asks for a second; two presses inside two seconds exit. Inside a
   * configuration prompt or an argument prompt it cancels THAT prompt and
   * returns to the composer — never the session. Ctrl+D exits on an empty
   * draft and deletes forward when there is text, like a shell.
   */
  readLine(
    state: ScreenState,
    history: string[],
    options: { ctrlC?: 'exit' | 'cancel'; paste?: 'collapse' | 'raw' } = {},
  ): Promise<string | undefined> {
    return new Promise(resolve => {
      const saved = state.input
      const baseStatus = state.status
      // The paste map belongs to THIS draft: a new draft starts with no
      // payload behind it. (A request QUEUED during a live run keeps its own
      // map until the queue is drained — see `watchRun`.)
      this.pendingPastes = new Map()
      let ctrlCAt = 0
      let hintShown = false
      // History cursor: `history.length` is "past the newest entry", i.e. the
      // empty draft. Up walks back through what was submitted, down walks
      // forward again. This MUST be declared per call — without it the arrow
      // keys threw `ReferenceError: hist is not defined` and took the whole
      // session down on the first Up press.
      let hist = history.length
      /**
       * The draft the operator had before the history browsing started.
       *
       * pi's rule (MIT): type something, press Up, press Down — and your
       * unsent text is back. Without it a stray arrow key threw away a
       * half-typed request, which is the kind of small betrayal an operator
       * remembers.
       */
      let historyDraft = ''
      let finished = false
      const done = (value: string | undefined): void => {
        if (finished) return
        finished = true
        // A search never outlives the composer that opened it.
        state.search = null
        this.searchScrollKey = ''
        detach()
        resolve(value)
      }
      // One insert path for typing, paste and edits: the cursor lands after the
      // inserted text and history recall leaves the stale slot, so the next Up
      // starts from the newest entry instead of jumping from a recalled one.
      const insert = (text: string): void => {
        if (!text) return
        state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor)
        state.cursor += text.length
        hist = history.length
      }
      // ── Undo and the kill ring ──────────────────────────────────────────
      // Emacs-style editing, ported from pi (MIT, Copyright (c) 2025 Mario
      // Zechner). The composer could delete text but could not get it back:
      // a mistyped Ctrl+W was a one-way door.
      //
      // TWO mechanisms, and the split is the point:
      //
      //  - The UNDO STACK remembers EVERY edit (typing, backspace, a paste,
      //    an accepted completion, a yank). It is the safety net.
      //  - The KILL RING remembers only the kill chords (Ctrl+U/K/W), which
      //    is the fast gesture: kill a span, move, yank it back. If every
      //    delete fed the ring, Ctrl+Y would paste something the operator
      //    deleted by accident.
      interface ComposerSnapshot {
        input: string
        cursor: number
        ring: readonly string[]
      }
      const killRing = new KillRing()
      const undoStack = new UndoStack<ComposerSnapshot>()
      /**
       * What the last edit was, and what it means:
       *
       *  - `type`  — characters were typed. Consecutive WORD characters
       *    coalesce into one undo unit, and a SPACE starts a new unit that
       *    captures the state before the space, so one undo removes the space
       *    and the word that followed it (pi's fish-style rule).
       *  - `kill`  — a kill chord ran. Consecutive kills ACCUMULATE into one
       *    ring entry, so three Ctrl+W yank back three words.
       *  - `yank`  — text was yanked. A second yank yank-POPS (the ring
       *    rotates).
       *  - `other` — anything else: a cursor move, a paste, a delete, an
       *    accepted completion. It breaks both chains.
       */
      let lastAction: 'type' | 'kill' | 'yank' | 'other' | null = null
      /** The text the last yank inserted (yank-pop takes it back out). */
      let yankedText = ''
      const pushSnapshot = (input: string, cursor: number): void => {
        undoStack.push({ input, cursor, ring: killRing.entries() })
        undoStack.trim(UndoStack.LIMIT)
      }
      const snapshot = (): void => { pushSnapshot(state.input, state.cursor) }
      /** Type text: word characters coalesce into one undo unit. */
      const typeText = (text: string): void => {
        if (!text) return
        if (lastAction !== 'type' || /\s/.test(text)) snapshot()
        insert(text)
        lastAction = 'type'
      }
      /** An atomic insertion (a paste, or a run of characters delivered together). */
      const insertAtomic = (text: string): void => {
        if (!text) return
        snapshot()
        insert(text)
        lastAction = 'other'
      }
      /**
       * Delete a span and put it in the kill ring.
       *
       * A backward kill PREPENDS and a forward kill APPENDS, so the yank
       * comes back in the order the text was read. Consecutive kills
       * accumulate into one entry.
       */
      const kill = (from: number, to: number, prepend: boolean): void => {
        if (to <= from) return
        const text = state.input.slice(from, to)
        snapshot()
        state.input = state.input.slice(0, from) + state.input.slice(to)
        state.cursor = from
        hist = history.length
        killRing.push(text, { prepend, accumulate: lastAction === 'kill' })
        lastAction = 'kill'
        yankedText = ''
      }
      /** Put the newest killed text back at the caret. */
      const yank = (): void => {
        const text = killRing.peek()
        if (!text) {
          state.status = 'nothing to yank'
          hintShown = true
          return
        }
        snapshot()
        state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor)
        state.cursor += text.length
        hist = history.length
        yankedText = text
        lastAction = 'yank'
      }
      /** Replace the last yank with the next entry in the ring. */
      const yankPop = (): void => {
        if (lastAction !== 'yank' || !yankedText || killRing.length < 2) return
        snapshot()
        const from = Math.max(0, state.cursor - yankedText.length)
        state.input = state.input.slice(0, from) + state.input.slice(state.cursor)
        state.cursor = from
        killRing.rotate()
        const next = killRing.peek() ?? ''
        state.input = state.input.slice(0, state.cursor) + next + state.input.slice(state.cursor)
        state.cursor += next.length
        yankedText = next
        hist = history.length
        lastAction = 'yank'
      }
      /** Undo the last edit. */
      const undo = (): void => {
        const snap = undoStack.pop()
        if (!snap) {
          state.status = 'nothing to undo'
          hintShown = true
          return
        }
        state.input = snap.input
        state.cursor = Math.min(snap.cursor, state.input.length)
        // The ring travels with the snapshot: undoing a kill takes the killed
        // text out of the ring too, so Ctrl+Y cannot paste it a second time.
        killRing.restore(snap.ring)
        hist = history.length
        lastAction = 'other'
        yankedText = ''
      }
      /** The span a word-kill takes: the word before the caret. */
      const wordBefore = (): { from: number; to: number } => {
        const to = state.cursor
        const from = prevWordStart(state.input, to)
        return { from, to }
      }
      /** The span a forward word-kill takes: the word after the caret. */
      const wordAfter = (): { from: number; to: number } => {
        const from = state.cursor
        const to = nextWordEnd(state.input, from)
        return { from, to }
      }
      const onPaste = (raw: string): void => {
        if (finished) return
        // pasteText drops terminal escapes/controls and expands tabs; newlines
        // stay. NEVER submit: pasting a block must not run anything, and a
        // pasted "y" must not approve.
        const text = pasteText(raw)
        if (!text) return
        ctrlCAt = 0
        if (hintShown) { hintShown = false; state.status = baseStatus }
        // A LARGE paste collapses to a label: the composer stays usable, and
        // the operator sees WHAT they are sending (a size) instead of a wall
        // of text they cannot read anyway. The payload waits in the pending
        // map and is framed for the model at submit time.
        //
        // A CONFIGURATION or command-argument prompt keeps the paste raw: a
        // model id, a URL or a path is text the app USES, and a label in its
        // place would be a broken value, not a tidier one.
        const inserted = (options.paste ?? 'collapse') === 'collapse'
          ? this.collapsePaste(text)
          : text
        // A paste is ATOMIC: one undo takes the whole block back, not one
        // character of it.
        insertAtomic(inserted)
        this.render(state)
      }
      const onKey = (key: TerminalKey): void => {
        // A CRLF paste resolves on `return` mid-chunk, but the emit loop still
        // holds the trailing Ctrl+J + text. Without this guard those bytes land
        // in the cleared draft and corrupt the next prompt.
        if (finished) return
        // Any key that is not the confirmation press starts the two-press
        // window over: press Ctrl+C, then type, then press it again is a
        // fresh first press, not an exit.
        if (!(key.ctrl && key.name === 'c')) ctrlCAt = 0
        if (hintShown && !(key.ctrl && key.name === 'c')) {
          hintShown = false
          state.status = baseStatus
        }
        // ── Transcript search (Ctrl+F) ─────────────────────────────────────
        // The search borrows the KEY HANDLER but never the draft: a search
        // must not eat the request the operator was writing. Esc closes it
        // and gives the draft back exactly as it was.
        if (state.search) {
          const search = state.search
          const close = (): void => {
            state.search = null
            this.searchScrollKey = ''
            this.render(state)
          }
          /** Move to the next/previous hit, wrapping at both ends. */
          const step = (delta: number): void => {
            if (search.total <= 0) return
            search.active = (search.active + delta + search.total) % search.total
            this.render(state)
          }
          if (key.ctrl && key.name === 'c') { close(); return }
          if (key.name === 'escape') { close(); return }
          if (key.name === 'return') { step(key.shift ? -1 : 1); return }
          if (key.name === 'backspace') {
            if (search.query.length > 0) {
              search.query = search.query.slice(0, -1)
              search.active = 0
            }
            this.render(state)
            return
          }
          if (key.ctrl && (key.name === 'n' || key.name === 'j')) { step(1); return }
          if (key.ctrl && key.name === 'p') { step(-1); return }
          if (key.ctrl || key.meta) return
          const printable = [...(key.sequence ?? '')].filter(ch => {
            const code = ch.codePointAt(0) ?? 0
            return code >= 32 && code !== 127
          }).join('')
          if (!printable) return
          search.query += printable
          search.active = 0
          this.render(state)
          return
        }
        if (key.ctrl && key.name === 'c') {
          // With a mouse selection, Ctrl+C COPIES instead of exiting: the
          // selection is the operator's explicit "this text" gesture, and
          // losing the session over it would be the worst trade on the
          // screen. The selection clears, so a second Ctrl+C exits normally.
          if (this.copySelectionReceipt(state)) return
          // Inside a prompt, Ctrl+C cancels the prompt.
          if ((options.ctrlC ?? 'exit') === 'cancel') {
            state.input = saved
            state.cursor = saved.length
            this.render(state)
            done(undefined)
            return
          }
          const now = Date.now()
          if (ctrlCAt > 0 && now - ctrlCAt <= 2000) {
            state.input = ''
            state.cursor = 0
            done(undefined)
            return
          }
          // First press: clear the draft, keep the session, and SAY so. The
          // old handler exited on a single Ctrl+C with no receipt — one stray
          // key ended a session mid-thought.
          ctrlCAt = now
          snapshot()
          state.input = ''
          state.cursor = 0
          state.status = 'ctrl+c again to exit · esc clears'
          hintShown = true
          this.render(state)
          return
        }
        if (key.ctrl && key.name === 'd') {
          if (!state.input) { done(undefined); return }
          if (state.cursor < state.input.length) {
            snapshot()
            state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1)
            hist = history.length
            lastAction = 'other'
          }
          this.render(state)
          return
        }
        switch (key.name) {
          // Esc clears a draft (opencode composer grammar); while a run is
          // live it asks for an interrupt instead, which the run layer polls.
          case 'escape':
            if (state.busy) { this.requestAbort = true; break }
            state.selection = null
            // The completion panel goes FIRST: a panel the operator cannot
            // see through is the one thing that must never be in the way of
            // "get this text out of my draft".
            if (state.completion && state.completion.panel) {
              this.completionDismissedFor = state.input
              state.completion = null
              break
            }
            if (state.input) { snapshot(); state.input = ''; state.cursor = 0; lastAction = 'other' }
            break
          case 'return': {
            const value = state.input
            // Enter on an EMPTY draft while reading history returns to the live
            // tail instead of submitting nothing. Hermes' sticky prompt names
            // the last request above the composer, and the scrollbar shows how
            // far back you are; this is the keyboard fast way back to "now".
            if (!value.trim() && state.scroll > 0) {
              state.scroll = 0
              break
            }
            // A completion panel that is NOT exact means the typed text is
            // only the START of a command: Enter ACCEPTS the highlighted
            // candidate instead of submitting a command that does not exist.
            // An exact command (`/status`) RUNS on Enter — the operator must
            // not have to press a key twice to run what they typed.
            if (state.completion && state.completion.panel && !state.completion.exact) {
              const before = state.input
              const beforeCursor = state.cursor
              if (this.acceptCompletion(state)) {
                // The snapshot holds the state BEFORE the accept, so one undo
                // takes the completion back out.
                pushSnapshot(before, beforeCursor)
                lastAction = 'other'
                break
              }
            }
            state.input = ''
            state.cursor = 0
            this.render(state)
            done(value)
            return
          }
          // Tab accepts the highlighted candidate (or the ghost text). It was
          // unbound before: the key did nothing at all in the composer.
          case 'tab': {
            const before = state.input
            const beforeCursor = state.cursor
            if (this.acceptCompletion(state)) {
              pushSnapshot(before, beforeCursor)
              lastAction = 'other'
            }
            break
          }
          case 'backspace':
            if (key.ctrl || key.meta) {
              // Ctrl/Alt+Backspace kills the WHOLE previous word, not one
              // character (shell/EditBuffer grammar). It was a no-op before.
              // It is a KILL: the word goes into the ring, so Ctrl+Y brings it
              // back.
              const span = wordBefore()
              kill(span.from, span.to, true)
              break
            }
            if (state.cursor > 0) {
              snapshot()
              state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor)
              state.cursor -= 1
              // Editing after a history recall leaves the recall position:
              // the next Up would jump from the old slot and lose the edit.
              hist = history.length
              lastAction = 'other'
            }
            break
          case 'left':
            state.cursor = key.ctrl || key.meta
              ? prevWordStart(state.input, state.cursor)
              : Math.max(0, state.cursor - 1)
            lastAction = 'other'
            break
          case 'right':
            state.cursor = key.ctrl || key.meta
              ? nextWordEnd(state.input, state.cursor)
              : Math.min(state.input.length, state.cursor + 1)
            lastAction = 'other'
            break
          case 'home': state.cursor = 0; lastAction = 'other'; break
          case 'end': state.cursor = state.input.length; lastAction = 'other'; break
          // Forward-delete at the cursor; Insert is explicitly ignored (no
          // overwrite mode) instead of typing "[2~" into the draft.
          // Ctrl/Alt+Delete kills the next word — and a kill is recoverable.
          case 'delete': {
            if (key.ctrl || key.meta) {
              const span = wordAfter()
              kill(span.from, span.to, false)
              break
            }
            const to = Math.min(state.input.length, state.cursor + 1)
            if (to > state.cursor) {
              snapshot()
              state.input = state.input.slice(0, state.cursor) + state.input.slice(to)
              hist = history.length
              lastAction = 'other'
            }
            break
          }
          case 'insert':
            break
          // Shell-standard edit keys, the same set OpenTUI's EditBuffer
          // exposes. All five were unbound in the composer before: Ctrl+A/E/U/
          // K/W did nothing at all. A plain letter still types, so the case
          // catches both and non-ctrl falls through to insertion.
          //
          // Ctrl+U, Ctrl+K and Ctrl+W are now KILLS: the text they remove goes
          // into the kill ring, so Ctrl+Y brings it back. That is the Emacs
          // contract these chords always had.
          case 'a':
            if (key.ctrl) { state.cursor = 0; lastAction = 'other'; break }
            typeText(key.sequence)
            break
          case 'e':
            if (key.ctrl) { state.cursor = state.input.length; lastAction = 'other'; break }
            typeText(key.sequence)
            break
          case 'u':
            if (key.ctrl) {
              kill(0, state.cursor, true)
              break
            }
            typeText(key.sequence)
            break
          case 'k':
            if (key.ctrl) {
              kill(state.cursor, state.input.length, false)
              break
            }
            typeText(key.sequence)
            break
          case 'w':
            if (key.ctrl) {
              const span = wordBefore()
              kill(span.from, span.to, true)
              break
            }
            typeText(key.sequence)
            break
          // Ctrl+Y yanks the last killed text back; Alt+Y yank-pops to the
          // previous kill. Both are the Emacs gestures, and both were dead
          // keys before: the composer could delete a phrase but never bring
          // it back.
          case 'y':
            if (key.ctrl) { yank(); break }
            if (key.meta) { yankPop(); break }
            typeText(key.sequence)
            break
          // Ctrl+Z undoes the last edit — typing, deleting, a paste, an
          // accepted completion. In raw mode the terminal never turns it into
          // a suspend signal, so the chord is ours to use.
          case 'z':
            if (key.ctrl) { undo(); break }
            typeText(key.sequence)
            break
          // Alt+D kills the word AFTER the caret (the forward kill). It is
          // the one chord that needs a modifier the legacy terminal table
          // cannot express, so it arrives through the kitty/modifyOtherKeys
          // protocols Wednesday already arms.
          case 'd':
            if (key.meta) {
              const span = wordAfter()
              kill(span.from, span.to, false)
              break
            }
            typeText(key.sequence)
            break
          // Paging clamps to the real overflow and OVERLAPS by one row.
          //
          // The old code did `scroll += lastRoom` with no ceiling: `frame()`
          // clamped the drawn slice, so the stored offset kept growing while the
          // picture stopped moving — PgUp looked dead, PgDn took many presses to
          // come back, and the "▲ +N" readout counted rows nobody could see.
          // A page that overlaps by one line is also what a pager does: without
          // it a line scrolls past unseen between two pages.
          //
          // The step is REMEMBERED: showing the pager row shrinks the page by
          // one, so recomputing on PgDn left `scroll` one row short of zero and
          // the newest line never came back.
          case 'pageup':
            this.pageStep = Math.max(1, this.lastRoom - 1)
            state.scroll = Math.min(this.lastMaxScroll, state.scroll + this.pageStep)
            break
          case 'pagedown':
            state.scroll = Math.max(0, state.scroll - (this.pageStep ?? Math.max(1, this.lastRoom - 1)))
            break
          // Ctrl+P opens the command palette (opencode keymap convention).
          // Fulfils the promise the footer hint makes.
          // Ctrl+P opens the command palette. Matched on the raw control
          // character (0x10) as well as key.ctrl, because some Windows
          // console hosts deliver the byte without the modifier flag.
          // A plain `p` must still type: the case catches both, so non-ctrl
          // falls through to insertion instead of being dropped.
          case 'p':
            if (key.ctrl) { this.pendingPalette = true; done(undefined); return }
            typeText(key.sequence)
            break
          // Ctrl+F opens the TRANSCRIPT SEARCH. The draft is untouched: the
          // search is a MODE of the composer, not a replacement for it. An
          // operator who searches for a phrase and then types a request must
          // not lose the request to the search.
          case 'f':
            // The search is a TRANSCRIPT tool: it is offered on the main
            // composer, not inside a configuration or argument prompt, where
            // there is no transcript worth searching.
            if (key.ctrl && (options.ctrlC ?? 'exit') === 'exit') {
              state.search = { query: '', active: 0, total: 0 }
              this.searchScrollKey = ''
              // The completion panel goes: the search panel takes its place.
              this.completionDismissedFor = state.input
              state.completion = null
              this.render(state)
              break
            }
            typeText(key.sequence)
            break
          case 'up':
          // While a completion panel is open, Up/Down move the SELECTION, not
          // the caret and not the history. A panel where the arrow keys do
          // something else is a panel the operator cannot drive.
          if (state.completion && state.completion.panel) {
            state.completion = moveActive(state.completion, -1)
            break
          }
          if (!moveCursorRow(state, -1) && hist > 0) {
            // The draft the operator had BEFORE the browsing started. pi's
            // rule (MIT): typing something, pressing Up and then Down gives
            // your unsent text back — not an empty composer. Without it the
            // operator's half-typed request vanished on a stray arrow key.
            if (hist === history.length) historyDraft = state.input
            hist -= 1
            snapshot()
            this.recallDraft(state, history[hist] ?? '')
          }
          break
          case 'down':
          if (state.completion && state.completion.panel) {
            state.completion = moveActive(state.completion, 1)
            break
          }
          if (!moveCursorRow(state, 1)) {
            if (hist < history.length) {
              hist += 1
              if (hist === history.length) {
                // Back past the newest entry: the draft comes back.
                state.input = historyDraft
                state.cursor = historyDraft.length
              } else {
                snapshot()
                this.recallDraft(state, history[hist] ?? '')
              }
            }
          }
          break
          default:
            // Shift/Ctrl/Alt+Enter (CSI u) inserts a newline exactly like
            // Ctrl+J. Plain Enter submits; modified Enter never does.
            if (key.ctrl && key.name === 'j' || key.name === 'newline') {
              // Ctrl+J inserts a composer newline (opencode multiline grammar).
              snapshot()
              state.input = state.input.slice(0, state.cursor) + '\n' + state.input.slice(state.cursor)
              state.cursor += 1
              hist = history.length
              lastAction = 'other'
            } else if (!key.ctrl && !key.meta && typeof key.sequence === 'string' && key.sequence.length >= 1 && !key.sequence.startsWith('\x1b')) {
              // An UNBRACKETED terminal delivers a paste as one printable run
              // (bracketed paste arrives through onPaste instead). Filtering
              // runs through the single-char branch dropped the whole paste.
              const printable = [...key.sequence].filter(ch => {
                const code = ch.charCodeAt(0)
                return code >= 32 && code !== 127
              }).join('')
              if (printable) {
                const before = state.input.slice(0, state.cursor)
                // One character is typing (it coalesces with its neighbours
                // into one undo unit); a RUN is an unbracketed paste, and a
                // paste is atomic.
                if ([...printable].length === 1) typeText(printable)
                else insertAtomic(printable)
                // A lone "/" opens the command tab IMMEDIATELY (opencode
                // grammar, design board G1) instead of waiting for Enter —
                // the plate floats over the live screen and further typing
                // filters it in place. Only a single typed "/" does this, so
                // a pasted "/usr/local" is still just text. The returned value
                // carries the slash, so the caller opens the plate from the
                // command path; pendingPalette is deliberately NOT set here,
                // or a later Ctrl+C would open the plate instead of exiting.
                if (state.input === '/' && before === '' && printable === '/') {
                  // Clear the draft BEFORE handing the slash back. The caller
                  // opens the command plate from the returned value, and the
                  // stale "/" would still be sitting in the composer when that
                  // plate closed — so the next thing typed came out as
                  // "/still typing" instead of a clean draft.
                  state.input = ''
                  state.cursor = 0
                  this.render(state)
                  done('/')
                  return
                }
              }
            }
        }
        this.render(state)
      }
      // Self-heal a missed console resize before the keystroke is handled, so the
      // frame the operator sees is the size of the window they are looking at.
      // Cheap: two property reads, and a resize only when they disagree. The
      // `stdout.on('resize')` listener is still the primary mechanism - this is
      // what happens when it does not fire.
      if (this.syncSize(this.out)) this.render(state)
      // Wheel reporting is armed with Hermes' wheel preset (1000+1006): the
      // transcript scrolls with the wheel exactly as it does in Hermes, while
      // clicks are ignored. Hover is NOT armed here, so the stream pays only
      // for what it uses; the palette still arms hover for its own hit map.
      this.lastState = state
      const detach = attachInput({
        key: onKey,
        paste: onPaste,
        focus: focused => this.onFocus(state, focused),
        mouse: event => { this.wheelEvent(state, event); this.selectEvent(state, event) },
        out: this.out,
      })
      this.render(state)
    })
  }

  /**
   * The approval gate. Answers, in the order a hand reaches for them:
   * `y`/`Y` runs, `n`/`N`/Esc/Enter(armed cancel)/Ctrl+C rejects, Left/Right/Tab
   * move which action Enter takes, and a click on either button answers it.
   *
   * Default-N is deliberate and unchanged from the classic `[y/N]` prompt: an
   * approval that fires on a stray Enter is the worst failure this screen can
   * have. What changed is that the armed action is now VISIBLE, and that the
   * hit map comes from the same builder that paints the row instead of
   * searching the frame for wording that a copy edit can invalidate.
   */
  askApproval(state: ScreenState, dialog: ScreenDialog): Promise<boolean> {
    return this.gate(state, dialog)
  }

  /**
   * A yes/no gate over the same panel as the approval: `/clear` and `/new`
   * wipe the transcript, so they confirm first — exactly as Hermes does
   * (`Start a new session?` / `Clear the current session?` with
   * `Yes, …` and `No, keep going`). The cursor starts on No: a session wipe
   * on a stray Enter is the destructive twin of a stray approval.
   */
  confirm(state: ScreenState, dialog: ScreenDialog): Promise<boolean> {
    return this.gate(state, dialog)
  }

  private gate(state: ScreenState, dialog: ScreenDialog): Promise<boolean> {
    state.dialog = { focus: 'cancel', ...dialog }
    // The gate paints IN FULL, always: opening, every focus move, closing.
    // The diff trusts `paintedFrame` — the rows the app last wrote — and that
    // trust is what the terminal breaks when it moves under the app (a console
    // that scrolled, a reflow, a missed event). The operator's screenshot is
    // the proof: after the page shifted, a Tab repaint rewrote only the rows
    // that changed, and the previous frame's armed-cancel row survived as a
    // ghost above the live armed-run row — "double yes yes". A dialog is the
    // one surface where a stale row can approve the wrong thing, so it never
    // takes the diff's word for the screen. Nine rows, rewritten, every move.
    this.invalidate()
    this.render(state)
    return new Promise(resolve => {
      const choices = state.dialog?.choices ?? APPROVAL_CHOICES
      const runLabel = choices.find(choice => choice.value === 'run')?.label ?? 'Run once'
      const done = (value: boolean): void => {
        detach()
        state.dialog = null
        this.invalidate()
        this.render(state)
        resolve(value)
      }
      // Mouse: a real hit map, measured from the painted row. A click anywhere
      // else is a reject — dismissing a gate must never take the action.
      const mouse = (event: MouseEvent): void => {
        // A wheel tick is not an answer. Without this guard a scroll over the
        // lit `Run once` row would approve the task — the worst possible
        // misfire on this screen.
        if (!event.press || event.motion || event.wheel) return
        const plain = (this.lastFrame[event.y - 1] ?? '').replace(ANSI_RE, '')
        if (plain.includes(runLabel)) { done(true); return }
        done(false)
      }
      const onKey = (key: TerminalKey): void => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) { done(false); return }
        if (key.name === 'escape') { done(false); return }
        const ch = (key.sequence ?? '').toLowerCase()
        // The numbered quick picks come from the choices themselves, so a
        // confirm's `1` means its `Yes` and an approval's means `Run once`.
        const quick = choices.find(choice => choice.key === ch)
        if (quick) { done(quick.value === 'run'); return }
        if (ch === 'y') { done(true); return }
        if (ch === 'n') { done(false); return }
        // Hermes' approval grammar: ↑/↓ move the `▸`, Enter takes the lit row,
        // 1/2 are quick picks, Esc denies. Default is No: both a factory run
        // and a session wipe are irreversible enough that a stray Enter must
        // never take them.
        if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
          if (state.dialog) {
            state.dialog.focus = key.name === 'up'
              ? 'run'
              : key.name === 'down'
                ? 'cancel'
                : state.dialog.focus === 'run' ? 'cancel' : 'run'
          }
          this.invalidate()
          this.render(state)
          return
        }
        if (key.name === 'return' || key.name === 'space') {
          done(state.dialog?.focus === 'run')
          return
        }
      }
      const detach = attachInput({
        key: onKey,
        // Focus reporting only: a PASTE is deliberately not handled here, so
        // pasting "y" can never approve a run or a session wipe.
        focus: focused => this.onFocus(state, focused),
        mouse,
        out: this.out,
      })
    })
  }
}

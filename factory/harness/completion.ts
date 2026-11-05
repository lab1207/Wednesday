/**
 * Composer completion — Wednesday's navigation engine.
 *
 * Adapted from Qwen Code (https://github.com/QwenLM/qwen-code), which is
 * Apache-2.0. Copyright 2025 Google LLC.
 * Changes: rewritten in plain TypeScript with no React/Ink dependency; the
 * scorer is our own implementation of the same subsequence idea; the token
 * rules and the clamp-on-shrink rule follow the originals.
 *
 * The FUZZY SCORER's contiguity pass and its alphanumeric swap are adapted
 * from pi (https://github.com/earendil-works/pi), which is MIT licensed,
 * Copyright (c) 2025 Mario Zechner (`packages/tui/src/fuzzy.ts`). Changes:
 * higher is better (pi's score is lower-is-better), the boundary and gap
 * weights are ours, and the alphanumeric swap is a penalised fallback rather
 * than a second score.
 *
 * Why it exists: qwen-code completes WHILE YOU TYPE — the operator types
 * `/mo` and the list narrows under the caret. Wednesday had a modal palette
 * (Ctrl+P) and nothing else, so a command was something you remembered and
 * typed in full. The port keeps the behaviour and drops the renderer.
 *
 * Everything here is PURE: no terminal, no filesystem, no clock. The screen
 * owns the drawing and the harness owns the data (the command list, the file
 * index, the recency); this module decides what is being completed and what
 * the candidates are. That split is what makes it testable — and it is the
 * same split qwen-code uses between `useCommandCompletion` (what to
 * complete) and `useCompletion` (the state machine).
 *
 * Three rules learned from qwen-code and kept here:
 *
 *  1. A `/` is a command only at the start of a line or after whitespace, and
 *     `//` / `/*` are comments, not commands. A pasted path must not open
 *     the command list (that was B11).
 *  2. When the candidate list SHRINKS, the active index is clamped to it.
 *     A completion list that can point past its own end is the B176 bug
 *     wearing a different hat.
 *  3. A mid-line completion shows GHOST TEXT (the suffix, dim, inline) and
 *     does not open a panel — a three-letter completion must not steal the
 *     screen the operator is reading.
 */

/** A command the composer can complete. */
export interface CommandSpec {
  /** The command as typed, including the slash (`/model`). */
  name: string
  /** One line of help, shown beside the candidate. */
  desc: string
  /** What the command expects (`<id>`), shown as ghost text. */
  argHint?: string
  /** Other names the command answers to. */
  aliases?: string[]
}

/** What a candidate is. */
export type CompletionKind = 'command' | 'file' | 'dir'

/** One candidate. */
export interface CompletionItem {
  /** The text inserted into the composer when the candidate is accepted. */
  value: string
  /** The name shown on the left of the row. */
  label: string
  /** The help or path shown on the right of the row. */
  detail: string
  kind: CompletionKind
  /** What the command expects (`<id>`), shown as ghost text once typed. */
  argHint?: string
  /** Higher is better. Not shown. */
  score: number
}

/** The completion the composer is showing right now. */
export interface CompletionState {
  /** The candidates, best first. */
  items: CompletionItem[]
  /** Which candidate is highlighted. Always inside `items` (clamped). */
  active: number
  /** Start of the range in the composer text that acceptance replaces. */
  start: number
  /** End of that range (exclusive). */
  end: number
  /**
   * The suffix shown dim after the caret — the rest of the best candidate's
   * name. Empty when there is nothing to ghost.
   */
  ghost: string
  /**
   * True when the typed text already IS a command: Enter must RUN it, not
   * accept a candidate. This is the difference between "type `/status` and
   * press Enter" and "type `/stat` and press Enter to complete".
   */
  exact: boolean
  /**
   * True when the OVERLAY (a list of candidates) should be drawn; false when
   * the completion is ghost text only.
   *
   * A mid-line completion is ghost-only: qwen-code's rule, and the right one
   * — a three-letter completion in the middle of a sentence must not steal
   * the screen the operator is reading.
   */
  panel: boolean
}

/** How many candidates the overlay shows at once. */
export const COMPLETION_VISIBLE = 8

/** How many candidates are kept in total. */
export const COMPLETION_LIMIT = 50

/**
 * Score a candidate against a query, or `null` when it does not match.
 *
 * The shape is the one fzf popularised and qwen-code uses: every query
 * character must appear, IN ORDER, but not necessarily side by side — so
 * `mdl` finds `/model`. On top of that:
 *
 *  - an EXACT match beats everything;
 *  - a PREFIX match beats a scattered one;
 *  - a character that starts a WORD (after `/`, `-`, `_`, `.` or a space)
 *    is worth more than one in the middle of a word, so `mdl` prefers
 *    `/model` over `/myDial`;
 *  - a gap costs, so `/model` beats `/m-o-d-e-l` for `model`;
 *  - CONTIGUOUS characters are worth much more than scattered ones;
 *  - a shorter candidate wins a tie, so `/model` beats `/model-port`.
 *
 * Two rules come from pi (https://github.com/earendil-works/pi, MIT,
 * Copyright (c) 2025 Mario Zechner — `packages/tui/src/fuzzy.ts`):
 *
 *  1. EVERY CONTIGUOUS OCCURRENCE is scored, not only the greedy one. The
 *     greedy alignment can scatter a query over an unrelated earlier part of
 *     the text: `opus` in `openrouter/openrouter/claude-opus` takes its `o`,
 *     `p` and `u` from `openrouter` and never reaches the model name. The
 *     contiguous occurrence is the one the operator meant.
 *  2. An ALPHANUMERIC QUERY is also tried the other way round: `opus4` also
 *     looks for `4opus`. It is a guess, so it pays a penalty — a real match
 *     always wins.
 *
 * Deterministic: the same query and candidate always give the same number.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (!q) return 0
  if (q === c) return 1000
  const greedy = greedyAlignment(q, c)
  if (!greedy) {
    const swapped = swapAlphaNumeric(q)
    if (!swapped) return null
    const alternative = greedyAlignment(swapped, c)
    if (!alternative) return null
    // The swap is a GUESS, so it scores below a real match.
    return finalizeScore(c, scoreAlignment(c, alternative), swapped) - 30
  }
  // The greedy alignment is one candidate; every CONTIGUOUS occurrence is
  // another. The best alignment wins.
  let best = scoreAlignment(c, greedy)
  let start = c.indexOf(q)
  while (start !== -1) {
    const positions: number[] = []
    for (let k = 0; k < q.length; k++) positions.push(start + k)
    const aligned = scoreAlignment(c, positions)
    if (aligned.score > best.score) best = aligned
    start = c.indexOf(q, start + 1)
  }
  return finalizeScore(c, best, q)
}

/** One alignment of the query inside the candidate. */
interface Alignment {
  /** Higher is better. */
  score: number
  /** True when at least one query character landed on a word start. */
  boundary: boolean
}

/**
 * The greedy subsequence alignment of `q` inside `c`, or `null`.
 *
 * Greedy means every query character takes the FIRST occurrence after the
 * previous one. It always finds a match when one exists in order — but not
 * always the RIGHT one, which is why every contiguous occurrence is scored
 * too.
 */
function greedyAlignment(q: string, c: string): number[] | null {
  const positions: number[] = []
  let from = 0
  for (const ch of q) {
    const at = c.indexOf(ch, from)
    if (at === -1) return null
    positions.push(at)
    from = at + 1
  }
  return positions
}

/** Score one alignment: word starts and contiguity are worth the most. */
function scoreAlignment(c: string, positions: number[]): Alignment {
  let score = 0
  let lastHit = -1
  let consecutive = 0
  let boundary = false
  for (const at of positions) {
    if (at === 0 || isWordBoundary(c.charAt(at - 1))) {
      // A word-start hit is worth more the closer it is to the front.
      score += 40 - Math.min(20, at)
      boundary = true
    } else {
      score += 12
    }
    if (lastHit >= 0) {
      const gap = at - lastHit - 1
      if (gap === 0) {
        // CONTIGUOUS characters: the run gets more valuable the longer it is.
        consecutive++
        score += 15 + consecutive * 5
      } else {
        consecutive = 0
        score -= Math.min(10, gap)
      }
    }
    lastHit = at
  }
  return { score, boundary }
}

/**
 * The final touches on an alignment: the prefix bonus, the word-start bonus
 * and the length penalty.
 */
function finalizeScore(c: string, alignment: Alignment, matched: string): number {
  let score = alignment.score
  if (c.startsWith(matched)) score += 60
  else if (alignment.boundary) score += 20
  score -= Math.min(30, c.length)
  return score
}

/**
 * The alphanumeric swap of a query: `opus4` becomes `4opus`.
 *
 * pi's rule (MIT): a query of letters followed by digits — or digits followed
 * by letters — is also tried the other way round, so `opus4` finds
 * `4opus.ts`. The swap is a guess, so the caller scores it below a real
 * match.
 */
function swapAlphaNumeric(q: string): string | null {
  const lettersThenDigits = /^([a-z]+)([0-9]+)$/.exec(q)
  if (lettersThenDigits) return `${lettersThenDigits[2]}${lettersThenDigits[1]}`
  const digitsThenLetters = /^([0-9]+)([a-z]+)$/.exec(q)
  if (digitsThenLetters) return `${digitsThenLetters[2]}${digitsThenLetters[1]}`
  return null
}

/** True for the characters that begin a new word inside a command name. */
function isWordBoundary(ch: string): boolean {
  return ch === '/' || ch === '-' || ch === '_' || ch === '.' || ch === ' '
}

/**
 * The `/command` token the caret sits in, or `null`.
 *
 * A `/` opens a command only at the start of a line or after whitespace, and
 * `//` / `/*` are comments. The token is the run of command characters after
 * the slash, and the caret must be at the END of it — a completion that
 * rewrites a token the caret is standing inside would replace text the
 * operator can still see.
 *
 * A path is not a command: `/usr/local` has a separator in the run, so the
 * token finder gives up and the pasted path never opens the command list
 * (that was B11).
 *
 * @returns the token's range in `text` and the name typed so far, WITHOUT
 * the leading slash.
 */
export function slashTokenAt(text: string, cursor: number): { start: number; end: number; token: string } | null {
  if (cursor < 0 || cursor > text.length) return null
  // Walk back over the command characters to the slash.
  let i = cursor
  while (i > 0 && isCommandChar(text.charAt(i - 1))) i--
  if (i === cursor) return null
  if (text.charAt(i - 1) !== '/') return null
  const slash = i - 1
  // The slash must start a line or follow whitespace.
  if (slash > 0 && !/\s/.test(text.charAt(slash - 1))) return null
  // `//` and `/*` are comments, not commands.
  if (text.charAt(slash + 1) === '/' || text.charAt(slash + 1) === '*') return null
  // A separator in the WORD means this is a PATH, not a command — `/usr/local`
  // and `C:/tools` must never open the command list. The check is on the
  // whole word (the slash and everything up to the next space), because the
  // separator can sit BEFORE the caret: in `/usr/local` the run after the
  // slash the caret sits in is `local`, which looks like a command name.
  const wordStart = Math.max(
    text.lastIndexOf('\n', slash - 1),
    text.lastIndexOf(' ', slash - 1),
    text.lastIndexOf('\t', slash - 1),
  ) + 1
  let wordEnd = slash + 1
  while (wordEnd < text.length && !/\s/.test(text.charAt(wordEnd))) wordEnd++
  if (text.slice(wordStart + 1, wordEnd).includes('/')) return null
  // The token ends at the first character that cannot be part of a command.
  let end = i
  while (end < text.length && isCommandChar(text.charAt(end))) end++
  // The caret must be at the END of the token.
  if (cursor !== end) return null
  return { start: slash, end, token: text.slice(slash + 1, cursor) }
}

/** Characters that can be part of a command name. */
function isCommandChar(ch: string): boolean {
  return /[A-Za-z0-9_:-]/.test(ch)
}

/**
 * The `@path` token the caret sits in, or `null`.
 *
 * The token ends at an UNESCAPED space, so a path with spaces can be typed
 * as `my\ file.ts`. The query is the WHOLE path token, not just the part
 * before the caret: accepting a file replaces the path, wherever the caret
 * is inside it.
 *
 * The range starts AFTER the `@`: the operator typed that, and the accepted
 * value is a bare path.
 */
export function atTokenAt(text: string, cursor: number): { start: number; end: number; token: string } | null {
  if (cursor < 0 || cursor > text.length) return null
  let i = cursor
  while (i > 0) {
    const ch = text.charAt(i - 1)
    if (isPathChar(ch) && ch !== '\\') { i--; continue }
    // An ESCAPED space is part of the path (`my\ file.ts`), so the scan
    // crosses it — and the backslash with it.
    if (ch === ' ' && i >= 2 && text.charAt(i - 2) === '\\') { i -= 2; continue }
    break
  }
  if (i === cursor) return null
  const at = i - 1
  if (text.charAt(at) !== '@') return null
  if (at > 0 && !/\s/.test(text.charAt(at - 1))) return null
  let end = i
  while (end < text.length) {
    const ch = text.charAt(end)
    if (ch === ' ' && text.charAt(end - 1) !== '\\') break
    if (!isPathChar(ch) && ch !== ' ') break
    end++
  }
  const token = text.slice(at + 1, end).replace(/\\(.)/g, '$1')
  return { start: at + 1, end, token }
}

/** Characters that can be part of a file path. */
function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9_./\\-~]/.test(ch)
}

/**
 * The candidates for a command query, best first.
 *
 * Recency is a TIE-BREAK, not an override: a command that does not match the
 * query never surfaces, however often it was used. Among the matches, the
 * one used most recently comes first — the operator's own habits, not a
 * guess about what they might want.
 */
export function rankCommands(
  query: string,
  commands: readonly CommandSpec[],
  recent: readonly string[] = [],
): CompletionItem[] {
  const q = query.replace(/^\//, '').toLowerCase()
  const recency = new Map<string, number>()
  recent.forEach((name, index) => recency.set(name, recent.length - index))
  const scored: Array<{ item: CompletionItem; used: number }> = []
  for (const command of commands) {
    if (command.name.startsWith('<')) continue // `<request>` is prose, not a command
    const bare = command.name.replace(/^\//, '')
    let best: number | null = null
    for (const candidate of [bare, ...(command.aliases ?? [])]) {
      const score = fuzzyScore(q, candidate)
      if (score === null) continue
      const weighted = score + (recency.get(command.name) ?? 0)
      if (best === null || weighted > best) best = weighted
    }
    if (best === null) continue
    scored.push({
      item: {
        value: command.name,
        label: command.name,
        detail: command.desc,
        kind: 'command',
        argHint: command.argHint,
        score: best,
      },
      used: recency.get(command.name) ?? 0,
    })
  }
  scored.sort((a, b) => b.item.score - a.item.score || b.used - a.used || a.item.label.localeCompare(b.item.label))
  return scored.slice(0, COMPLETION_LIMIT).map(entry => entry.item)
}

/**
 * The candidates for a file-path query, best first.
 *
 * The path is matched against the WHOLE path, so `sr` finds
 * `factory/harness/screen.ts` — but the score also rewards a match in the
 * file name, because that is what the operator is thinking about.
 *
 * DIRECTORIES come with a trailing `/` (pi's rule, MIT) and rank slightly
 * above a file of the same relevance, so `@factory` offers `factory/` before
 * `factory/harness/screen.ts`: the operator is still choosing the folder.
 * The bonus is small — a file that matches the query properly always wins.
 */
export function rankFiles(query: string, files: readonly string[]): CompletionItem[] {
  const q = query.replace(/^@/, '').toLowerCase()
  const scored: Array<{ item: CompletionItem; score: number }> = []
  for (const file of files) {
    // A directory is stored with a trailing slash: `factory/` means "the
    // folder", `factory/screen.ts` means "the file".
    const isDir = file.endsWith('/')
    const bare = isDir ? file.slice(0, -1) : file
    const lower = bare.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const whole = fuzzyScore(q, lower)
    const base = fuzzyScore(q, name)
    if (whole === null && base === null) continue
    const score = (whole ?? -1000) + (base ?? -1000) / 2 + (isDir ? 15 : 0)
    scored.push({
      item: {
        value: file,
        label: file,
        detail: isDir ? 'directory' : '',
        kind: isDir ? 'dir' : 'file',
        score,
      },
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
  return scored.slice(0, COMPLETION_LIMIT).map(entry => entry.item)
}

/** What the completion engine needs to know about the world. */
export interface CompletionContext {
  /** The commands the operator can run. */
  commands: readonly CommandSpec[]
  /**
   * The workspace paths `@` can reach — LAZY, because the index is a
   * filesystem scan and the engine must not pay for it on every keystroke.
   * Called only when the operator has actually typed an `@`.
   */
  files?: () => readonly string[]
  /** Command names used recently, most recent first. */
  recent?: readonly string[]
  /**
   * A mid-line completion shows ghost text instead of a panel. On by default
   * (qwen-code's rule): a three-letter completion must not steal the screen.
   */
  inlineOnly?: boolean
}

/**
 * The completion for the text the operator is typing, or `null`.
 *
 * The decision order matters and follows qwen-code: an `@` is checked FIRST,
 * so typing `@` after a slash command still reaches the file list.
 *
 * @param text the whole composer text
 * @param cursor where the caret is (a code-unit offset)
 */
export function completionFor(
  text: string,
  cursor: number,
  context: CompletionContext,
): CompletionState | null {
  const at = atTokenAt(text, cursor)
  if (at) {
    const items = rankFiles(at.token, context.files ? context.files() : [])
    if (items.length === 0) return null
    return {
      items,
      active: 0,
      start: at.start,
      end: at.end,
      ghost: '',
      exact: false,
      panel: true,
    }
  }
  const slash = slashTokenAt(text, cursor)
  if (!slash) return null
  const items = rankCommands(slash.token, context.commands, context.recent ?? [])
  if (items.length === 0) return null
  // "Exact" means the typed token IS a command — not "the best-ranked
  // candidate happens to equal it". Recency can put a different command
  // first, and Enter must still RUN the command the operator typed.
  const typed = slash.token.toLowerCase()
  const exact = context.commands.some(c => c.name.replace(/^\//, '').toLowerCase() === typed)
  const best = items[0]!
  const bare = best.value.replace(/^\//, '')
  // A complete command ghosts its ARGUMENT HINT (`/tasks` -> `<id>`); a
  // partial one ghosts the rest of the name (`/mo` -> `del`). qwen-code's
  // rule, and it is the one that teaches the operator what to type next.
  const ghost = exact ? (best.argHint ?? '') : bare.slice(slash.token.length)
  // A mid-line command is a GHOST, not a panel: a three-letter completion in
  // the middle of a sentence must not steal the screen the operator is
  // reading. A command at the line start opens the panel.
  const midLine = slash.start > 0
  if (midLine || context.inlineOnly) {
    return {
      items,
      active: 0,
      start: slash.start,
      end: slash.end,
      ghost,
      exact,
      panel: false,
    }
  }
  return { items, active: 0, start: slash.start, end: slash.end, ghost, exact, panel: true }
}

/**
 * Clamp the active index into the candidate list.
 *
 * The list shrinks when the query narrows, and an active index that points
 * past the end is a selection nobody can see — the B176 bug. Every state
 * change goes through here.
 */
export function clampActive(state: CompletionState): CompletionState {
  if (state.items.length === 0) return { ...state, active: 0 }
  if (state.active < 0) return { ...state, active: 0 }
  if (state.active > state.items.length - 1) return { ...state, active: state.items.length - 1 }
  return state
}

/**
 * Move the active candidate, wrapping at both ends.
 *
 * Wrapping is qwen-code's rule: a list you can leave by pressing Up is a
 * list with a dead edge.
 */
export function moveActive(state: CompletionState, direction: 1 | -1): CompletionState {
  if (state.items.length === 0) return state
  const next = direction === 1
    ? (state.active + 1) % state.items.length
    : (state.active - 1 + state.items.length) % state.items.length
  return { ...state, active: next }
}

/**
 * The text that acceptance puts into the composer.
 *
 * The candidate replaces the token the caret was in, and the rest of the
 * draft is kept. A command is inserted with a trailing space so the next
 * word does not run into it.
 */
export function acceptedText(text: string, state: CompletionState): string {
  const item = state.items[state.active]
  if (!item) return text
  const before = text.slice(0, state.start)
  const after = text.slice(state.end)
  const needsSpace = item.kind === 'command' && !/[\s]/.test(after.charAt(0))
  const inserted = item.value + (needsSpace ? ' ' : '')
  return before + inserted + after
}

/**
 * The text that accepting the GHOST puts into the composer.
 *
 * The ghost is only a suffix, so it replaces the typed token with the whole
 * candidate name.
 */
export function acceptedGhostText(text: string, state: CompletionState): string {
  if (!state.ghost) return text
  const item = state.items[state.active] ?? state.items[0]
  if (!item) return text
  const before = text.slice(0, state.start)
  const after = text.slice(state.end)
  return before + item.value + after
}

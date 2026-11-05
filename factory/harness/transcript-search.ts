/**
 * TRANSCRIPT SEARCH — find text in what the operator can read.
 *
 * Adapted from pi (https://github.com/earendil-works/pi), which is MIT
 * licensed, Copyright (c) 2025 Mario Zechner
 * (`packages/tui/src/alt-screen-search.ts`). Changes: the corpus is the
 * rendered transcript (plain rows) instead of pi's grapheme-segmented
 * renderer, the offsets are code-point offsets in the plain row rather than
 * renderer columns, and the navigation model (the n/total counter, the
 * next/previous keys) is ours. The MATCHING RULE is pi's: the query is
 * LITERAL and case-insensitive — a search for `a.b` finds `a.b`, never `axb`.
 *
 * Why it exists: the transcript is the only record of what the factory said,
 * and scrolling it by hand is a terrible way to answer "what did it name in
 * that file?". The operator needs to SEARCH it, and needs to know how many
 * hits there are — a search that cannot say "3 of 12" leaves the operator
 * guessing whether the thing they want is on the page.
 *
 * Everything here is PURE: no terminal, no clock, no state. The screen owns
 * the query, the counter and the drawing; this module decides what matches
 * and where.
 */

/** One highlighted run inside one row. */
export interface SearchSegment {
  /** The row (0-based) the run is on. */
  row: number
  /** Start offset in the row's PLAIN text, in code points. */
  start: number
  /** End offset in the row's plain text (exclusive), in code points. */
  end: number
}

/** One hit. A query that wraps across rows produces several segments. */
export interface SearchMatch {
  segments: SearchSegment[]
}

/**
 * The live search: the query and where the operator is in the hits.
 *
 * The state lives with the screen, not here — this module is pure matching.
 */
export interface SearchState {
  /** What the operator typed. */
  query: string
  /** Which hit is active (0-based). */
  active: number
  /** How many hits the last render found. */
  total: number
}

/**
 * The query, normalised.
 *
 * Runs of whitespace collapse to one space and the ends are trimmed, so a
 * query typed with a stray double space still finds the phrase.
 */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/gu, ' ').trim()
}

/**
 * Strip the terminal escapes from a row.
 *
 * The transcript is styled, so the raw row is not the text the operator
 * reads: without this, a search for `violet` could miss a word that is
 * wrapped in a colour change, and the offsets would be counting escape
 * bytes. OSC 8 hyperlinks are stripped too — their payload is a URL the
 * operator never sees.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/**
 * The corpus: the rows joined by a space, with the offset of every row.
 *
 * A space joins them rather than a newline because the transcript WRAPS:
 * the phrase the operator is looking for is often broken across two drawn
 * rows, and a search that cannot cross a wrap is a search that misses the
 * obvious.
 */
interface Corpus {
  text: string
  /** The offset each row starts at, in the corpus text. */
  starts: number[]
  /** The plain text of each row. */
  rows: string[]
}

function buildCorpus(rows: readonly string[]): Corpus {
  const plain = rows.map(stripAnsi)
  const starts: number[] = []
  let text = ''
  plain.forEach((row, index) => {
    if (index > 0) text += ' '
    starts.push(text.length)
    text += row
  })
  return { text, starts, rows: plain }
}

/**
 * The segments of one hit, mapped back onto the rows they came from.
 *
 * A hit that crosses a row boundary produces one segment per row, so the
 * highlighter can mark both halves.
 */
function segmentsFor(corpus: Corpus, at: number, end: number): SearchSegment[] {
  const segments: SearchSegment[] = []
  for (let row = 0; row < corpus.rows.length; row++) {
    const rowStart = corpus.starts[row]!
    const rowEnd = rowStart + corpus.rows[row]!.length
    if (rowEnd <= at) continue
    if (rowStart >= end) break
    const from = Math.max(at, rowStart) - rowStart
    const to = Math.min(end, rowEnd) - rowStart
    if (to > from) segments.push({ row, start: from, end: to })
  }
  return segments
}

/**
 * Every hit of `query` in `rows`, in reading order.
 *
 * The query is LITERAL: the metacharacters of a regular expression are
 * matched as themselves. An operator who searches for `fix:` wants the
 * literal text, not a regex that throws on the colon or matches something
 * else entirely.
 */
export function findMatches(rows: readonly string[], query: string): SearchMatch[] {
  const needle = normalizeQuery(query).toLowerCase()
  if (!needle) return []
  const corpus = buildCorpus(rows)
  const haystack = corpus.text.toLowerCase()
  const matches: SearchMatch[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const end = at + needle.length
    const segments = segmentsFor(corpus, at, end)
    if (segments.length > 0) matches.push({ segments })
    // Overlapping hits are not found twice: the next search starts AFTER the
    // current hit's first character.
    at = haystack.indexOf(needle, at + 1)
  }
  return matches
}

/**
 * The counter the panel shows: `3/12`, or `no matches`.
 *
 * The counter is the point of the panel. A search that finds something but
 * cannot say how much more there is leaves the operator pressing Enter
 * forever, wondering whether they have reached the end.
 */
export function searchLabel(active: number, total: number): string {
  if (total <= 0) return 'no matches'
  const index = Math.max(0, Math.min(active, total - 1))
  return `${index + 1}/${total}`
}

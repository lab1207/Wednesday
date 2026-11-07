/**
 * JSON salvage for small models.
 *
 * A small model that emits slightly-broken JSON used to produce a null
 * parse, and a null parse SILENTLY muted the reviewer: the seat had nothing
 * to say, so the run looked like a model that chose to stay quiet instead of
 * a model whose answer was dropped on the floor. These helpers recover the
 * JSON instead of dropping it, and say WHY a parse failed so the receipt can
 * carry the reason.
 *
 * The string-state repair is a faithful port of the salvage path in
 * `factory/dsh-worker/local-tool-proxy.ts` (small models emit raw newlines
 * inside string values, JS-flavored escapes such as `\'`, and BARE double
 * quotes inside values). On top of that this module handles markdown
 * fences, trailing commas, single-quoted strings, prose around the payload,
 * and a payload that was cut off mid-flight.
 *
 * Pure, deterministic, no dependencies.
 */

/** JSON whitespace. */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * True when a `'` at `index` opens a JSON-ish string instead of being an
 * apostrophe in prose ("it's fine"). A single quote only opens a string in
 * VALUE position: right after `:`, `,`, `[`, `{` (or at the very start).
 */
function isQuotePosition(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text.charAt(i)
    if (isSpace(ch)) continue
    return ch === ':' || ch === ',' || ch === '[' || ch === '{'
  }
  return true
}

/**
 * Index of the `'` that closes a single-quoted string, or -1 when there is
 * none on the same line (an apostrophe in prose must not swallow the rest
 * of the answer).
 */
function findSingleQuoteEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text.charAt(i)
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === "'") return i
    if (ch === '\n') return -1
  }
  return -1
}

/**
 * Rewrite single-quoted strings as double-quoted ones. Small models emit
 * Python/JS-flavored dicts (`{'name': 'write'}`). Only quotes in VALUE
 * position are touched, and only when a matching closing quote exists, so
 * prose apostrophes and unterminated quotes survive untouched.
 */
function convertSingleQuotes(text: string): string {
  let out = ''
  let inDouble = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inDouble) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      out += ch
      continue
    }
    if (ch === "'" && isQuotePosition(text, i)) {
      const end = findSingleQuoteEnd(text, i)
      if (end !== -1) {
        const body = quoteBodyAsDouble(text.slice(i + 1, end))
        out += '"' + body + '"'
        i = end
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * The body of a single-quoted string, re-quoted for JSON: a bare `"` is
 * escaped, an existing escape pair is kept (the string-state repair below
 * normalizes the illegal ones).
 */
function quoteBodyAsDouble(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i)
    if (ch === '\\' && i + 1 < body.length) {
      out += ch + body.charAt(i + 1)
      i++
      continue
    }
    if (ch === '"') {
      out += '\\"'
      continue
    }
    out += ch
  }
  return out
}

/**
 * Repair the STRING STATE of a JSON-ish text (faithful port of the
 * `repairJsonSlice` core in `factory/dsh-worker/local-tool-proxy.ts`).
 *
 * Small models emit raw newline/tab bytes inside string values (not the
 * JSON `\n` escape), JS-flavored escapes (`\'`, `\a`) that strict JSON
 * forbids, and BARE double quotes inside values (python `"""` docstrings
 * emitted unescaped). Rewrite all three into valid JSON while tracking
 * string and escape state, so only the inside of quoted values is touched.
 * A backslash is emitted only when the next character is a legal JSON
 * escape; otherwise the bare character wins. A `"` inside a string closes
 * it only when the next non-space character is structural
 * (`,`, `}`, `]`, `:`) or end-of-input - otherwise it is a literal quote
 * and is escaped. Bare `"` cannot legally appear inside a valid JSON
 * string at all, so this rule is identity on well-formed input.
 */
function repairJsonStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
        if (
          ch === '"' || ch === '\\' || ch === '/' || ch === 'b' || ch === 'f' ||
          ch === 'n' || ch === 'r' || ch === 't' || ch === 'u'
        ) {
          out += '\\' + ch
        } else {
          out += ch
        }
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        let j = i + 1
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
        const next = j < text.length ? text[j] : ''
        if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
          out += ch
          inString = false
        } else {
          out += '\\"'
        }
      } else if (ch === '\n' || ch === '\r') {
        out += '\\n'
      } else if (ch === '\t') {
        out += '\\t'
      } else {
        out += ch
      }
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

/**
 * Drop a comma that sits directly before a closing brace or bracket
 * (`{"a":1,}`). Commas inside string values are untouched.
 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && isSpace(text.charAt(j))) j++
      const next = j < text.length ? text.charAt(j) : ''
      if (next === '}' || next === ']') continue
    }
    out += ch
  }
  return out
}

/**
 * Close an open string and the open braces/brackets of a truncated
 * payload. Nothing is invented: only the missing closers are added.
 */
function completeBraces(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']')
      continue
    }
    if (ch === '}' || ch === ']') stack.pop()
  }
  let out = text
  if (inString) {
    if (escaped) out += '\\\\'
    out += '"'
  }
  // A truncated payload can end on a dangling ',' or ':' - drop it before
  // the closers go on.
  out = out.replace(/[\s,:]+$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]
  return out
}

/**
 * The body of the first fenced block (```json ... ```), or null when the
 * text has no fence. An unterminated fence yields everything after it.
 */
function fencedBlock(text: string): string | null {
  const closed = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (closed) return closed[1] ?? ''
  const open = /```(?:json)?\s*([\s\S]*)$/i.exec(text)
  if (open) return open[1] ?? ''
  return null
}

/** Index of the first `{` or `[`, or -1. */
function firstBraceOrBracket(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (ch === '{' || ch === '[') return i
  }
  return -1
}

/**
 * The balanced object/array that starts at `start`, or null when the text
 * from there never balances.
 */
function balancedSlice(text: string, start: number): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "'" && isQuotePosition(text, i)) {
      const end = findSingleQuoteEnd(text, i)
      if (end !== -1) {
        i = end
        continue
      }
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']')
      continue
    }
    if (ch === '}' || ch === ']') {
      const expected = stack.pop()
      if (expected !== ch) return null
      if (stack.length === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Extract the first balanced JSON object or array from free text.
 * The slice is returned RAW (no repair applied).
 */
export function extractJsonObject(text: string): string | null {
  if (!text) return null
  for (let start = 0; start < text.length; start++) {
    const ch = text.charAt(start)
    if (ch !== '{' && ch !== '[') continue
    const slice = balancedSlice(text, start)
    if (slice !== null) return slice
  }
  return null
}

/**
 * Repair a model's JSON-ish output. Returns null when nothing salvageable.
 *
 * Handles markdown fences, trailing commas, single quotes, prose around the
 * payload, a `} ] }` tail after a complete object, and a payload that was
 * cut off mid-flight (the open braces/brackets are closed and retried).
 */
export function repairJsonSlice(text: string): string | null {
  if (!text || !text.trim()) return null

  // A fenced block is the model's own statement of "this is the JSON".
  const fenced = fencedBlock(text)
  const source = fenced !== null ? fenced : text

  // Prefer the first balanced object/array; fall back to the first opening
  // brace/bracket so a truncated payload can be completed.
  let candidate = extractJsonObject(source)
  if (candidate === null) {
    const start = firstBraceOrBracket(source)
    if (start === -1) return null
    candidate = source.slice(start)
  }

  const repaired = stripTrailingCommas(
    completeBraces(repairJsonStrings(convertSingleQuotes(candidate))),
  )

  try {
    JSON.parse(repaired)
  } catch {
    return null
  }
  return repaired
}

/**
 * Parse strict JSON; on failure try the repair path. Returns null when
 * unparseable. Never invents data: text with no JSON-ish content at all
 * yields null.
 */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text || !text.trim()) return null

  // 1. Strict parse of the whole answer.
  try {
    return JSON.parse(text.trim()) as T
  } catch {
    // Fall through to the repair path.
  }

  // 2. Strict parse of a fenced block.
  const fenced = fencedBlock(text)
  if (fenced !== null) {
    try {
      return JSON.parse(fenced.trim()) as T
    } catch {
      // Fall through to the repair path.
    }
  }

  // 3. The repair path.
  const repaired = repairJsonSlice(text)
  if (repaired === null) return null
  try {
    return JSON.parse(repaired) as T
  } catch {
    return null
  }
}

/**
 * Describe why a parse failed, for a receipt. Short and actionable.
 */
export function describeJsonFailure(text: string): string {
  const chars = text.length
  if (!text || !text.trim()) return 'empty model response (no JSON)'
  if (!text.includes('{') && !text.includes('[')) {
    return `no JSON object found in ${chars} chars`
  }
  if (extractJsonObject(text) === null) {
    return `truncated or unbalanced JSON in ${chars} chars`
  }
  return `malformed JSON in ${chars} chars (repair failed)`
}

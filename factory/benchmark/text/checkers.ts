/**
 * Text-response checkers — Tier-3 evaluation path (IFEval/MATH style).
 *
 * The file-workspace runner grades WORKSPACES; text boards grade RESPONSE
 * TEXT. These checkers are the response-side equivalent: pure functions
 * over (response, expectation), no model, no network. Constraint shapes
 * follow IFEval's verifiable-instruction kinds (Apache-2.0, Google —
 * reimplemented originally, nothing vendored) plus a MATH-style numeric
 * answer check. Runner wiring (prompt → crew text → checkers) is the next
 * slice; this module + its tests are fully provable offline with canned
 * response strings.
 */

export interface CheckResult {
  passed: boolean
  detail: string
}

export type TextChecker = (response: string, expected: string) => CheckResult

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Exact answer match after whitespace normalization (MATH closed form). */
export const exactMatch: TextChecker = (response, expected) => {
  const passed = normalize(response) === normalize(expected)
  return { passed, detail: passed ? 'exact match' : 'text differs' }
};

/** Every required keyword/phrase must appear (case-insensitive). */
export function containsAll(keywords: string[]): TextChecker {
  return (response) => {
    const missing = keywords.filter(k => !response.toLowerCase().includes(k.toLowerCase()))
    return {
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'all keywords present' : `missing: ${missing.join(', ')}`,
    }
  }
}

/** No forbidden phrase may appear (case-insensitive). */
export function containsNone(forbidden: string[]): TextChecker {
  return (response) => {
    const hit = forbidden.filter(k => response.toLowerCase().includes(k.toLowerCase()))
    return {
      passed: hit.length === 0,
      detail: hit.length === 0 ? 'no forbidden phrases' : `forbidden present: ${hit.join(', ')}`,
    }
  }
}

/** Word count within [min, max] inclusive. */
export function wordCountRange(min: number, max: number): TextChecker {
  return (response) => {
    const words = response.trim().split(/\s+/).filter(Boolean).length
    const passed = words >= min && words <= max
    return { passed, detail: `words ${words} (allowed ${min}-${max})` }
  }
}

/**
 * MATH-style numeric answer: extracts `\boxed{...}` (or the trailing
 * number when no box) and compares with tolerance. Fractions a/b and
 * decimals both parse; symbolic answers stay exact-string business.
 */
export const numericEqual: TextChecker = (response, expected) => {
  const parse = (text: string): number | null => {
    const boxed = /\\boxed\{([^}]*)\}/.exec(text)
    const raw = (boxed ? boxed[1] : text.trim().split(/\s+/).pop() ?? '').trim()
    const frac = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*([+-]?\d+(?:\.\d+)?)$/.exec(raw)
    if (frac) {
      const denom = Number(frac[2])
      if (denom === 0) return null
      return Number(frac[1]) / denom
    }
    const num = Number(raw.replace(/,/g, ''))
    return Number.isFinite(num) ? num : null
  }
  const got = parse(response)
  const want = parse(expected)
  if (got === null || want === null) {
    return { passed: false, detail: 'no parseable number in response or expected' }
  }
  const passed = Math.abs(got - want) <= 1e-9
  return { passed, detail: passed ? `numeric match (${got})` : `got ${got}, want ${want}` }
};

/** Response must be valid JSON, optionally holding required top-level keys. */
export function jsonShape(requiredKeys: string[] = []): TextChecker {
  return (response) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(response.trim())
    } catch {
      return { passed: false, detail: 'not valid JSON' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { passed: false, detail: 'JSON must be an object' }
    }
    const missing = requiredKeys.filter(k => !(k in (parsed as Record<string, unknown>)))
    return {
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'valid JSON, keys present' : `missing keys: ${missing.join(', ')}`,
    }
  }
}

export interface TextProblem {
  id: string
  prompt: string
  expected: string
  checkers: TextChecker[]
}

/** All checkers must pass; details join for the evidence record. */
export function gradeResponse(problem: TextProblem, response: string): CheckResult {
  const results = problem.checkers.map(check => check(response, problem.expected))
  const failed = results.filter(r => !r.passed)
  return {
    passed: failed.length === 0,
    detail: results.map(r => r.detail).join(' | '),
  }
}

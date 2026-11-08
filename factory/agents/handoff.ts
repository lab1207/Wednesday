/**
 * The role hand-off, normalised at the seam (2026-11-08, B229).
 *
 * WHY (operator report, 2026-11-08, the "deterministic role hand-offs"
 * pillar): every seat's answer enters the pipeline as UNTRUSTED JSON from a
 * model, but the TypeScript type says the fields are already strings and
 * arrays:
 *
 *     interface AgentOutput {
 *       findings: string[]
 *       recommendations: string[]
 *       blockingIssues: string[]
 *       filesChanged?: string[]
 *     }
 *
 * A small model answers `findings` with a bare string as often as with an
 * array -- that is perfectly legal JSON, and the type system cannot see it.
 * The consumers then do the only thing that type allows:
 *
 *     output.findings.slice(0, 6).map(...)   // TypeError: .map is not a function
 *     for (const file of output.filesChanged) // iterates CHARACTERS
 *
 * The first kills the run at the SEAM -- one seat's raw shape crashes the
 * next seat's prompt builder, with that seat's work already written to disk.
 * The second is quieter and worse: the receipt files the run's output one
 * LETTER at a time and nobody notices. This is the same defect class as
 * B149 (`change.slice is not a function`, fixed for three reviewer fields
 * only) and as B222 (a shape the type system swore was fine).
 *
 * THE FIX IS ONE FUNCTION AT ONE PLACE. Every consumer asks the same
 * question -- "what did this seat actually say?" -- and they must all get
 * the same answer regardless of how the model spelled it. Normalising in
 * each consumer means the next consumer is unpatched; normalising once here
 * means a seat's answer is readable by every seat after it, and the repairs
 * that were needed are REPORTED rather than silently absorbed.
 *
 * Pure and exported so the claim can be asserted without a model.
 */

import { toStringList } from './text-list'
import type { AgentOutput } from './types'

/** One seat's answer, in the shape every consumer can rely on. */
export interface Handoff {
  /** The seat that produced it. Empty when the answer named no seat. */
  role: string
  /** The one-line statement of what was done or found. */
  summary: string
  /** What was observed. */
  findings: string[]
  /** What should happen next. */
  recommendations: string[]
  /** What is wrong. Empty means the seat passed its own work. */
  blockingIssues: string[]
  /** The files the seat says it changed. */
  filesChanged: string[]
  /** Anything else the seat said, preserved verbatim and bounded. */
  rest: Record<string, unknown>
}

/** The answer as read, plus what it cost to read it. */
export interface HandoffReading {
  handoff: Handoff
  /**
   * The fields that had to be repaired to make this answer readable.
   * Empty when the model already answered in the documented shape.
   */
  repairs: string[]
  /**
   * True when NOTHING usable came back -- no summary, no findings, no
   * recommendations, no blockers. A seat that said nothing at all is a
   * different failure from a seat that said something odd, and the caller
   * deserves to be able to tell them apart.
   */
  unusable: boolean
  /** Why the answer was unusable, in one line, for the receipt. */
  reason?: string
}

/** How many bytes of an unrecognised object are kept for the record. */
export const EXCERPT_CHARS = 2000

/** One text line out of anything, bounded, never throwing. */
function toText(value: unknown): { text: string; repaired: boolean } {
  if (typeof value === 'string') {
    return { text: value.trim(), repaired: false }
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value), repaired: true }
  }
  if (Array.isArray(value)) {
    const list = toStringList(value)
    return { text: list.join(' '), repaired: list.length > 0 }
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return { text: json.slice(0, EXCERPT_CHARS), repaired: true }
    } catch {
      return { text: '', repaired: true }
    }
  }
  return { text: '', repaired: false }
}

/**
 * Read a seat's answer into the shape every consumer can rely on.
 *
 * A bare string is still a finding, not a reason to drop the answer (the
 * B149 lesson): it becomes the summary. A number, a boolean or an object
 * becomes text. A null or an empty object is UNUSABLE -- and saying so is
 * the point, because a silent hand-off is how a run dies three stages later
 * with nothing to show for it.
 */
export function normalizeHandoff(value: unknown): HandoffReading {
  const repairs: string[] = []

  // A bare string is the model's answer, not its envelope.
  if (typeof value === 'string') {
    const summary = value.trim()
    if (summary.length === 0) {
      return {
        handoff: emptyHandoff(),
        repairs: ['summary'],
        unusable: true,
        reason: 'the seat returned an empty string.',
      }
    }
    repairs.push('summary')
    return {
      handoff: {
        role: '',
        summary,
        findings: [summary],
        recommendations: [],
        blockingIssues: [],
        filesChanged: [],
        rest: {},
      },
      repairs,
      unusable: false,
    }
  }

  if (value === null || value === undefined) {
    return {
      handoff: emptyHandoff(),
      repairs: [],
      unusable: true,
      reason: 'the seat returned no answer at all.',
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    const { text } = toText(value)
    // An array is a list of statements, not one blob: each entry survives
    // as its own finding, so nothing is lost by the repair.
    const findings = Array.isArray(value) ? toStringList(value) : text ? [text] : []
    return {
      handoff: {
        role: '',
        summary: text,
        findings,
        recommendations: [],
        blockingIssues: [],
        filesChanged: [],
        rest: {},
      },
      repairs: ['shape'],
      unusable:
        text.length === 0 && findings.length === 0,
      reason:
        text.length === 0 && findings.length === 0
          ? 'the seat answered with something that carries no text.'
          : undefined,
    }
  }

  const record = value as Record<string, unknown>

  const role =
    typeof record.role === 'string'
      ? record.role.trim()
      : ''
  if (typeof record.role !== 'string' && record.role !== undefined) {
    repairs.push('role')
  }

  const summaryRead = toText(record.summary)
  if (summaryRead.repaired || summaryRead.text.length === 0) {
    repairs.push('summary')
  }

  const findings = toStringList(record.findings)
  const recommendations = toStringList(record.recommendations)
  const blockingIssues = toStringList(record.blockingIssues)
  const filesChanged = toStringList(record.filesChanged)

  for (const field of [
    'findings',
    'recommendations',
    'blockingIssues',
    'filesChanged',
  ] as const) {
    const raw = record[field]
    const wanted = Array.isArray(raw)
    const typed = wanted && raw.every(item => typeof item === 'string')
    if (raw !== undefined && !(wanted && typed)) {
      repairs.push(field)
    }
  }

  const rest: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (
      key === 'role' ||
      key === 'summary' ||
      key === 'findings' ||
      key === 'recommendations' ||
      key === 'blockingIssues' ||
      key === 'filesChanged'
    ) {
      continue
    }
    rest[key] = item
  }

  const handoff: Handoff = {
    role,
    summary: summaryRead.text,
    findings,
    recommendations,
    blockingIssues,
    filesChanged,
    rest,
  }

  const saidAnything =
    handoff.summary.length > 0 ||
    handoff.findings.length > 0 ||
    handoff.recommendations.length > 0 ||
    handoff.blockingIssues.length > 0 ||
    handoff.filesChanged.length > 0

  return {
    handoff,
    repairs,
    unusable: !saidAnything,
    reason: saidAnything
      ? undefined
      : 'the seat returned an answer with no summary, no findings and no blockers.',
  }
}

/** An empty hand-off, for the unusable paths. */
function emptyHandoff(): Handoff {
  return {
    role: '',
    summary: '',
    findings: [],
    recommendations: [],
    blockingIssues: [],
    filesChanged: [],
    rest: {},
  }
}

/**
 * The blockers a seat reported, as strings, never throwing.
 *
 * The convenience call site: `buildRepairFeedback` needs the list, not the
 * whole reading, and it must never die reading it.
 */
export function handoffBlockingIssues(value: unknown): string[] {
  return normalizeHandoff(value).handoff.blockingIssues
}

/**
 * The files a seat reported changing, as strings, never throwing.
 *
 * The receipt asks this of every seat. A seat that answered with a bare
 * string used to hand the receipt one file per character.
 */
export function handoffFilesChanged(value: unknown): string[] {
  return normalizeHandoff(value).handoff.filesChanged
}

/**
 * A seat's answer as an AgentOutput, repaired ONLY when it has to be.
 *
 * THE SAME OBJECT IS RETURNED when the answer already has the documented
 * shape -- reference for reference, byte for byte. That is the strongest
 * guarantee available: no well-shaped run can be changed by this function,
 * because the repair path is only ever reached by an answer that would
 * otherwise crash or corrupt a consumer.
 *
 * This is the seam the dispatcher applies, so every consumer after it --
 * the orchestrator's stage bookkeeping, the repair feedback, the duel and
 * ballot merges, the specialist gate and the service receipt -- reads the
 * fields the normaliser guarantees.
 */
export function normalizeAgentOutput(
  value: unknown,
): AgentOutput {
  const reading =
    normalizeHandoff(
      value,
    )

  const isObject =
    typeof value ===
      'object' &&
    value !== null &&
    !Array.isArray(
      value,
    )

  // Nothing needed repair: hand back the caller's own object, untouched.
  if (
    reading.repairs.length ===
      0 &&
    isObject
  ) {
    return value as AgentOutput
  }

  const {
    role,
    summary,
    findings,
    recommendations,
    blockingIssues,
    filesChanged,
    rest,
  } =
    reading.handoff

  // Rebuilt from the preserved rest plus the guaranteed fields, so nothing
  // the seat said outside the six known fields is lost -- the reviewer's
  // `review` block and the coder's `instructions` travel with it.
  return {
    ...rest,
    role,
    summary,
    findings,
    recommendations,
    blockingIssues,
    filesChanged,
  } as unknown as AgentOutput
}

/**
 * One human line naming the repairs a hand-off needed.
 *
 * Empty when the model answered in the documented shape, so a clean run is
 * never told it was repaired.
 */
export function describeHandoffRepairs(repairs: readonly string[]): string {
  if (repairs.length === 0) return ''
  return 'hand-off repaired: ' + repairs.join(', ')
}

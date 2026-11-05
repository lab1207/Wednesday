/**
 * "A prompt was trimmed to fit" — recorded, so the surface can say it.
 *
 * Trimming is the correct behaviour when a prompt exceeds the model window, but
 * doing it SILENTLY is how a build produces thinner output than its request
 * asked for and nobody can explain why. The provider records the fact; the
 * harness reads it after a run and prints one line. Nothing here talks to a
 * terminal — it is a counter with the last report attached, so the module stays
 * callable from a test and from a provider alike.
 */

export interface TrimReport {
  model: string
  /** Estimated tokens the prompt would have been. */
  before: number
  /** Estimated tokens actually sent. */
  after: number
  at: number
}

let report: TrimReport | null = null

export function recordTrimmedPrompt(model: string, before: number, after: number): void {
  report = { model, before, after, at: Date.now() }
}

/** The last trim, if any (null when every prompt so far fit). */
export function lastTrimReport(): TrimReport | null {
  return report
}

/** Clear it at the start of a run so a receipt never quotes an older trim. */
export function clearTrimReport(): void {
  report = null
}

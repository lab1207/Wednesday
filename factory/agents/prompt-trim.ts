/**
 * Trimming a prompt WITHOUT losing its operative rules.
 *
 * WHY (operator report, 2026-11-07, run
 * harness-31b3c35a-f3d5-41b2-987d-fc537d13f287):
 * the coder's external prompt was capped with a head-only trim:
 *
 *     limitText(sections.join('\n'), 12000)
 *
 * `limitText` keeps the HEAD and drops the TAIL. The tail of that prompt is
 * not commentary -- it is the operative block:
 *
 *     STRICT EXECUTION RULES:
 *     - Work directly in the specified workspace.
 *     ...
 *     FINAL REQUIREMENT:
 *     Perform the task now.
 *
 * So on any prompt over 12,000 characters -- which is every repair attempt
 * with planner guidance, ECC rules and a specialist checklist in it -- the
 * rules that tell the model how to behave were the FIRST thing discarded,
 * and the model was left with the task text and nothing else. The prompt was
 * still "valid"; it was just missing its instructions.
 *
 * The fix is a different trim: keep the HEAD (the task, the criteria, the
 * commands) and the TAIL (the rules), and drop from the MIDDLE (the bulky,
 * repeatable context). The middle is where the planner's steps, the ECC
 * rules and the specialist checklists live -- all of them are context the
 * model can do without, and all of them are re-sent on every attempt.
 *
 * The marker line says exactly how much was dropped, so a truncated prompt
 * is never mistaken for a complete one.
 *
 * Pure and exported so the claim can be asserted without a model.
 */

/** How many characters of the tail are always kept. */
export const DEFAULT_TAIL_CHARS = 1400

/**
 * Trim a prompt to a budget, keeping its head and its tail.
 *
 * The tail is the operative rules; the head is the task. The middle is the
 * first thing to go, because it is the only part that is pure context.
 *
 * When the prompt already fits, it is returned UNCHANGED -- byte for byte.
 */
export function limitPromptKeepingTail(
  value: string,
  max: number,
  tailChars: number = DEFAULT_TAIL_CHARS,
): string {
  if (value.length <= max) return value

  // A tail budget larger than the whole prompt would eat the head.
  const tail =
    Math.max(
      0,
      Math.min(tailChars, max - 200),
    )

  const marker = `\n[... ${
    value.length - max
  } characters trimmed from the middle ...]\n`

  const headChars =
    max -
    tail -
    marker.length

  if (headChars <= 0) {
    // The budget is too small to hold both ends. Keep the tail, because the
    // rules are the operative part.
    return marker + value.slice(-tail)
  }

  return (
    value.slice(0, headChars) +
    marker +
    value.slice(-tail)
  )
}

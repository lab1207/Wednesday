/**
 * The reason a run failed, in the operator's words.
 *
 * WHY (operator report, 2026-11-07, run
 * harness-31b3c35a-f3d5-41b2-987d-fc537d13f287):
 * the executor reported `diagnostics: stderr` for EVERY outcome. On a run
 * where the coder succeeded, the host's stderr IS the success transcript --
 * `ACP_TURN_OK stopReason=end_turn`, the file the coder wrote, its own
 * verification summary. So when the Factory's verification command then
 * failed, the receipt showed that success transcript under the word FAILED,
 * and the repair loop was handed the same transcript as "what went wrong".
 *
 * The coder read that, saw its own successful report quoted back at it, and
 * answered "no changes were needed" -- four times, until the repair ceiling
 * was spent. The operator was told the model stopped mid-answer; the truth
 * was that the Factory could not explain its own failure.
 *
 * The failure reason is not in stderr. It is in the verification results and
 * the acceptance checks, and it must come FIRST: the repair prompt is built
 * from it, and a repair prompt that quotes a success is a repair prompt that
 * repairs nothing.
 */

import type {
  AcceptanceCheckResult,
  EngineeringTestResult,
} from '../contracts/engineering-result'

/** The inputs the failure reason is derived from. */
export interface FailureReasonInput {
  setup: EngineeringTestResult[]
  tests: EngineeringTestResult[]
  acceptanceChecks: AcceptanceCheckResult[]
}

/** How much of one command's output to quote. */
const OUTPUT_LIMIT = 1200

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}... [truncated ${text.length - OUTPUT_LIMIT} characters]`
}

function describeCommand(
  result: EngineeringTestResult,
): string {
  const output =
    result.output ??
    ''

  return [
    `- command: ${result.command}`,
    output.trim().length > 0
      ? `  output: ${clip(output.trim())}`
      : '  output: (the command failed and printed nothing)',
  ].join('\n')
}

/**
 * Why the run failed, or null when nothing failed.
 *
 * Pure and exported so the ONE claim that matters -- that a failed run names
 * the check that failed instead of quoting the host's success log -- can be
 * asserted without a live run.
 */
export function failureReason(
  input: FailureReasonInput,
): string | null {
  const failedSetup =
    input.setup.filter(
      result => !result.passed,
    )

  const failedTests =
    input.tests.filter(
      result => !result.passed,
    )

  const failedAcceptance =
    input.acceptanceChecks.filter(
      check => !check.passed,
    )

  const total =
    failedSetup.length +
    failedTests.length +
    failedAcceptance.length

  if (total === 0) return null

  const lines: string[] = [
    `The Factory's own checks failed (${total} check${total === 1 ? '' : 's'}). The work itself may be correct -- fix the failing check or the code it checks.`,
  ]

  if (failedSetup.length > 0) {
    lines.push(
      '',
      'SETUP COMMANDS THAT FAILED:',
      ...failedSetup.map(describeCommand),
    )
  }

  if (failedTests.length > 0) {
    lines.push(
      '',
      'VERIFICATION COMMANDS THAT FAILED:',
      ...failedTests.map(describeCommand),
    )
  }

  if (failedAcceptance.length > 0) {
    lines.push(
      '',
      'ACCEPTANCE CRITERIA THAT FAILED:',
      ...failedAcceptance.map(
        check =>
          `- ${check.criterion}${
            check.details && check.details.trim().length > 0
              ? `\n  details: ${clip(check.details.trim())}`
              : ''
          }`,
      ),
    )
  }

  return lines.join('\n')
}

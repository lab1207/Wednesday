/**
 * The failure reason must name the check that failed (2026-11-07).
 *
 * The executor reported `diagnostics: stderr` for every outcome, so a run
 * whose verification failed showed the HOST'S SUCCESS TRANSCRIPT under the
 * word FAILED -- and the repair loop was handed that same transcript as
 * "what went wrong". The operator's coder read its own successful report
 * quoted back at it and answered "no changes were needed" four times.
 *
 * These assertions are the regression: the reason comes from the checks, and
 * the host log is only context behind it.
 */

import assert from 'node:assert/strict'
import { failureReason } from './failure-diagnostics'

function main(): void {
  // 1. A failed verification command is named, with its output.
  const reason =
    failureReason(
      {
        setup: [],
        tests: [
          {
            command:
              'node -e "check index.html"',
            passed: false,
            output:
              'missing <h1>\n',
          },
        ],
        acceptanceChecks: [],
      },
    )

  assert.ok(
    reason !== null,
    'a failed check must produce a reason',
  )
  assert.match(
    reason,
    /own checks failed/i,
    `the reason must say the checks failed, got: ${reason}`,
  )
  assert.match(
    reason,
    /node -e "check index\.html"/,
    `the reason must name the command, got: ${reason}`,
  )
  assert.match(
    reason,
    /missing <h1>/,
    `the reason must quote the output, got: ${reason}`,
  )

  // 2. A failed acceptance criterion is named.
  const acceptance =
    failureReason(
      {
        setup: [],
        tests: [],
        acceptanceChecks: [
          {
            criterion:
              'index.html exists in the workspace root',
            passed: false,
            details:
              'file not found',
          },
        ],
      },
    )

  assert.ok(
    acceptance !== null,
    'a failed criterion must produce a reason',
  )
  assert.match(
    acceptance,
    /index\.html exists in the workspace root/,
    `the reason must name the criterion, got: ${acceptance}`,
  )
  assert.match(
    acceptance,
    /file not found/,
    `the reason must quote the details, got: ${acceptance}`,
  )

  // 3. A failed SETUP command is named too (a setup failure short-circuits).
  const setup =
    failureReason(
      {
        setup: [
          {
            command: 'npm install',
            passed: false,
            output:
              'E404 package not found',
          },
        ],
        tests: [],
        acceptanceChecks: [],
      },
    )

  assert.ok(
    setup !== null,
    'a failed setup must produce a reason',
  )
  assert.match(
    setup,
    /SETUP COMMANDS THAT FAILED/,
    `the reason must label setup failures, got: ${setup}`,
  )

  // 4. Nothing failed -> no reason. A reason that always exists is noise.
  assert.equal(
    failureReason(
      {
        setup: [],
        tests: [],
        acceptanceChecks: [],
      },
    ),
    null,
    'a clean run must have no failure reason',
  )

  assert.equal(
    failureReason(
      {
        setup: [
          {
            command: 'npm install',
            passed: true,
          },
        ],
        tests: [
          {
            command: 'npm test',
            passed: true,
          },
        ],
        acceptanceChecks: [
          {
            criterion: 'a',
            passed: true,
          },
        ],
      },
    ),
    null,
    'passing checks must not produce a reason',
  )

  console.log('failure-diagnostics: PASS')
}

main()

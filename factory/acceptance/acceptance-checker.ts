import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcceptancePlan } from '../contracts/engineering-task'
import type { AcceptanceCheckResult } from '../contracts/engineering-result'

export class AcceptanceChecker {
  async check(
    workspace: string,
    acceptance: AcceptancePlan | undefined,
    verificationPassed: boolean,
  ): Promise<AcceptanceCheckResult[]> {
    if (acceptance === undefined) {
      return []
    }

    const results: AcceptanceCheckResult[] = []

    for (const file of acceptance.requiredFiles) {
      try {
        await access(join(workspace, file))

        results.push({
          criterion: `${file} exists`,
          passed: true,
        })
      } catch {
        results.push({
          criterion: `${file} exists`,
          passed: false,
          details: `Required file was not found: ${file}`,
        })
      }
    }

    results.push({
      criterion: 'verification passes',
      passed: verificationPassed,
      details: verificationPassed
        ? 'All verification commands passed.'
        : 'One or more verification commands failed.',
    })

    return results
  }
}
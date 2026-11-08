import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { parseNodeEvalCommand, runNodeEval } from './node-eval'

const execAsync =
  promisify(exec)

export interface VerificationCommandResult {
  command: string
  passed: boolean
  output: string
}

export interface VerificationResult {
  passed: boolean
  setup: VerificationCommandResult[]
  tests: VerificationCommandResult[]
}

export class VerificationEngine {
  async verify(
    workspace: string,
    setupCommands: string[],
    testCommands: string[],
  ): Promise<VerificationResult> {
    const setup:
      VerificationCommandResult[] =
      []

    for (
      const command of setupCommands
    ) {
      const result =
        await this.run(
          workspace,
          command,
        )

      setup.push(
        result,
      )

      if (
        !result.passed
      ) {
        return {
          passed: false,
          setup,
          tests: [],
        }
      }
    }

    const tests:
      VerificationCommandResult[] =
      []

    for (
      const command of testCommands
    ) {
      const result =
        await this.run(
          workspace,
          command,
        )

      tests.push(
        result,
      )

      if (
        !result.passed
      ) {
        return {
          passed: false,
          setup,
          tests,
        }
      }
    }

    return {
      passed: true,
      setup,
      tests,
    }
  }

  private async run(
    workspace: string,
    command: string,
  ): Promise<VerificationCommandResult> {
    // A `node -e "<script>"` command runs WITHOUT a shell (2026-11-07).
    //
    // The operator's page build was rejected by the Factory's OWN gate: the
    // script contains a nested double quote, and `cmd.exe` does not honour
    // backslash escapes, so the command was mangled into
    // "The network path was not found." and exit code 1. The same script in a
    // file passed. Spawning node directly passes the script as one argv
    // element, so no shell can rewrite it on any platform. See node-eval.ts.
    const nodeEval =
      parseNodeEvalCommand(
        command,
      )

    if (
      nodeEval !== null
    ) {
      const outcome =
        await runNodeEval(
          nodeEval.script,
          { cwd: workspace },
        )

      return {
        command,
        passed:
          outcome.passed,
        output:
          outcome.output ||
          `Command failed with exit code ${String(
            outcome.code ??
              'unknown',
          )}.`,
      }
    }

    try {
      const {
        stdout,
        stderr,
      } =
        await execAsync(
          command,
          {
            cwd:
              workspace,

            windowsHide:
              true,

            maxBuffer:
              10 * 1024 * 1024,
          },
        )

      return {
        command,
        passed: true,
        output:
          `${stdout}${stderr}`.trim(),
      }
    } catch (
      error
    ) {
      const result =
        error as {
          stdout?: string
          stderr?: string
          message?: string
          code?: unknown
        }

      const output =
        `${result.stdout ?? ''}${
          result.stderr ??
          result.message ??
          ''
        }`.trim()

      return {
        command,
        passed: false,
        output:
          output ||
          `Command failed with exit code ${String(
            result.code ??
              'unknown',
          )}.`,
      }
    }
  }
}
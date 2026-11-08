import { spawn } from 'node:child_process'

/**
 * Running `node -e "<script>"` WITHOUT a shell.
 *
 * WHY (operator report, 2026-11-07, run
 * harness-31b3c35a-f3d5-41b2-987d-fc537d13f287):
 * the operator asked for "build me website" and the run FAILED even though the
 * coder wrote a correct 7,206-byte page. The receipt blamed the model. The
 * event log proved otherwise: the coder finished with `ACP_TURN_OK
 * stopReason=end_turn` and the worker exited 0. The failure was the Factory's
 * OWN gate command:
 *
 *     node -e "const fs=require('fs');...name=[\"']viewport/i.test(s)..."
 *
 * The factory escapes a double quote as `\"`, which is correct for `sh` and
 * WRONG for `cmd.exe`: on Windows a backslash is not an escape character, so
 * the quote ends the quoted region early and cmd hands the rest of the script
 * to the shell as if it were a command. The gate died with
 *
 *     The network path was not found.
 *
 * and exit code 1. The identical check, written to a FILE and run as
 * `node check.cjs`, passed. So a correct deliverable was rejected by a
 * verification command that could never run on Windows -- and because the
 * executor reported the HOST's stderr as the failure reason, the operator was
 * shown the successful transcript under the word FAILED.
 *
 * The fix is to stop routing these through a shell at all. `node -e <script>`
 * takes the script as ONE argv element, so spawning node directly (shell:
 * false) passes it through byte for byte: no quoting rules, no cmd.exe, no
 * PowerShell, identical behaviour on every platform. It is also more faithful
 * than the shell was: `node -e` resolves `__dirname` to `.` and reads relative
 * paths against the cwd, exactly as the script was written to behave.
 *
 * The parser is deliberately conservative. It recognises ONLY a leading node
 * invocation with `-e`/`--eval` and a single quoted script. Anything else --
 * `npm test`, `pytest`, a pipeline, a redirect -- returns null and keeps the
 * existing shell path untouched.
 */

/** A recognised `node -e "<script>"` command. */
export interface NodeEvalCommand {
  /** The script exactly as node should receive it. */
  script: string
  /** The argv node is started with (without the executable). */
  args: string[]
}

const NODE_EVAL_HEAD =
  /^\s*(?:node(?:\.exe)?|["'][^"']*[\\/]node(?:\.exe)?["'])\s+(?:-e|--eval)\s+/i

/**
 * Read a double-quoted script body.
 *
 * A `\"` pair is a literal quote (that is how the factory encodes one); the
 * first UNESCAPED quote closes the body. Returns null when the body never
 * closes -- an unterminated quote is not a script, it is a broken command, and
 * the shell is better at reporting that than this parser is.
 */
function readDoubleQuoted(text: string): string | null {
  let raw = ''
  for (let index = 1; index < text.length; index++) {
    const character = text[index]
    if (character === '\\' && text[index + 1] === '"') {
      raw += '\\"'
      index++
      continue
    }
    if (character === '"') return raw
    raw += character
  }
  return null
}

/**
 * Read a single-quoted script body.
 *
 * `sh` treats single quotes as literal, so the body runs until the next
 * single quote. There is no escape inside a single-quoted shell word.
 */
function readSingleQuoted(text: string): string | null {
  const end = text.indexOf("'", 1)
  if (end === -1) return null
  return text.slice(1, end)
}

/**
 * The script a `node -e` command carries, or null when the command is not one.
 *
 * Pure and exported so the ONE claim that matters -- that a command with a
 * nested double quote survives intact -- can be asserted without spawning
 * anything.
 */
export function parseNodeEvalCommand(
  command: string,
): NodeEvalCommand | null {
  const head = NODE_EVAL_HEAD.exec(command)
  if (head === null) return null

  const remainder = command.slice(head[0].length)
  if (remainder.length === 0) return null

  let script: string | null = null

  if (remainder.startsWith('"')) {
    script = readDoubleQuoted(remainder)
  } else if (remainder.startsWith("'")) {
    script = readSingleQuoted(remainder)
  } else if (!/\s/.test(remainder)) {
    // `node -e process.exit(0)` -- a bare script with no spaces.
    script = remainder
  }

  if (script === null) return null

  // Undo the factory's own encoding ONLY for the quote it encodes. Every
  // other backslash is the script's own (regex escapes such as `\s`, `\b` and
  // `\.` must survive untouched), so the inverse is deliberately narrow.
  const decoded = script.replace(/\\"/g, '"')

  return {
    script: decoded,
    args: ['-e', decoded],
  }
}

/** The outcome of a script that was run without a shell. */
export interface NodeEvalOutcome {
  passed: boolean
  output: string
  code: number | null
}

/** The cap on captured output, matching the shell path's budget. */
export const NODE_EVAL_MAX_BUFFER = 10 * 1024 * 1024

/**
 * Run a script with node, with no shell in between.
 *
 * Uses `process.execPath`, so it works even when `node` is not on PATH, and
 * `shell: false`, so no cmd.exe quoting rules can touch the script.
 */
export function runNodeEval(
  script: string,
  options: { cwd: string },
): Promise<NodeEvalOutcome> {
  return new Promise<NodeEvalOutcome>(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const settle = (outcome: NodeEvalOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    let child: import('node:child_process').ChildProcess
    try {
      child = spawnNode(
        process.execPath,
        ['-e', script],
        options.cwd,
      )
    } catch (error) {
      settle({
        passed: false,
        output:
          error instanceof Error
            ? error.message
            : String(error),
        code: null,
      })
      return
    }

    child.stdout?.on('data', (chunk: unknown) => {
      if (stdout.length < NODE_EVAL_MAX_BUFFER) {
        stdout += String(chunk)
      }
    })

    child.stderr?.on('data', (chunk: unknown) => {
      if (stderr.length < NODE_EVAL_MAX_BUFFER) {
        stderr += String(chunk)
      }
    })

    child.on('error', (error: Error) => {
      settle({
        passed: false,
        output: error.message,
        code: null,
      })
    })

    child.on('close', (code: number | null) => {
      settle({
        passed: code === 0,
        output: `${stdout}${stderr}`.trim(),
        code,
      })
    })
  })
}

// Imported at the bottom so the module's public surface reads top-down.
function spawnNode(
  executable: string,
  args: string[],
  cwd: string,
): import('node:child_process').ChildProcess {
  return spawn(executable, args, {
    cwd,
    shell: false,
    windowsHide: true,
    env: process.env,
  })
}

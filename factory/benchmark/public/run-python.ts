/**
 * Shared python test-runner for public-bench adapters (HumanEval now;
 * LiveCodeBench in step 3). Runs grading code from a throwaway temp file
 * and reports exit status plus a bounded output tail as grader evidence.
 *
 * The python binary is env-overridable (`PUBLIC_BENCH_PYTHON`) and
 * defaults to `python` on Windows, `python3` elsewhere.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function pythonBin(): string {
  return (
    process.env.PUBLIC_BENCH_PYTHON?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3')
  )
}

export interface PythonRunResult {
  exitCode: number
  outputTail: string
}

/** Run `python <scriptPath>` with a timeout; resolve with bounded output tail. */
export function runPythonScript(
  scriptPath: string,
  timeoutMs = 10_000,
  cwd?: string,
): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [scriptPath], {
      windowsHide: true,
      timeout: timeoutMs,
      ...(cwd === undefined ? {} : { cwd }),
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const finish = (exitCode: number) => {
      resolve({ exitCode, outputTail: out.slice(-800) })
    }
    child.on('error', (err: Error) => {
      out += String(err)
      finish(-1)
    })
    child.on('close', (code: number | null) => finish(code ?? -1))
  })
}

/** Materialize grading code in a temp dir, run it, always clean up. */
export async function runPythonCode(
  code: string,
  timeoutMs = 10_000,
): Promise<PythonRunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'publicbench-'))
  const scriptPath = join(dir, 'grade.py')
  try {
    await writeFile(scriptPath, code, 'utf8')
    return await runPythonScript(scriptPath, timeoutMs)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

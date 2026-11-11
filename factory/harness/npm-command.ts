/**
 * Running npm WITHOUT a shell, and VISIBLY.
 *
 * WHY THIS MODULE EXISTS (operator report, 2026-11-09):
 *
 *   "i run this /update command then it ask you are sure install update yes
 *    or no i select yes then, this i see 'Wednesday 0.2.0-beta.4 ->
 *    0.2.0-beta.5 is aviable (npm channel "beta") ... update installed failed:
 *    npm exited with signal - manual: npm i -g ...'"
 *
 * The failure was NOT a network problem and NOT a registry problem. It was
 * this line, in the old updater:
 *
 *     spawnSync('npm', ['install', '-g', spec, ...], { shell: false })
 *
 * On Windows `npm` is `npm.cmd` -- a BATCH file. Node cannot execute a batch
 * file without a shell (CVE-2024-27980 hardened exactly this), so the spawn
 * fails with ENOENT, `status` is null, and the old updater rendered
 * `npm exited with ${status ?? 'signal'}` -- the literal word "signal", with
 * the real reason thrown away. `/update` has therefore NEVER worked on
 * Windows, and the message it printed named a signal that did not exist.
 *
 * PROVED, not assumed (2026-11-09, on the operator's own machine):
 *     spawnSync('npm', ['--version'], { shell: false })
 *       -> status null, signal null, error ENOENT
 *     spawnSync(process.execPath, [<npm-cli.js>, '--version'], { shell: false })
 *       -> status 0, stdout "11.13.0"
 *
 * WHY NOT `shell: true`: the whole point of spawning an ARG ARRAY is that no
 * version string and no package name can ever be interpreted by a shell. The
 * version is shape-validated before it reaches this module, and it must stay
 * that way. The fix is to run npm the way Node can run it -- `node
 * <npm-cli.js>` -- not to hand it to cmd.exe.
 *
 * WHY "VISIBLY" IS IN THE NAME: the same operator report said the install
 * "shows nothing" -- no line saying what is happening, no line saying what
 * comes next. npm's own output is captured here rather than shown, so a run
 * that takes a minute is a minute of silence. `runNpm` therefore takes an
 * `onOutput` hook: every line npm prints is forwarded, so the operator sees
 * the same progress a manual `npm i -g` would show.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** How npm is to be invoked: an executable plus the arguments BEFORE ours. */
export interface NpmInvocation {
  /** The executable to spawn. */
  command: string
  /** Arguments that must come before npm's own arguments. */
  prefix: string[]
  /** A one-line description for the operator ("npm 11.13.0"). */
  label: string
}

export interface NpmFailure {
  /** The OS error code, when the process never started (ENOENT, EACCES...). */
  code?: string
  /** The OS error message, when the process never started. */
  message?: string
  /** The signal that killed the process, when one did. */
  signal?: string
}

export interface NpmRunResult {
  /** The exit code, or null when the process never produced one. */
  status: number | null
  /** The signal that ended the process, or null. */
  signal: string | null
  /** Why the process could not be started, when that is what happened. */
  failure?: NpmFailure
  stdout: string
  stderr: string
  /** True when npm ran and exited 0. */
  ok: boolean
}

/** The npm CLI entry point on this host, or null. */
export function findNpmCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  pathEnv: string = env.PATH ?? '',
): string | null {
  const candidates: string[] = []

  // npm sets this when it runs us (npm exec, npm run, npm test).
  if (env.npm_execpath && env.npm_execpath.endsWith('npm-cli.js')) {
    candidates.push(env.npm_execpath)
  }

  // A normal node install keeps npm beside node.
  candidates.push(join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(join(dirname(execPath), '..', 'share', 'node_modules', 'npm', 'bin', 'npm-cli.js'))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Whatever `npm` resolves to on PATH: on POSIX that is a symlink to the CLI
  // entry, and on Windows it is npm.cmd sitting NEXT TO the real npm-cli.js.
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const probe = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(probe)) return probe
    for (const shim of ['npm', 'npm.cmd', 'npm.exe']) {
      const shimPath = join(dir, shim)
      if (!existsSync(shimPath)) continue
      let real = shimPath
      try {
        real = realpathSync(shimPath)
      } catch {
        // A shim we cannot resolve is still worth following by name.
      }
      if (real.endsWith('npm-cli.js')) return real
      const near = join(dirname(real), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(near)) return near
    }
  }

  // On POSIX `npm` IS a real executable, so the bare name is safe there.
  if (platform !== 'win32') return null

  return null
}

/**
 * How to run npm on this host, with NO shell.
 *
 * WHY THE PLATFORM SPLIT: on POSIX, `npm` is an executable script and
 * spawning it directly is correct and shell-free. On Windows, `npm` is
 * `npm.cmd`, and a batch file cannot be executed without cmd.exe -- so the
 * only shell-free way to run npm is `node <npm-cli.js>`. Running `npm.cmd`
 * through a shell would put the version string back in reach of a shell
 * parser, which is exactly what the arg-array rule exists to prevent.
 */
export function resolveNpm(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): NpmInvocation | null {
  const cli = findNpmCli(env, platform, execPath)
  if (cli) {
    return {
      command: execPath,
      prefix: [cli],
      label: `node ${cli}`,
    }
  }
  if (platform !== 'win32') {
    return { command: 'npm', prefix: [], label: 'npm' }
  }
  return null
}

/** The command line as the operator should type it (for display only). */
export function npmCommandLine(args: string[], invocation: NpmInvocation | null = resolveNpm()): string {
  if (!invocation) return `npm ${args.join(' ')}`
  return [invocation.label, ...args].join(' ')
}

/** Turn a spawn result into the reason a human can act on. */
export function describeNpmFailure(result: NpmRunResult): string {
  if (result.failure) {
    const code = result.failure.code ? `${result.failure.code}: ` : ''
    const signal = result.failure.signal ? ` (signal ${result.failure.signal})` : ''
    return `npm could not be started (${code}${result.failure.message ?? 'unknown error'}${signal})`
  }
  if (result.signal) {
    return `npm was killed by ${result.signal}`
  }
  const output = (result.stderr || result.stdout).trim()
  if (output) return output.slice(0, 400)
  return `npm exited with code ${result.status ?? 'unknown'} and printed nothing`
}

/**
 * Run npm, forwarding its output line by line.
 *
 * WHY ASYNC: the old updater used `spawnSync`, which BLOCKS the event loop.
 * The operator's terminal was frozen for the whole install with no output --
 * "nothing show means what install what now". An async spawn lets the UI
 * keep painting and lets every npm line reach the operator as it happens.
 *
 * `onOutput` receives each line npm prints (stdout and stderr interleaved,
 * in the order they arrived). It is optional: a caller that wants silence
 * simply omits it.
 */
export async function runNpm(
  args: string[],
  options: {
    invocation?: NpmInvocation | null
    onOutput?: (line: string) => void
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
    cwd?: string
  } = {},
): Promise<NpmRunResult> {
  const invocation = options.invocation === undefined ? resolveNpm() : options.invocation
  if (!invocation) {
    return {
      status: null,
      signal: null,
      failure: {
        code: 'ENOTFOUND',
        message:
          'npm could not be located on this machine (expected npm-cli.js beside node, or npm on PATH).',
      },
      stdout: '',
      stderr: '',
      ok: false,
    }
  }

  const timeoutMs = options.timeoutMs ?? 240_000
  const child = spawn(invocation.command, [...invocation.prefix, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let failure: NpmFailure | undefined

  const forward = (chunk: Buffer, into: 'out' | 'err'): void => {
    const text = chunk.toString('utf8')
    if (into === 'out') stdout += text
    else stderr += text
    if (!options.onOutput) return
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() !== '') options.onOutput(line)
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => forward(chunk, 'out'))
  child.stderr?.on('data', (chunk: Buffer) => forward(chunk, 'err'))

  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure = { code: error.code, message: error.message }
      reject(error)
    })
  })

  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('close', (status, signal) => resolve({ status, signal }))
  })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    timer = setTimeout(() => {
      child.kill()
      resolve({ status: null, signal: 'SIGTERM' })
    }, timeoutMs)
  })

  let outcome: { status: number | null; signal: NodeJS.Signals | null }
  try {
    outcome = await Promise.race([exited, timeout, spawnFailure])
  } catch (error: unknown) {
    if (timer) clearTimeout(timer)
    return {
      status: null,
      signal: null,
      failure: failure ?? {
        message: error instanceof Error ? error.message : String(error),
      },
      stdout,
      stderr,
      ok: false,
    }
  }
  if (timer) clearTimeout(timer)

  const signal = outcome.signal ?? null
  return {
    status: outcome.status,
    signal,
    failure,
    stdout,
    stderr,
    ok: outcome.status === 0,
  }
}

/**
 * The same resolution, but SYNCHRONOUS, for the one place that must block
 * (the CLI uninstall, which is already a blocking command).
 */
export function runNpmSync(
  args: string[],
  options: { invocation?: NpmInvocation | null; timeoutMs?: number; cwd?: string } = {},
): NpmRunResult {
  const invocation = options.invocation === undefined ? resolveNpm() : options.invocation
  if (!invocation) {
    return {
      status: null,
      signal: null,
      failure: {
        code: 'ENOTFOUND',
        message:
          'npm could not be located on this machine (expected npm-cli.js beside node, or npm on PATH).',
      },
      stdout: '',
      stderr: '',
      ok: false,
    }
  }
  const done = spawnSync(invocation.command, [...invocation.prefix, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    windowsHide: true,
    shell: false,
  })
  const failure: NpmFailure | undefined = done.error
    ? { code: (done.error as NodeJS.ErrnoException).code, message: done.error.message }
    : undefined
  return {
    status: done.status,
    signal: done.signal ?? null,
    failure,
    stdout: done.stdout ?? '',
    stderr: done.stderr ?? '',
    ok: done.status === 0,
  }
}

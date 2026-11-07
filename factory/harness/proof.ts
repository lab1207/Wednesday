/**
 * "Prove it" — one tiny REAL task through the same worker a build uses.
 *
 * Why this exists (2026-11-05): onboarding ended at "saved" and the first real
 * request was also the first time the route was exercised. When the route was
 * broken, the operator paid for a full failed run and the receipt blamed the
 * wrong thing. This proof is deliberately the SMALLEST real turn:
 *
 *   model -> ACP worker -> write proof.txt -> read it back -> verify on disk
 *
 * It runs the worker seam directly (not the whole crew), so it costs one short
 * model turn and finishes in seconds. It is the exact path that failed with
 * `no credential for provider route "local"`, so a pass proves the route, the
 * worker boot, the tool call and the file write all work.
 *
 * The proof is diagnostic, never a gate: a failure is named and the operator
 * can still type a request or run /connect.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { HOST, STATE_HOME } from '../paths'
import { workerProvider } from '../dsh-worker/provider-route'
import {
  KILL_GRACE_MS,
  groupSpawnOptions,
  killProcessTree,
} from '../dsh-worker/process-tree'
import type { ViewLine } from './views'

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/** The token the proof file must contain, exactly. */
export const PROOF_TOKEN = 'WEDNESDAY_PROOF_OK'
export const PROOF_FILE = 'proof.txt'

/**
 * The worker prints live activity on stdout behind this marker. The answer is
 * everything that is NOT marked (the executor strips the same way).
 */
export const PROOF_ACTIVITY_MARK = '@@WEDNESDAY_ACTIVITY@@'

export const PROOF_PROMPT =
  `Use your file tools: create ${PROOF_FILE} in the current workspace containing exactly ${PROOF_TOKEN} ` +
  `(no extra text), then read it back and reply with exactly: ${PROOF_TOKEN}`

export interface ProofUi {
  note(text: string): void
  error(text: string): void
  progress?(text: string): void
  block?(lines: ViewLine[]): void
}

export interface ProofRoute {
  provider: string
  model: string
  /** Set when the route cannot possibly work; the proof must not spawn. */
  problem?: string
}

export interface ProofResult {
  ok: boolean
  /** One sentence an operator can act on. */
  detail: string
  seconds: number
  provider: string
  model: string
  workspace: string
  answer?: string
}

export interface ProofChild {
  stdout: Readable
  stderr: Readable
  pid?: number | undefined
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export type ProofSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide?: boolean
    detached?: boolean
  },
) => ProofChild

export interface ProofOptions {
  env?: NodeJS.ProcessEnv
  stateDir?: string
  /** Wall-clock cap for the one turn. Default 90s; override for tests. */
  timeoutMs?: number
  /** Injected spawn so the orchestration is testable without a model. */
  spawnImpl?: ProofSpawn
}

/**
 * The route the proof will use, from the same env the run uses.
 *
 * `FACTORY_LLM_PROVIDER` is the route /connect and /model write, and it is
 * what the model router defaults to for a bare model id. `DSH_LLM_PROVIDER` is
 * a per-run override; it is only a fallback here because a profile can keep a
 * stale value after switching routes. `workerProvider()` supplies the final
 * fallback, so a profile that only has a local base URL still resolves local.
 */
export function proofRoute(env: NodeJS.ProcessEnv = process.env): ProofRoute {
  const selected = (env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase()
  const explicit = (env.DSH_LLM_PROVIDER ?? '').trim().toLowerCase()
  const provider = selected || explicit || workerProvider(env)
  const model = (env.DSH_LLM_MODEL ?? env.LOCAL_LLM_MODEL ?? '').trim()
  if (!model) {
    return { provider, model, problem: 'no model selected — run /model or /connect first' }
  }
  if (provider === 'local' && !(env.LOCAL_LLM_BASE_URL ?? '').trim()) {
    return { provider, model, problem: 'local route has no base URL — run /connect' }
  }
  if (provider === 'openrouter' && !(env.OPENROUTER_API_KEY ?? '').trim()) {
    return { provider, model, problem: 'OPENROUTER_API_KEY is not set — run /connect' }
  }
  if (provider === 'nvidia' && !(env.NVIDIA_API_KEY ?? '').trim()) {
    return { provider, model, problem: 'NVIDIA_API_KEY is not set — run /connect' }
  }
  return { provider, model }
}

/**
 * A stable workspace for the proof (`~/.wednesday/state/proof`). Reusing one
 * path means the operator always knows where the last artifact is, and a rerun
 * cannot leave a stale `proof.txt` behind and report a false PASS.
 */
export function proofWorkspace(stateDir = STATE_HOME): string {
  const dir = join(stateDir, 'proof')
  try {
    mkdirSync(stateDir, { recursive: true })
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    // A locked or read-only state dir must not break onboarding; a temp
    // workspace is still a real proof, and the receipt names where it landed.
    return mkdtempSync(join(tmpdir(), 'wednesday-proof-'))
  }
}

/** Read the artifact and decide the proof. Pure apart from the file read. */
export function proofVerdict(workspace: string): { ok: boolean; detail: string } {
  const path = join(workspace, PROOF_FILE)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return {
      ok: false,
      detail: `${PROOF_FILE} was not written — the model answered without using its file tools`,
    }
  }
  const value = content.trim()
  if (value === PROOF_TOKEN) {
    return { ok: true, detail: `wrote ${PROOF_FILE} and read it back` }
  }
  return {
    ok: false,
    detail: `${PROOF_FILE} says ${JSON.stringify(value.slice(0, 80))} — expected ${PROOF_TOKEN}`,
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? ''
}

/**
 * The last line that names a real failure. The host's stderr is already
 * redacted, but it is verbose; the operator gets the cause, not the boot log.
 */
function diagnostic(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map(line => line.replace(/^\[factory-host\]\s*/, '').trim())
    .filter(line => line.length > 0)
  const named = lines.filter(line =>
    /no credential|not set|failed|error|ECONNREFUSED|ENOTFOUND|timed? ?out|404|401|403|5\d\d/i.test(line),
  )
  return (named.at(-1) ?? lines.at(-1) ?? '').slice(0, 240)
}

function timeoutFrom(env: NodeJS.ProcessEnv): number {
  const configured = Number((env.WEDNESDAY_PROOF_TIMEOUT_MS ?? '').trim())
  if (Number.isFinite(configured) && configured >= 1000) return Math.min(configured, 10 * 60_000)
  return 90_000
}

/**
 * Run the proof. Returns a receipt instead of throwing: onboarding must always
 * finish, even when the route does not.
 */
export async function runProof(ui: ProofUi, opts: ProofOptions = {}): Promise<ProofResult> {
  const env = opts.env ?? process.env
  const route = proofRoute(env)
  const workspace = proofWorkspace(opts.stateDir)
  const startedAt = Date.now()
  const fail = (detail: string): ProofResult => ({
    ok: false,
    detail,
    seconds: (Date.now() - startedAt) / 1000,
    provider: route.provider,
    model: route.model,
    workspace,
  })

  if (route.problem) return fail(route.problem)

  const timeoutMs = opts.timeoutMs ?? timeoutFrom(env)
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DSH_FACTORY_TASK_PROMPT: PROOF_PROMPT,
    DSH_FACTORY_TASK_WORKSPACE: workspace,
    // The host reads this first; setting it explicitly is the fix for B195
    // (a leftover LOCAL_LLM_BASE_URL must never override a hosted route).
    DSH_LLM_PROVIDER: route.provider,
    DSH_LLM_MODEL: route.model,
  }

  let child: ProofChild
  try {
    const spawnImpl = opts.spawnImpl ?? ((command, args, options) =>
      spawn(command, args, options) as unknown as ProofChild)
    child = spawnImpl(process.execPath, [TSX_CLI, HOST], {
      cwd: workspace,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...groupSpawnOptions(),
    })
  } catch (error) {
    return fail(`could not start the worker: ${error instanceof Error ? error.message : String(error)}`)
  }

  let answer = ''
  let stderr = ''
  let pending = ''
  const consume = (line: string): void => {
    if (line.startsWith(PROOF_ACTIVITY_MARK)) {
      try {
        const activity = JSON.parse(line.slice(PROOF_ACTIVITY_MARK.length)) as {
          kind?: string
          tool?: string
          detail?: string
        }
        if (activity.kind === 'tool' && activity.tool) {
          ui.progress?.(`proof: ${activity.tool}${activity.detail ? ` ${activity.detail}` : ''}`)
        }
      } catch {
        // A partial activity line is not the answer; the next one will do.
      }
      return
    }
    answer += `${line}\n`
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string | Buffer) => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) consume(line)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string | Buffer) => {
    stderr += String(chunk)
  })

  let timedOut = false
  let settled = false
  let settleNow: (value: { code: number | null; error?: Error }) => void = () => {}
  let hardTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  const clearPending = (): void => {
    if (hardTimer) clearTimeout(hardTimer)
    if (graceTimer) clearTimeout(graceTimer)
  }
  const timer = setTimeout(() => {
    timedOut = true
    // THE WHOLE TREE, NOT JUST THE HOST (2026-11-07).
    //
    // The host spawns the DSH worker as a child, and the worker inherits the
    // host's stderr. Killing the host alone left the worker running and
    // holding the pipe, so `close` never fired and the proof — and the whole
    // app with it — hung forever (operator report: "/proof hangs all
    // wednesday"). The tree kill reaches the worker.
    killProcessTree(child)
    // The kill is BEST EFFORT. If the tree is already gone, or the OS
    // refuses the kill, no `exit` event may ever arrive -- and a receipt
    // that waits for one IS the freeze the operator reported. So the
    // deadline settles the turn itself, shortly after the kill.
    //
    // These timers are NOT unref'd: an unref'd deadline does not keep the
    // loop alive, so in a quiet process the promise would never settle and
    // Node would exit mid-await instead of returning the receipt.
    hardTimer = setTimeout(() => {
      settleNow({ code: null })
    }, KILL_GRACE_MS)
  }, timeoutMs)

  // The receipt MUST arrive, whatever the process tree does.
  //
  // `close` waits for the PIPES, and the pipes belong to the tree: a worker
  // that outlived its host keeps them open forever. So the process exit
  // settles the receipt too, after a short grace that lets the last line
  // land. The proof is a diagnostic — a receipt that says "the route did
  // not answer" is worth far more than a frozen app.
  const exit = await new Promise<{ code: number | null; error?: Error }>(resolve => {
    const settle = (value: { code: number | null; error?: Error }): void => {
      if (settled) return
      settled = true
      clearPending()
      resolve(value)
    }
    settleNow = settle
    child.once('error', error => {
      settle({ code: null, error })
    })
    child.once('close', code => {
      settle({ code })
    })
    child.once('exit', code => {
      if (settled) return
      graceTimer = setTimeout(() => {
        settle({ code })
      }, KILL_GRACE_MS)
    })
  })
  clearTimeout(timer)
  if (pending.length > 0) consume(pending)

  const verdict = proofVerdict(workspace)
  const seconds = (Date.now() - startedAt) / 1000
  const modelAnswer = firstLine(answer)
  if (timedOut) {
    return {
      ok: false,
      detail: `no answer within ${Math.round(timeoutMs / 1000)}s — the route may be slow or the tunnel dead`,
      seconds,
      provider: route.provider,
      model: route.model,
      workspace,
      answer: modelAnswer || undefined,
    }
  }
  if (exit.error) {
    return {
      ok: false,
      detail: `could not start the worker: ${exit.error.message}`,
      seconds,
      provider: route.provider,
      model: route.model,
      workspace,
    }
  }
  const cause = diagnostic(stderr)
  const exitNote = exit.code !== 0
    ? `worker exited ${exit.code}${cause ? ` — ${cause}` : ''}`
    : ''
  if (!verdict.ok) {
    return {
      ok: false,
      detail: cause ? `${verdict.detail}; ${cause}` : verdict.detail,
      seconds,
      provider: route.provider,
      model: route.model,
      workspace,
      answer: modelAnswer || undefined,
    }
  }
  return {
    ok: true,
    detail: exitNote ? `${verdict.detail} (${exitNote})` : verdict.detail,
    seconds,
    provider: route.provider,
    model: route.model,
    workspace,
    answer: modelAnswer || undefined,
  }
}

/** The receipt rows both onboarding and /proof render. */
export function proofLines(result: ProofResult): ViewLine[] {
  // One row in spirit: a 240-char provider diagnostic is a wall, not a card.
  const detail = result.detail.length > 160 ? `${result.detail.slice(0, 157)}…` : result.detail
  const rows: ViewLine[] = result.ok
    ? [{
      text: `proof PASS — ${result.provider}/${result.model} wrote ${PROOF_FILE} and read it back in ${result.seconds.toFixed(1)}s`,
      tone: 'green',
    }]
    : [{
      text: `proof FAIL — ${detail}`,
      tone: 'red',
    }]
  if (result.ok) {
    rows.push({ text: `artifact: ${join(result.workspace, PROOF_FILE)}`, tone: 'dim' })
    if (result.answer) rows.push({ text: `model: ${result.answer.slice(0, 160)}`, tone: 'dim' })
  } else {
    rows.push({ text: `route: ${result.provider}/${result.model || '(no model)'}`, tone: 'dim' })
    rows.push({ text: 'fix: /connect or /doctor — the proof uses the same route as a real build.', tone: 'yellow' })
  }
  return rows
}

/** Render the receipt on either surface: toned rows when the UI has them. */
export function renderProof(ui: ProofUi, result: ProofResult): void {
  const rows = proofLines(result)
  if (ui.block) ui.block(rows)
  else for (const row of rows) ui.note(row.text)
}

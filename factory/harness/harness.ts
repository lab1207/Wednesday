import { createClassicAsk } from './classic-ask'
import { connectCli, connectFlow } from './connect'
import { stdin, stdout } from 'node:process'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineeringTask, EngineeringResult } from '../contracts'
import { installFatalGuard, installInterrupt } from './interrupt'
import { analyzeRepositoryCached } from '../openhands/connector'
import { loadStore, runHermesTask, submitTask } from '../hermes/store'
import { loadCrews, activeCrew, applyCrew, crewMeterName, crewSeatSummary, setActiveCrew, updateCrew, type Crew } from './crew-store'
import { usageDiff, usageSnapshot } from '../model-router/usage'
import { PersistentFactoryEventBus } from '../events'
import type { AgentActivityKind } from '../events'
import { createRequire } from 'node:module'
import { EVENTS_PATH, STATE_HOME } from '../paths'
import { migrateLegacyState } from '../state-migration'
import { configBlockerIn, liveConfigBlocker, loadConfig, PROVIDER_PREFIXES, requireLiveConfig, safeError, validateModel, type ConfigBlocker } from './config'
import { resolveCrewModel, seatModelPin, splitProviderPin, crewSlotFor, type CrewRole } from '../model-router/crew-routing'
import { type ChatMessage, type ChatRoute, buildChatRequest, chatComplete, resolveChatRoute, seatFitsRoute } from '../model-router/chat-stream'
import { classifyIntent } from './intent'
import { inferModelCard } from '../model-router/model-cards'
import { channelOf, checkForUpdates, resolveUpdate } from './update-check'
import { shouldAutoRestart } from './updater'
import { redactSensitiveText } from '../security/redaction'
import { detectDefaults, hasProjectMarker, NONEMPTY_WORKSPACE_CHECK, packageHasTestScript, type AutoDefaults } from './defaults'
import {
  isFreshWorkspace,
  isPageRequest,
  PAGE_ENTRY,
  pageAcceptanceCriteria,
  pageBuildBrief,
  pageCheckCommand,
} from './page-brief'
import { readHealthHistory, recordHealthReport, runHealthChecks } from '../health'
import { banner, formatEvent, isTty, previewTitle, rule, stageHeader, statusLine, taskCard } from './tui'
import { BUSY_HINTS, COMPOSER_HINTS, Screen, activityMessage, bannerColumns, busyStatus, chatLiveRow, crewUpdate, eventMessage, foldTool, glyph, initialState, liveTail, runAdvisories, runSelect, selectMatching, selectSection, traceNote, wednesdayCompact, type EventDetail, type SelectOption, type StartupAdvisories, type ToolFold } from './screen'
import { renderHelp, type HelpGroup } from './help'
import { fileIndex } from './file-index'
import { expandPendingPastePlaceholders, framePasteExpansion } from './paste-framing'
import type { CommandSpec } from './completion'
import { PATCH_BUDGET, PATCH_BUDGETS, patchRows } from './patch-rows'
import { compactHistory } from './compact'
import { resolvePromptBudget } from '../model-router/prompt-budget'
import { DISPLAY_HINTS, isDisplayMode, loadDisplay, saveDisplay, type DisplayMode } from './display-store'
import { eventTrailLines, shortId, statusTone, streamLine, taskDetailLines, taskListLines, wrapText, type TaskRow, type ViewLine } from './views'
import type { MsgTone, ScreenMessage, ScreenState } from './screen'

/**
 * `/help` content as two column tuples, so the screen path can draw the help
 * PLATE (design board A3) and the classic path can still print plain text. The
 * classic string below is generated from these, so the two can never disagree
 * about which commands exist — a command advertised in the footer or the
 * palette but missing here is the bug the board flagged.
 */
export const HELP_COMMANDS: Array<[string, string]> = [
  ['<request>', 'run a task (no flags needed)'],
  ['/', 'command tab · type to filter'],
  ['/connect', 'provider · tunnel · local models · probe · save'],
  ['/create [name]', 'create a team in one pick (3 seats · one model)'],
  ['/agents', 'crew profile · seat per role'],
  ['/crew', 'list · select · edit · delete teams'],
  ['/model', 'every model from every connection — assign it a role'],
  ['/status', 'route · model · pool · shape'],
  ['/doctor', 'readiness check (read-only)'],
  ['/stats', 'token usage for this session'],
  ['/display', 'transcript density: quiet · normal · verbose'],
  ['/debug', 'live route · seats · paths'],
  ['/update', 'check npm; with your yes, install the pinned newer release'],
  ['/onboard', 'run the first-run setup again'],
  ['/proof', 'one tiny real task — proves the route a build uses'],
  ['/compact', 'summarise older turns to free context'],
  ['/clear', 'clear this session'],
  ['/new', 'start a fresh session'],
  ['/q', 'leave the harness'],
  ['/tasks', 'list persisted tasks'],
  ['/result <id>', 'inspect a stored task + result'],
  ['/events <id>', 'inspect persisted Factory events'],
  ['/run <id>', 'preview + approve a queued run'],
  ['/health', 'factory health meter + history'],
  ['/review', 'review the workspace diff'],
  ['/help', 'this page'],
  ['/exit', 'leave the harness'],
]

/**
 * What a submitted line BECOMES on its way to the model.
 *
 * Two grammars, and the difference is not cosmetic:
 *
 *  - A COMMAND's argument is something the app RUNS (a path, an id, a URL), so
 *    a paste inside it goes back in RAW. A label in its place would be a
 *    broken value.
 *  - A REQUEST's paste is MATERIAL the operator handed over, so it is
 *    FRAMED: marked as pasted, attributed as material rather than as the
 *    operator speaking, and stripped of any marker the payload forged. A
 *    request the operator typed by hand is returned UNCHANGED — the framing
 *    must never ride words the model should read as the operator's own.
 *
 * @param draft the line as the operator left the composer
 * @param pending the payloads behind the paste labels in that draft
 */
export function outgoingLine(
  draft: string,
  pending: ReadonlyMap<string, string> = new Map(),
): { text: string; command: boolean } {
  const typed = draft.trim()
  if (typed.startsWith('/')) {
    return { text: expandPendingPastePlaceholders(typed, pending), command: true }
  }
  return { text: framePasteExpansion(typed, pending), command: false }
}

export const HELP_FLAGS: Array<[string, string]> = [
  ['--test "cmd"', 'verification command'],
  ['--required-file', 'file that must exist'],
  ['--workspace dir', 'where to work'],
]

/**
 * The commands the composer completes against.
 *
 * Built from `HELP_COMMANDS` — the SAME list `/help` prints and the palette
 * offers — so a command can never exist in one surface and not the other.
 * The argument hint is split off the name (`/result <id>` -> `/result` +
 * `<id>`), because the completion accepts the NAME and the hint is what the
 * ghost text shows.
 *
 * The `/` entry in `HELP_COMMANDS` is a PROSE line ("type / to filter"), not
 * a command, so it is not a candidate.
 */
export const COMMAND_SPECS: CommandSpec[] = HELP_COMMANDS
  .map(([raw, desc]): CommandSpec => {
    const [name, ...rest] = raw.trim().split(/\s+/)
    const hint = rest.join(' ').trim()
    return { name, desc, argHint: hint || undefined }
  })
  .filter(spec => spec.name.startsWith('/') && spec.name.length > 1)

/**
 * How `/help` groups the verbs, in Hermes' `── Category ──` order. The banner's
 * capability column groups the same verbs under lowercase labels; both
 * surfaces append anything unlisted, so neither can hide a command the other
 * shows.
 */
export const HELP_GROUPS: HelpGroup[] = [
  { title: 'Composer', names: ['<request>', '/'] },
  { title: 'Session', names: ['/status', '/doctor', '/stats', '/display', '/debug', '/compact', '/clear', '/new', '/q'] },
  { title: 'Setup', names: ['/connect', '/create [name]', '/model', '/agents', '/crew', '/onboard', '/proof'] },
  { title: 'Work', names: ['/tasks', '/result <id>', '/events <id>', '/run <id>', '/review', '/health'] },
  { title: 'System', names: ['/update'] },
  { title: 'Help', names: ['/help', '/exit'] },
]

const HELP = `Just type what you want. The workspace decides how to verify it;
you approve once, then it runs.

Commands (all optional):
${HELP_COMMANDS.map(([name, desc]) => `  ${name.padEnd(16)}${desc}`).join('\n')}

Flags (only when you want to be exact):
${HELP_FLAGS.map(([name, desc]) => `  ${name.padEnd(16)}${desc}`).join('\n')}

To uninstall wednesday, exit first, then run: wednesday uninstall [--package]
(your projects are never touched — see the website's install section).`

type Ask = (prompt: string) => Promise<string | undefined>

/**
 * Flag parser for the REPL. Exported alongside `replLoop` so the dispatch test
 * drives the REAL defaults object instead of a hand-built fixture that could
 * quietly drift away from the product's.
 */
export function parseFlags(args: string[]) {
  const tests: string[] = []
  const requiredFiles: string[] = []
  let workspace = process.env.HARNESS_WORKSPACE ?? process.cwd()
  while (args.length) {
    const flag = args[0]
    // Validate BEFORE consuming the value: the old order ate the next arg and
    // then threw, so `wednesday "r" --bogus foo` swallowed `foo` and reported
    // a confusing `Missing value`/`Unknown option` pair.
    if (flag !== '--test' && flag !== '--required-file' && flag !== '--workspace') {
      throw new Error(`Unknown option: ${flag}`)
    }
    args.shift()
    const value = args.shift()
    if (!value?.trim()) throw new Error(`Missing value for ${flag}`)
    if (flag === '--test') tests.push(value)
    else if (flag === '--required-file') requiredFiles.push(value)
    else workspace = value
  }
  return { tests, requiredFiles, workspace: resolve(workspace) }
}

/**
 * Split a REPL line into tokens, honouring quotes AND backslash escapes.
 *
 * The old regex (`/"[^"]*"|'[^']*'|\S+/g`) could not express the single most
 * common verification command there is: `--test "node -e \"process.exit(0)\""`.
 * It matched `"node -e \"` as the quoted token and left `process.exit(0)\""` as
 * loose words, so the objective absorbed half the command and the flag arrived
 * mangled. A scanner is the only honest fix — and an UNBALANCED quote must stay
 * literal rather than swallowing the rest of the line.
 */
function tokenizeInline(line: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++
    if (i >= line.length) break
    const open = line[i]!
    const quote = open === '"' || open === "'" ? open : null
    if (quote) i++
    let token = ''
    let closed = !quote
    while (i < line.length) {
      const ch = line[i]!
      // An escaped quote is a literal quote, whatever we are inside.
      if (ch === '\\' && line[i + 1] === '"') { token += '"'; i += 2; continue }
      if (ch === '\\' && line[i + 1] === "'" && quote === "'") { token += "'"; i += 2; continue }
      if (quote && ch === quote) { closed = true; i++; break }
      if (!quote && /\s/.test(ch)) break
      token += ch
      i++
    }
    if (quote && !closed) {
      // Unbalanced: treat the opening quote as an ordinary character and keep
      // the text we already collected, so `"fix the thing` still reads.
      tokens.push(open + token)
    } else {
      tokens.push(token)
    }
  }
  return tokens
}

/**
 * Per-request flags inside a REPL line (`fix X --test "npm test"`).
 *
 * Startup flags and REPL flags share names on purpose: the same three knobs.
 * Pulls out known flag/value pairs wherever they appear and returns the
 * remainder as the objective. Unknown `--flags` are left in the objective text
 * (they may be prose, e.g. "fix the --bogus option") rather than throwing
 * mid-session.
 *
 * Exported for the parser test: this grammar decides what the operator's words
 * mean, and it used to be reachable only through a full session.
 */
/**
 * One animation tick of a live run.
 *
 * Exported, and that is the point: this is a one-line closure over `screen` and
 * `state`, and the guard inside it is load-bearing. When it was inlined in the
 * `setInterval` the perf test had to re-implement it to test it, which means the
 * test proved nothing about the code that actually runs - deleting the guard
 * from the real loop would have stayed green. Same structural fix as `main` /
 * `replLoop`: put it somewhere a test can reach.
 *
 * The spinner must not paint through an open plate. Asking is safe in a way that
 * blocking is not: if an overlay ever failed to detach, the worst outcome here
 * is a paused animation, never a frozen session with no way back.
 */
export function spinnerTick(screen: Screen, state: ScreenState): void {
  if (!state.busy || screen.overlayOpen()) return
  screen.tick()
  // The run line is animated, not static: the scanner frame and the verb both
  // derive from the same tick, so one owner animates both. The CHAT turn is
  // included: a chat was the one turn whose line named nothing real.
  state.status = busyStatus(screen.spinIndex, state.crew, state.chatActivity)
  screen.render(state)
}

export function parseInlineFlags(line: string): { objective: string; tests: string[]; requiredFiles: string[]; workspace: string | null } {
  const tokens = tokenizeInline(line)
  const tests: string[] = []
  const requiredFiles: string[] = []
  let workspace: string | null = null
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if ((tok === '--test' || tok === '--required-file' || tok === '--workspace') && i + 1 < tokens.length) {
      const value = tokens[i + 1]!
      if (value.trim()) {
        if (tok === '--test') tests.push(value)
        else if (tok === '--required-file') requiredFiles.push(value)
        else workspace = resolve(value)
        i++
        continue
      }
    }
    rest.push(tokens[i]!)
  }
  return { objective: rest.join(' ').trim(), tests, requiredFiles, workspace }
}

/**
 * Repository profiles for this session.
 *
 * `analyzeRepository` walks the whole tree (languages, key files, test files,
 * import edges). That is the right price once per session and the wrong price
 * before EVERY request: on a real repo it is about a second of blocked event
 * loop between "Enter" and the confirm card, which is what made the gate feel
 * late and the screen feel dead. The cache lives in the connector so it can be
 * cleared by a long-lived caller that needs fresh data.
 */
/**
 * Exported so a test can drive the REAL task construction (the page brief, the
 * page gate, the fresh-workspace constraint) instead of hand-building a fixture
 * that could drift from what the operator's request actually produces.
 */
export async function makeTask(
  request: string,
  tests: string[],
  requiredFiles: string[],
  workspace: string,
  auto?: AutoDefaults | null,
): Promise<EngineeringTask> {
  if (!tests.length || tests.some(test => !test.trim())) throw new Error('Supply at least one --test command; verification is required.')
  if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory.')
  const profile = await analyzeRepositoryCached(workspace)
  // A page request in a bare folder used to be measured by "the workspace is
  // not empty", which a hello-world placeholder passes — so the run reported
  // PASS on output the operator never asked for and the repair loop never ran
  // (B151). A page gets a structural gate and a real brief instead.
  const page = isPageRequest(request)
  const fresh = isFreshWorkspace(workspace)
  const defaultGate = tests.length === 1 && tests[0] === NONEMPTY_WORKSPACE_CHECK
  const pageGate = page && defaultGate && requiredFiles.length === 0
  return {
    id: `harness-${randomUUID()}`,
    workspace,
    objective: request,
    role: page ? 'frontend' : (auto?.role ?? 'backend'),
    stack: page ? 'html, css' : (profile.languages.join(', ') || auto?.stack || 'unknown'),
    constraints: [
      // "Minimal" is correct for an edit and wrong for a build from scratch:
      // it is exactly the instruction a small model follows into a placeholder.
      fresh ? 'Build the requested result completely — a placeholder is a failed deliverable.' : 'Keep the change minimal.',
      'Work only inside the assigned workspace.',
      'Do not modify unrelated files.',
      ...(page ? pageBuildBrief(request) : []),
      ...profile.toConstraints(),
    ],
    acceptanceCriteria: page
      ? pageAcceptanceCriteria()
      : ['Complete the requested objective and pass the supplied verification.'],
    acceptance: { requiredFiles: pageGate ? [PAGE_ENTRY, ...requiredFiles] : requiredFiles },
    verification: { setupCommands: [], testCommands: pageGate ? [pageCheckCommand(), ...tests] : tests },
    modelRequirements: { capability: 'coding' },
  }
}

async function approve(task: EngineeringTask, ask: Ask, classic = false): Promise<boolean> {
  requireLiveConfig()
  console.log(`\n${previewTitle()}`)
  const mode = (process.env.FACTORY_EXECUTION_MODE ?? '').trim().toLowerCase()
  if (mode && mode !== 'live') console.log(`Mode: ${mode} (deterministic — no model call)`)
  // The seven shared facts (Task, Verify, Route, Seats, Files, Where, Time)
  // plus the difficulty/crew enrichment — one builder, so the classic card
  // and the screen dialog can never disagree about the same run.
  const preview = await buildRunPreview(task)
  for (const line of preview.lines) console.log(line)
  for (const line of preview.detail) console.log(line)
  console.log(classic ? JSON.stringify(task, null, 2) : taskCard(task))
  console.log(rule())
  console.log('Approval permits workspace changes and the listed shell commands. This preview is not a sandbox.')
  if ((await ask('Run this task? [y/N] '))?.trim().toLowerCase() === 'y') return true
  console.log('cancelled by operator.')
  return false
}

interface RunSink {
  /** `detail` is the last concrete thing in the event (a tool name, an attempt). */
  event(type: string, role?: string, detail?: EventDetail): void
  line(text: string, tone: MsgTone): void
  /** A framed answer block (screen path). Classic prints the lines plain. */
  panel?(title: string, lines: Array<{ text: string; tone: MsgTone }>): void
  /** Diff rows for the changed files (screen path only; a pipe gets the paths). */
  diff?(rows: ScreenMessage[]): void
  /**
   * Patch rows to allow this run. A live screen answers from its density
   * (`verbose` reads more); `0` means the operator chose `quiet`, so the diff
   * is not evidence they asked to see.
   */
  patchBudget?(): number
}

/**
 * The row detail an event carries: which tool ran, and the one word that
 * changes what the row means.
 *
 * The bus is authoritative here — a tool name that is not in the payload is
 * not invented, and a missing `passed` leaves the note off rather than printing
 * an assumed PASS. `verification.setup`/`verification.test` report `passed`;
 * a coding-agent seat reports a `status`; everything else reports nothing.
 */
export function eventDetail(type: string, payload: Record<string, unknown> | undefined): EventDetail | undefined {
  if (type === 'tool.called') {
    const tool = typeof payload?.tool === 'string' ? payload.tool : ''
    // One vocabulary on the row: PASS / FAIL, whatever the seat called it. A
    // coding-agent reports `completed`/`failed`, verification reports a
    // boolean, and both must read the same to the operator scanning the rail.
    let note: string | undefined
    if (payload?.passed === true) note = 'PASS'
    else if (payload?.passed === false) note = 'FAIL'
    else if (payload?.status === 'completed') note = 'PASS'
    else if (payload?.status === 'failed') note = 'FAIL'
    else if (typeof payload?.status === 'string' && payload.status) note = payload.status
    if (!tool) return undefined
    // What the call TOUCHED. The bus is authoritative, so only fields it
    // actually sent are used: a command, the path(s) written, a finding count.
    // Before this the row named the tool and the verdict, never the subject —
    // `verification.test · PASS` without saying which test.
    const one = (value: unknown): string | undefined => {
      if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ')
      if (Array.isArray(value)) {
        const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        if (items.length > 0) {
          return items.length > 3 ? `${items.slice(0, 3).join(', ')} +${items.length - 3}` : items.join(', ')
        }
      }
      return undefined
    }
    const detail = one(payload?.command) ?? one(payload?.cmd)
      ?? one(payload?.path) ?? one(payload?.file) ?? one(payload?.files) ?? one(payload?.target)
      ?? (typeof payload?.findings === 'number' && payload.findings > 0
        ? `${payload.findings} finding${payload.findings === 1 ? '' : 's'}`
        : undefined)
    return { tool, ...(note ? { note } : {}), ...(detail ? { detail } : {}) }
  }
  if (type === 'repair.started' && typeof payload?.attempt === 'number') {
    return { note: `attempt ${payload.attempt}` }
  }
  if (type === 'agent.completed') {
    // A seat that FAILED still reports `agent.completed` — the orchestrator has
    // no `agent.failed` event, so the verdict rides in the payload. Without this
    // the row said `done` in green over a failed seat, and the dock agreed,
    // which is what made the operator ask whether the whole run was invented
    // (operator, 2026-11-04: "if model not responding then what task created,
    // agent started — is this all fake or hallucinated?").
    //
    // The bus is authoritative: only a status it actually sent is reported.
    const status = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : ''
    if (status === 'failed' || status === 'error') return { note: 'FAIL', status }
    if (status === 'aborted' || status === 'cancelled') return { note: 'ABORT', status }
  }
  if (type === 'agent.activity') {
    // Live activity: the seat's reasoning, talk, commands and file writes.
    // The kind is checked against the known vocabulary, so a malformed event
    // cannot invent a row shape the renderer does not know.
    const kind = payload?.kind
    const activityKind: AgentActivityKind =
      kind === 'text' || kind === 'tool' || kind === 'file' ? kind : 'reasoning'
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined
    return {
      activity: {
        kind: activityKind,
        text: text(payload?.text),
        tool: text(payload?.tool),
        detail: text(payload?.detail),
        status: text(payload?.status),
      },
    }
  }
  return undefined
}

/**
 * The receipt a configuration failure gets instead of the generic retry hint.
 *
 * The old card ended every failure with `/result <id> to inspect · /run <id> to
 * retry`. On a missing credential that advice is actively wrong: the retry runs
 * the identical doomed path, so the operator approves again, watches it die
 * again, and concludes the approval key is frozen. So a classified blocker
 * drops the retry offer entirely and names the one action that helps.
 */
/**
 * Swap the start page for the stream. Pure state, exported so the transition is
 * testable without a terminal: the frame draws either the home card or the
 * transcript, and a request that arrives while `home` is true lands on a page
 * that never renders messages.
 */
export function leaveHomeCard(state: ScreenState, limit: number): void {
  state.home = false
  state.messages.length = 0
  state.placeholder = BROWSE_HINT
  // From here on the session's ledger takes the right edge.
  state.side = { title: 'session', tokens: 0, limit }
}

function blockerLines(blocker: ConfigBlocker): Array<{ text: string; tone: MsgTone }> {
  return [
    { text: `BLOCKED before any work: ${blocker.message}`, tone: 'red' },
    { text: `fix: ${blocker.remedy}`, tone: 'yellow' },
  ]
}

/**
 * The closing hint of a failed run.
 *
 * Pure and exported so the ONE claim that matters here can be asserted without
 * a live run: a configuration blocker never gets `/run ... to retry`, because
 * that offer IS the loop — the same doomed approval, byte for byte, which is
 * what made pressing `y` look like it did nothing.
 */
export function retryHint(id: string, blocker: ConfigBlocker | null): string {
  return blocker
    ? `/result ${id} to inspect · nothing will run until the blocker above is fixed`
    : `/result ${id} to inspect · /run ${id} to retry`
}

/**
 * A mid-run endpoint failure, named.
 *
 * The operator's 2026-11-01 report — "the task always fails and the folder is
 * empty" — was a model endpoint (Colab tunnel) answering HTTP 530 with an HTML
 * error page. The run was honest, but the receipt never said where the files
 * would have gone or that nothing was written, so an empty folder read as a
 * silent front-end bug. This classifies the diagnostics the executor already
 * records; it invents nothing the run did not report.
 */
export function endpointFailureHint(diagnostics: string | undefined): string | null {
  const text = (diagnostics ?? '').toLowerCase()
  if (!text) return null
  // Credentials FIRST: a "no credential for provider route" failure also
  // contains `turn failed`, so the stream rule below used to answer the wrong
  // question. A missing key is not a tunnel problem.
  if (/no credential|credential for provider|api ?key[^.]{0,40}not set|invalid api key/.test(text)) {
    return 'the provider has no usable credential — run /connect and store the key it names, then retry. Nothing about the task was wrong.'
  }
  if (/(\b530\b|\b502\b|\b503\b|\b504\b|tunnel|econnrefused|econnreset|fetch failed|html page|socket hang up|timed out)/.test(text)) {
    return 'the model endpoint failed mid-run — a tunnel URL changes when its host restarts: run /connect with the current one, then retry.'
  }
  // A 404 from the provider: the model id is not in its catalogue, or the
  // base URL points at the wrong place. The operator's own build failed with
  // exactly this ("NVIDIA request failed: 404 — 404 page not found") and the
  // card carried the raw HTTP line and no next step at all — the one failure
  // whose fix is a single command the operator already knows.
  if (/\b404\b/.test(text)) {
    return 'the provider answered 404 — that model id is not in its catalogue (or the base URL is wrong): /model picks an id it lists, /connect checks the URL.'
  }
  // A tunnel that answers but cuts a long generation: the worker reports
  // `Stream ended without finish_reason`, and the 2026-11-01 live run failed
  // twice on exactly that. It is the same class of problem (the endpoint, not
  // the task) so it gets the same advice instead of a bare stage failure.
  if (/stream ended|finish_reason|turn failed/i.test(text)) {
    return 'the model stopped mid-answer (the tunnel cut the stream) — that is the endpoint, not the task: retry, or /connect a fresh tunnel URL.'
  }
  return null
}

/**
 * A bounded count of the files sitting in the workspace.
 *
 * `result.filesChanged` is what the ChangeCollector TRACKED, not what is on
 * disk: a coder that writes and then fails verification can leave real files
 * behind while the result lists none. The receipt must describe the folder the
 * operator will actually open, never the collector's opinion of it.
 */
export function workspaceFileCount(workspace: string | undefined, cap = 400): number {
  if (!workspace) return 0
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || seen >= cap) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (seen >= cap) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (entry.isDirectory()) walk(resolve(dir, entry.name), depth + 1)
      else seen++
    }
  }
  walk(workspace, 0)
  return seen
}

/**
 * Where the run left the workspace, said plainly after a failure, from
 * EVIDENCE rather than from the result record. A failed run that wrote nothing
 * must say so; a failed run whose files are on disk must say THAT, or the
 * operator opens the folder, sees files (or none) that contradict the receipt
 * and reports a front-end bug that never existed.
 */
/**
 * One readable sentence out of a provider diagnostic.
 *
 * The ACP answers with a nested envelope:
 * `{"stopReason":"error","output":[],"diagnostic":"{\"code\":-32603,
 * \"message\":\"Internal error: turn failed: llm-pi-ai: no credential …\"}"}`.
 * The receipt printed that verbatim inside the answer panel, where it wrapped
 * into a full-screen box of escaped quotes, `data: undefined` and a stray
 * factory-host log line (operator report, 2026-11-04: "looks so bad"). The
 * operator needs the sentence, not the envelope; the whole payload stays in the
 * run record behind `/result <id> --raw`.
 */
export function diagnosticLine(diagnostics: string | undefined, max = 120): string | null {
  let text = (diagnostics ?? '').trim()
  if (!text) return null
  const field = (value: unknown, key: string): string => {
    if (!value || typeof value !== 'object') return ''
    const raw = (value as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  // Unwrap the envelope: diagnostic → message → error, up to three layers,
  // because each layer above is an escaped JSON string of the one below.
  for (let depth = 0; depth < 3; depth++) {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { break }
    const next =
      field(parsed, 'diagnostic') || field(parsed, 'message') ||
      field(parsed, 'error') || field(parsed, 'detail')
    if (!next || next === text) break
    text = next
  }
  // A message buried inside a still-unparsed blob (truncated JSON in a log).
  if (/^[[{]/.test(text)) {
    const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    if (match?.[1]) {
      try { text = JSON.parse(`"${match[1]}"`) as string } catch { text = match[1] }
    }
  }
  text = text
    .replace(/\b(Internal error|turn failed|llm-pi-ai):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The approval card's one-line summary of what will verify the run.
 *
 * The gate used to print `task.verification.testCommands` verbatim. For a
 * folder with no project file that is the auto-generated non-empty check: a
 * ~1,000-character `node -e "…"` script that wrapped into ten rows and read as
 * a fault rather than a plan (operator report, 2026-11-04: "that big something
 * may they think its something wrong with it"). The exact command stays in the
 * task record; the card shows the INTENT.
 */
export function verificationLabel(commands: string[]): string {
  if (commands.length === 0) return '(none — the run is not verified)'
  const one = (cmd: string): string => {
    const text = cmd.replace(/\s+/g, ' ').trim()
    // The auto checks are recognisable by what they look for, not by their
    // spelling: any `readdirSync(...).length` probe is the non-empty check.
    if (/readdirsync\([^)]*\)\s*\.length/i.test(text)) return 'workspace is not empty (auto)'
    if (/index\.html/i.test(text) && /doctype|<html|<!doctype/i.test(text)) return 'index.html exists and is valid HTML (auto)'
    if (/^npm (run )?test\b/.test(text)) return 'npm test'
    if (/^npm run [\w:-]+/.test(text)) return text.split(' ').slice(0, 3).join(' ')
    if (/^node --test\b/.test(text)) return 'node --test'
    return text.length > 56 ? `${text.slice(0, 55)}…` : text
  }
  if (commands.length === 1) return one(commands[0]!)
  const kinds = [...new Set(commands.map(one))]
  return `${commands.length} checks · ${kinds.slice(0, 2).join(' · ')}${kinds.length > 2 ? ' · …' : ''}`
}

/**
 * The structured facts behind the approval preview.
 *
 * One builder, used by BOTH surfaces (the classic card and the screen
 * dialog) so the two can never say different things about the same run —
 * the operator must be able to trust the card without comparing it to the
 * screen. The screen dialog drops fields FROM THE END when the terminal is
 * short, so `lines` is ordered most-important-first: what is about to be
 * run, what will prove it, where it goes, what it touches, and only then
 * the estimate.
 */
export interface PreviewFacts {
  /** The objective's first line — what the operator asked for. */
  task: string
  /** Verification intent, from `verificationLabel`. */
  verify: string
  /** Where the run resolves its model, e.g. `openrouter · <id>` or `local · <id> @ <base>`. */
  route: string
  /** `planner X · coder Y · vision Z` — the seats the pipeline routes through. */
  seats: string
  /** The files the run is expected to touch (first few, then `… +N more`). */
  files: string
  /** The workspace the run writes to. */
  where: string
  /** How long the run is expected to take, or why it cannot be estimated. */
  time: string
}

export interface RunPreview {
  /** The seven facts, in display order (`Task`, `Verify`, `Route`, `Seats`,
   *  `Files`, `Where`, `Time`). */
  facts: PreviewFacts
  /** `Key: value` lines for the classic card and the screen dialog. */
  lines: string[]
  /** Difficulty band and selected crew for the classic card. Empty when the
   *  difficulty score could not be computed (never blocks approval). */
  detail: string[]
}

/** Collapse to one line and squeeze to `max` characters with a trailing `…`. */
function oneLine(value: string, max = 110): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Resolve the model route the run will ACTUALLY take.
 *
 * Mirrors the executor: the coder seat's pin wins as `preferredModel`, a
 * `provider/` pin routes straight to that provider, and a bare id pinned to a
 * local endpoint goes to the local route exactly as B195/B196 fixed it.
 * Without a pin the legacy route provider owns the model — the preview must
 * never claim the profile's hosted route while the worker would be forced
 * local (that was the 2026-11-05 failure this whole preview exists to stop).
 */
interface RunRoute {
  /** Provider the run sends the request to: `openrouter` · `nvidia` · `zen` · `local`. */
  provider: string
  /** Model id, WITHOUT any provider prefix. */
  model: string
  /** True when the pick came from the crew seat, not from `/model`. */
  pinned: boolean
  /** Local base URL to show, when the provider is `local`. */
  baseURL?: string
}

function runRoute(role: string | undefined, env: NodeJS.ProcessEnv): RunRoute {
  const provider = (env.FACTORY_LLM_PROVIDER ?? 'openrouter').trim().toLowerCase() || 'openrouter'
  const pin = seatModelPin(role ?? 'coder', env)
  const slot = crewSlotFor(role ?? 'coder')
  const localBase =
    (env[slot === 'planner' ? 'FACTORY_CREW_PLANNER_BASE_URL'
      : slot === 'vision' ? 'FACTORY_CREW_VISION_BASE_URL'
        : 'FACTORY_CREW_CODER_BASE_URL'] ?? '').trim()
    || (env.LOCAL_LLM_BASE_URL ?? '').trim()
  const pinSplit = pin ? splitProviderPin(pin) : undefined
  if (pinSplit) return { provider: pinSplit.provider, model: pinSplit.model, pinned: true, baseURL: pinSplit.provider === 'local' ? localBase : undefined }
  if (pin) {
    // The pin was already decided by B196: with a local endpoint the id was
    // stored as `local/<id>`, so a bare id here means "this belongs to the
    // route provider" — show that, not a hidden local route.
    return { provider, model: pin, pinned: true, baseURL: provider === 'local' ? localBase : undefined }
  }
  const model = provider === 'local'
    ? (env.LOCAL_LLM_MODEL ?? '').trim()
    : (env.DSH_LLM_MODEL ?? '').trim()
  return { provider, model: model || '(unset)', pinned: false, baseURL: provider === 'local' ? localBase : undefined }
}

/** Route as one human line, e.g. `openrouter · x · (coder pin)` or `local · qwen @ 127.0.0.1:18090/v1`. */
export function routeLabel(role: string | undefined = 'coder', env: NodeJS.ProcessEnv = process.env): string {
  const route = runRoute(role, env)
  const via = route.pinned ? ` (crew ${crewSlotFor(role ?? 'coder')} pin)` : ''
  if (route.provider === 'local') {
    const at = route.baseURL ? ` @ ${route.baseURL}` : ' @ (LOCAL_LLM_BASE_URL unset)'
    return `local · ${route.model}${at}${via}`
  }
  return `${route.provider} · ${route.model}${via}`
}

/** Seats as one human line — ACTIVE crew first (by position), env profile after. */
export function seatsLabel(crew: Crew | null = activeCrew(), env: NodeJS.ProcessEnv = process.env): string {
  return crewSeatModels(crew, env).map(({ role, model }) => `${role} ${model}`).join(' · ')
}

/** Files, capped so a 300-file task cannot split the dialog: `a, b, c … +N more`. */
export function filesLabel(task: EngineeringTask): string {
  const files = task.acceptance?.requiredFiles ?? []
  if (files.length === 0) return '(none — the run chooses)'
  const shown = files.slice(0, 4)
  const tail = files.length > shown.length ? ` … +${files.length - shown.length} more` : ''
  return oneLine(`${shown.join(', ')}${tail}`)
}

/** Rough, honest estimate from the difficulty band and the verification list. */
export function estimateRunTime(
  difficulty: { level: string; maxAgents: number } | null,
  verifyCount: number,
): string {
  // An unverified run cannot be estimated from the work list; saying otherwise
  // would be the card claiming certainty it does not have.
  if (verifyCount === 0) return 'unknown — this run has no verification'
  if (!difficulty) return 'unknown — difficulty could not be scored'
  const BASE: Record<string, [number, number]> = {
    low: [2, 5],
    medium: [4, 8],
    high: [7, 14],
    'very-high': [12, 22],
    max: [20, 35],
  }
  const [lo, hi] = BASE[difficulty.level] ?? BASE.medium!
  const extra = Math.min(4, Math.max(0, verifyCount - 1))
  return `~${lo + extra}–${hi + extra * 2} min (est.)`
}

/** Build the preview facts. Synchronous; difficulty may be supplied by the caller. */
export function previewFacts(
  task: EngineeringTask,
  env: NodeJS.ProcessEnv = process.env,
  crew: Crew | null = activeCrew(),
  difficulty: { level: string; maxAgents: number } | null = null,
): PreviewFacts {
  const tests = task.verification?.testCommands ?? []
  const objective = (task.objective ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '(no objective)'
  return {
    task: oneLine(objective) || '(no objective)',
    verify: verificationLabel(tests),
    route: routeLabel(task.role, env),
    seats: oneLine(seatsLabel(crew, env), 110),
    files: filesLabel(task),
    where: oneLine(task.workspace || '(no workspace)', 110),
    time: estimateRunTime(difficulty, tests.length),
  }
}

/** `Task`, `Verify`, `Route`, `Seats`, `Files`, `Where`, `Time` — one line each. */
export function runPreviewLines(facts: PreviewFacts): string[] {
  return [
    `Task: ${facts.task}`,
    `Verify: ${facts.verify}`,
    `Route: ${facts.route}`,
    `Seats: ${facts.seats}`,
    `Files: ${facts.files}`,
    `Where: ${facts.where}`,
    `Time: ${facts.time}`,
  ]
}

/**
 * The approval preview shared by both surfaces.
 *
 * Async because the difficulty score is a dynamic import; any failure in
 * scoring (model/selection not reachable, malformed profile) degrades to
 * `unknown` rather than blocking approval. The `detail` rows are the
 * difficulty band and the selected crew — useful on the classic card, but
 * kept out of the screen dialog so the seven facts stay the whole story.
 */
export async function buildRunPreview(
  task: EngineeringTask,
  env: NodeJS.ProcessEnv = process.env,
  crew: Crew | null = activeCrew(),
): Promise<RunPreview> {
  const tests = task.verification?.testCommands ?? []
  const detail: string[] = []
  let difficulty: { level: string; maxAgents: number; reasons: string[] } | null = null
  try {
    const [{ scoreDifficulty }, { getCachedSmallCrew, selectCrewForTask }] = await Promise.all([
      import('../agents/difficulty'),
      import('../agents/ecc-crew'),
    ])
    const scored = scoreDifficulty({
      objective: task.objective,
      stack: task.stack,
      role: task.role,
    })
    difficulty = scored
    detail.push(`Difficulty: ${scored.level} (≤${scored.maxAgents} agents): ${scored.reasons.join('; ')}`)
    const agents = selectCrewForTask(
      await getCachedSmallCrew(),
      { objective: task.objective, stack: task.stack, role: task.role },
      scored.maxAgents,
    )
    if (agents.length > 0) {
      detail.push(`Crew: ${agents.map(agent => agent.name).join(', ')}`)
    }
  } catch {
    // Difficulty enrichment never blocks approval.
  }
  const facts = previewFacts(task, env, crew, difficulty)
  return { facts, lines: runPreviewLines(facts), detail }
}

/**
 * A chat failure in one readable sentence.
 *
 * The provider's envelope went straight to the screen: `openrouter chat
 * request failed: 400 — {"error":{"message":"…","code":400},"user_id":
 * "user_3ID7F9…"}` (operator screenshot, 2026-11-04). The user id is not the
 * operator's business and the braces are not a sentence; keep the status, keep
 * the provider's message, drop the envelope.
 */
export function chatFailureLine(error: string, max = 200): string {
  const text = (error ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'the request failed'
  const brace = text.indexOf('{')
  if (brace < 0) return text.length > max ? `${text.slice(0, max - 1)}…` : text
  const head = text.slice(0, brace).replace(/[\s—:-]+$/, '').trim()
  const body = diagnosticLine(text.slice(brace), Math.max(40, max - head.length - 3)) ?? ''
  const line = [head, body].filter(Boolean).join(' — ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The chat-failure receipt.
 *
 * The FIRST failure is a card: the cause, what did not happen, and the one
 * action that helps. The SAME failure again is ONE line. Three identical
 * cards in a row (operator report, 2026-11-04 — `Chat failed: fetch failed`
 * three times under three prompts) read as the app breaking, not as one dead
 * endpoint; a count says the same thing in a third of the space.
 *
 * Pure and exported so the contract can be asserted without a live model. The
 * caller keeps the last reason and its count; a DIFFERENT reason is a new
 * card, even if the previous failure was also a failure.
 */
export function chatFailureReceipt(
  reason: string,
  nextStep: string,
  last: { reason: string; count: number } = { reason: '', count: 0 },
): { repeat: boolean; count: number; text: string; lines: Array<{ text: string; tone: MsgTone }> } {
  const count = reason === last.reason ? last.count + 1 : 1
  if (count > 1) {
    return {
      repeat: true,
      count,
      text: `↺ same failure again (×${count}) — ${reason}`,
      lines: [{ text: `Same failure again (×${count}) — ${reason}`, tone: 'red' }],
    }
  }
  return {
    repeat: false,
    count,
    text: `Chat failed: ${reason}`,
    lines: [
      { text: reason, tone: 'red' },
      { text: 'Nothing was built — a chat turn never writes files.', tone: 'dim' },
      { text: nextStep, tone: 'dim' },
    ],
  }
}

export function failureEvidenceLines(
  result: { filesChanged?: string[]; diagnostics?: string } | undefined,
  workspace: string | undefined,
  fileCount = workspaceFileCount(workspace),
  blocked = false,
): Array<{ text: string; tone: MsgTone }> {
  const wrote = result?.filesChanged?.length ?? 0
  const where = workspace || '(workspace not recorded)'
  const lines: Array<{ text: string; tone: MsgTone }> = []
  if (wrote > 0) {
    lines.push({ text: `changed in: ${where}`, tone: 'dim' })
  } else if (fileCount > 0) {
    lines.push({ text: `no changed files were reported, but ${where} holds ${fileCount} file(s) — check it with /review`, tone: 'dim' })
  } else {
    lines.push({ text: `workspace is empty: nothing was written to ${where}`, tone: 'dim' })
  }
  // A configuration blocker already names its own remedy; appending the
  // endpoint guess on top produced TWO contradictory fixes for one failure
  // ("no credential" + "the tunnel cut the stream" — operator report,
  // 2026-11-04). The blocker wins and the guess stays out.
  const hint = blocked ? null : endpointFailureHint(result?.diagnostics)
  if (hint) lines.push({ text: `fix: ${hint}`, tone: 'yellow' })
  return lines
}

async function runRecorded(id: string, bus: PersistentFactoryEventBus, sink?: RunSink, signal?: AbortSignal, workspace?: string): Promise<void> {
  const startedAt = Date.now()
  const seen = new Set<string>()
  async function showEvents(): Promise<void> {
    try {
      for (const event of await bus.list(id)) {
        if (seen.has(event.id)) continue
        seen.add(event.id)
        if (sink) {
          // One detail object feeds BOTH surfaces from one derivation: the dock
          // takes the tool name, the transcript row takes the tool name plus its
          // outcome. Deriving it twice is how the two drift apart.
          sink.event(event.type, event.role, eventDetail(event.type, event.payload))
        } else {
          if (event.type === 'agent.started' && event.role) {
            const header = stageHeader(event.role)
            if (header) console.log(header)
          }
          console.log(formatEvent(event.type, event.role))
        }
      }
    } catch {
      // A partial JSONL write can be retried on the next poll.
    }
  }
  let monitoring = true
  const monitor = (async () => {
    while (monitoring) {
      await showEvents()
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  })()
  try {
    const outcome = await runHermesTask(id, signal ? { signal } : {})
    monitoring = false
    await monitor
    await showEvents()
    const statusOk = outcome.status === 'completed' ? true : outcome.status === 'failed' || outcome.status === 'cancelled' ? false : null
    const result = outcome.result as EngineeringResult | undefined
    // Consistent result card, same order every run: status → summary → files →
    // tests → acceptance → diagnostics → next step. Previously the flat
    // `key: value` lines varied by outcome with no hierarchy, so a pass and a
    // fail read the same. The status carries the decode-key mark; a failure
    // names the recovery command instead of leaving the operator to guess.
    const passedTests = (result?.tests ?? []).filter(t => t.passed).length
    const totalTests = (result?.tests ?? []).length
    const testBits = totalTests ? ` · ${passedTests}/${totalTests} tests PASS` : ''
    const fileBits = result?.filesChanged?.length ? ` · ${result.filesChanged.length} files` : ''
    // Classify BEFORE the headline: a run that died on a missing credential is
    // not a task that failed, and rendering it as one is what sent the operator
    // back to the approval card three times.
    const blocker = statusOk === false ? configBlockerIn(result?.diagnostics) : null
    const headline = statusOk === true
      ? `${glyph('floret')} task completed${fileBits}${testBits}`
      : statusOk === false
        ? blocker
          ? `${glyph('skull')} task blocked — ${blocker.message}`
          : `${glyph('skull')} task ${outcome.status}${testBits}`
        : `task ${outcome.status}`
    const resultLines: Array<{ text: string; tone: MsgTone }> = [
      { text: headline, tone: statusOk === null ? 'plain' : statusOk ? 'green' : 'red' },
    ]
    if (result) {
      // The panel is a card, so every line is ONE row in spirit: multi-line
      // provider prose is collapsed rather than wrapped into a wall.
      const oneLine = (text: string): string => streamLine(text).replace(/\s*\n\s*/g, ' ')
      if (result.summary) resultLines.push({ text: oneLine(result.summary), tone: statusOk === false ? 'red' : 'plain' })
      if (result.filesChanged?.length) resultLines.push({ text: `files: ${result.filesChanged.join(', ')}`, tone: 'dim' })
      for (const test of result.tests ?? []) resultLines.push({ text: `test ${test.passed ? 'PASS' : 'FAIL'}: ${test.command}`, tone: test.passed ? 'green' : 'red' })
      for (const check of result.acceptanceChecks ?? []) resultLines.push({ text: `acceptance ${check.passed ? 'PASS' : 'FAIL'}: ${check.criterion}`, tone: check.passed ? 'green' : 'red' })
      const diagnostic = diagnosticLine(result.diagnostics)
      if (diagnostic) resultLines.push({ text: `diagnostics: ${diagnostic}`, tone: 'dim' })
    }
    if (blocker) {
      for (const line of blockerLines(blocker)) resultLines.push(line)
    }
    // No `/run ... to retry` on a blocker: the retry is the identical doomed
    // run, and offering it is what made `y` look like it did nothing.
    // A failure must say WHERE the work would be and whether anything landed.
    // "task failed" over an empty folder is indistinguishable from a UI bug.
    if (statusOk === false) {
      for (const line of (blocker
        ? failureEvidenceLines(result, workspace, undefined, true)
        : failureEvidenceLines(result, workspace))) resultLines.push(line)
    }
    if (statusOk === false) resultLines.push({ text: retryHint(id, blocker), tone: 'dim' })
    if (sink) {
      // The answer gets Hermes' response panel; the work above it stays in `┊`
      // rows. Then the turn summary: `⋯ 12.4s · edited 2 files · 6/6 tests`.
      if (sink.panel) sink.panel('Wednesday', resultLines)
      else for (const line of resultLines) sink.line(line.text, line.tone)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      const bits = [`${seconds}s`]
      if (result?.filesChanged?.length) {
        bits.push(`edited ${result.filesChanged.length} file${result.filesChanged.length === 1 ? '' : 's'}`)
      }
      if (totalTests) bits.push(`${passedTests}/${totalTests} tests PASS`)
      sink.line(`⋯ ${bits.join(' · ')}`, 'dim')
      // Evidence AFTER the summary, not inside the panel: the panel is the
      // answer, the diff is the proof, and a diff row carries its own colour so
      // it must not travel through the panel's tone-only wrapper. A zero budget
      // is the `quiet` density: outcome only, no patch.
      const budget = sink.patchBudget?.() ?? PATCH_BUDGET
      if (sink.diff && workspace && result?.filesChanged?.length && budget > 0) {
        const patch = patchRows(workspace, result.filesChanged, budget)
        sink.diff(patch.rows)
        if (patch.truncated) sink.line('… /review for the whole patch', 'dim')
      }
    } else {
      if (isTty()) console.log(rule())
      for (const line of resultLines) console.log(statusLine(line.text, line.tone === 'plain' ? null : line.tone === 'green'))
      if (isTty() && result) console.log(rule())
    }
    if (outcome.status !== 'completed') process.exitCode = 1
  } finally {
    monitoring = false
    await monitor
  }
}

async function submitAndRun(task: EngineeringTask, bus: PersistentFactoryEventBus, sink?: RunSink, signal?: AbortSignal): Promise<void> {
  const id = await submitTask({ task, supervisor: 'terminal-harness' })
  if (sink) {
    // Hermes' turn-start rule: a 40-cell accent line separates one turn's work
    // from the last, so a long transcript has a seam the eye can find.
    sink.line('─'.repeat(40), 'dim')
    sink.line(`submitted: ${id}`, 'plain')
  } else console.log(`submitted: ${id}`)
  await runRecorded(id, bus, sink, signal, task.workspace)
}

interface ReplUi {
  ask(prompt: string): Promise<string | undefined>
  approve(task: EngineeringTask): Promise<boolean>
  note(text: string): void
  error(text: string): void
  /**
   * Transient "what is happening" notice while the REPL does background work
   * (e.g. reading the workspace before the approval card). The screen path
   * shows it as a toast; classic has nowhere to put it, so it is absent there.
   */
  progress?(text: string): void
  running?(active: boolean): void
  /** Private prompt: no history, no stream echo (model ids, secrets). */
  askPrivate?(prompt?: string): Promise<string | undefined>
  /** Secret prompt: masked while typing, never in the stream (API keys). */
  askSecret?(prompt?: string): Promise<string | undefined>
  /** Configuration prompt: visible in the composer, no stream echo (URLs). */
  askConfig?(prompt?: string): Promise<string | undefined>
  /** Session facts only the live screen knows, for /status (Hermes shows
   * session id, spend and whether an agent is running). */
  statusContext?(): { sessionId?: string; tokens?: number; busy?: boolean; path?: string }
  /**
   * Window pressure: the prompt size of the LAST request, in tokens.
   *
   * The meter's `ctx` segment must read how full the CONTEXT is, and the
   * harness's cumulative spend is a different number — dividing it by the
   * window printed `ctx 29.3K/13.0K`, which the operator rightly reported as a
   * broken gauge. Only the caller sees the last request's size, so it says so
   * here; classic has no meter and leaves this undefined.
   */
  context?(tokens: number): void
  /** Screen-backed select list (opencode dialog-select grammar). Absent on classic. */
  select?(title: string, options: SelectOption[]): Promise<string | undefined>
  /** Repaint after a select overlay closes. Absent on classic. */
  redraw?(): void
  /**
   * Clear the session's visible history. `fresh` also drops the session ledger
   * so the next request reads as the first one.
   *
   * Screen state again, so it lives behind the same hook rule as `watchRun`
   * (B100/B102): the dispatcher must never reach into another scope's state.
   */
  clearSession?(fresh: boolean): void
  /**
   * Arm the keyboard while a run is live: Esc/Ctrl+C interrupt the run, and
   * anything else composes the NEXT request (the queue), because the draft
   * lives in the caller's state.
   *
   * This hook exists so `replLoop` never reaches into another scope for
   * `state` again: that reach is exactly what produced "state is not defined"
   * on the TTY path — first in `ui.progress`, then in `watchRun` — and it is
   * invisible to every piped test. The screen path implements it with its real
   * `state`; classic has no live keyboard and leaves it undefined.
   */
  watchRun?: (onInterrupt: () => void) => () => void
  /** Called when the crew seats change; the holder repaints its rail. */
  crewChanged?: () => void
  /**
   * The live CHAT turn: who is answering and what it is doing right now.
   *
   * The activity line above the meter needs this: a chat was the one turn
   * whose line named nothing real, because only a BUILD filled the crew
   * dock. The holder owns the state; the dispatcher never reaches into it.
   */
  chatActivity?(activity: { role: string; detail: string } | null): void
  /**
   * Emit pre-shaped, per-line toned output (the inspection views).
   *
   * `note` takes ONE string, so a table cannot use it: the whole block would
   * arrive as a single message and every row would share one tone. `block` keeps
   * the tone per line, which is what makes `/tasks` scannable. Absent on classic
   * (a pipe prints plain lines).
   */
  block?(lines: ViewLine[]): void
  /**
   * ONE live row, rewritten in place (screen path only).
   *
   * `note` and `block` APPEND; this REWRITES. A turn that streams — a chat
   * turn's reasoning, a seat's work — must be ONE row that changes, not a
   * wall of rows that pile up. The key identifies the row: the same key
   * rewrites it, a new key starts a new one, and the key must be unique per
   * unit of work (per turn, per run).
   *
   * Absent on classic: a pipe has no screen to rewrite, so the classic path
   * prints its lines as they complete.
   */
  live?(key: string, row: ViewLine): void
  /** Screen path: the composer tag and header follow a new route (model change). */
  routeLabel?(label: string): void
  /**
   * Transcript density — the live screen's mode, which `/display` reads and
   * sets. There is no rail to thin on a pipe, so classic persists the choice
   * for the next session instead of pretending to change the current one.
   */
  display?(mode?: DisplayMode): DisplayMode
  /** Screen path: the session rail's title follows the current task. */
  sessionTitle?(title: string): void
  /**
   * Hermes' pager for a command answer taller than the window: the whole
   * screen becomes the answer, `enter` pages down, `esc/q` closes. A long
   * response no longer floods the transcript and drops off its top. The
   * caller AWAITS it: the pager is modal, like the approval gate.
   */
  page?(title: string, lines: string[]): void | Promise<void>
  /**
   * A yes/no gate for a destructive session action (`/clear`, `/new`),
   * Hermes' confirm grammar: `No, keep going` is the second choice and the
   * cursor starts on it. Absent on the classic/piped path, where a prompt
   * eats the next command.
   */
  confirm?(title: string, detail: string, yesLabel: string): Promise<boolean>
}

/**
 * Columns available for a shaped view.
 *
 * Read from the real terminal when there is one, and pinned to a sane width
 * otherwise — a pipe gets 100 columns, which is what the classic tests assert
 * against, so a shaped view is testable without a TTY.
 */
function viewWidth(): number {
  return isTty() && stdout.columns ? stdout.columns : 100
}

/** A report line's tone: failures red, warnings amber, the rest plain. */
function toneFor(line: string): MsgTone {
  return /FAIL|✗|DOWN|error|not set|missing/i.test(line) ? 'red'
    : /WARN|degraded|○/i.test(line) ? 'yellow'
      : 'plain'
}

/**
 * Emit a multi-line report as per-line rows, so a table keeps its shape and
 * its tones instead of arriving as one slab of prose.
 *
 * The tone comes from the row's own text: a line that names a failure is red,
 * a warning amber, everything else plain. That is the only place a report's
 * meaning is carried in colour, so an operator scanning for problems reads the
 * red without reading every line.
 *
 * Hermes' rule for command output: longer than two lines (or 180 chars) is
 * PAGED, not echoed — `createSlashHandler`'s `long ? page(text) : sys(text)`.
 * A transcript flood was the /tasks complaint: the frame kept only the tail,
 * and the top of the answer could not be read from inside the app at all.
 * The classic/piped path has no pager and prints plain.
 */
function emitBlock(ui: ReplUi, text: string, title?: string): void | Promise<void> {
  const rows = text.split('\n').map(line => ({ text: line, tone: toneFor(line) }))
  if (ui.page && (rows.length > 2 || text.length > 180)) {
    return ui.page(title ?? 'Answer', rows.map(row => row.text))
  }
  ui.block?.(rows)
}

/** Adapt a stored Hermes record to the view's row shape. */
function toTaskRow(task: {
  id: string
  status: string
  engineeringTask: { objective: string }
  result?: { summary?: string; filesChanged?: string[]; tests?: Array<{ passed: boolean }> }
}): TaskRow {
  const tests = task.result?.tests ?? []
  return {
    id: task.id,
    status: task.status,
    objective: task.engineeringTask.objective,
    summary: task.result?.summary,
    filesChanged: task.result?.filesChanged,
    testsPassed: tests.filter(t => t.passed).length,
    testsFailed: tests.filter(t => !t.passed).length,
  }
}

/** Composer/header label for a route id: the basename after the last `/`. */function routeLabelOf(id: string): string {
  const trimmed = id.trim()
  if (!trimmed) return 'auto'
  return trimmed.split('/').pop() || trimmed
}

/** Header meta line for a route label — the shape screenRepl starts with. */
function headerMeta(label: string): string {
  return `mode ${process.env.FACTORY_EXECUTION_MODE ?? 'live'} · ${label}`
}

/** One-line session title from a task objective: first line, cut at a word. */
function sessionTitleFor(objective: string, room = 28): string {
  const first = (objective.split('\n')[0] ?? '').trim()
  if (first.length <= room) return first
  const cut = first.slice(0, room)
  const space = cut.lastIndexOf(' ')
  return `${space > 8 ? cut.slice(0, space) : cut.trimEnd()}…`
}

/**
 * A new route lands in three places at once: the stream gets the durable
 * receipt, the composer tag and the header follow the label, and a toast
 * repeats it — the toast is the ONLY visible receipt on the home page, where
 * `messages` is never drawn. Order matters: `note` pushes a message, and a
 * push clears any live toast, so the toast is set last.
 */
function announceRoute(ui: ReplUi, id: string): void {
  // `label` MUST be initialised before the first use. The old order called
  // `ui.progress?.(`route → ${label}`)` above its own `const`, so EVERY route
  // change on the screen path (typed `/model <id>`, a connect pick, an
  // assignment) threw "Cannot access 'label' before initialization". The
  // classic path has no `progress`, so the optional call never ran there and
  // every test passed — the TTY-only shape of the 2026-11-01 report.
  const label = routeLabelOf(id)
  ui.progress?.(`route → ${label}`)
  ui.note(`route set: ${id}`)
  ui.routeLabel?.(label)
  ui.progress?.(`route → ${label}`)
}

/**
 * The three crew slots, pipeline order (planner → coder → vision). One source
 * for both plates, the profile receipts and the seat prompts, so a seat can
 * never exist in one surface and be missing from another.
 */
const CREW_SEATS: Array<{ env: string; role: CrewRole }> = [
  { env: 'FACTORY_CREW_PLANNER_MODEL', role: 'planner' },
  { env: 'FACTORY_CREW_CODER_MODEL', role: 'coder' },
  { env: 'FACTORY_CREW_VISION_MODEL', role: 'vision' },
]

/** The live seat resolution: `planner X · coder Y · vision Z`. */
function crewSeatLine(): string {
  return CREW_SEATS.map(({ role }) => `${role} ${resolveCrewModel(role)}`).join(' · ')
}

/**
 * The seats this session routes, in pipeline order: the ACTIVE crew first,
 * then the env profile.
 *
 * ONE resolution, read by the banner, the meter and the seat plate. They used
 * to disagree: the banner read the env slots (`qwen2.5-coder-3b-instruct`)
 * while the meter read the stored crew (`gemma-3-4b-it`), so the home page
 * named TWO models for one session and neither could be trusted (operator,
 * 2026-11-04: "the banner says qwen, the meter says gemma").
 *
 * A crew's seats map to the pipeline slots BY POSITION — planner, coder,
 * vision — exactly the way `applyCrew` writes the env slots, so the two can
 * never describe different routings. A crew that does not fill a seat leaves
 * that seat on the env profile, which is the honest reading of "this team has
 * no planner".
 */
export function crewSeatModels(crew: Crew | null = activeCrew(), env: NodeJS.ProcessEnv = process.env): Array<{ role: CrewRole; model: string }> {
  return CREW_SEATS.map(({ role }, index) => {
    const stored = (crew?.seats[index]?.model ?? '').trim()
    return { role, model: stored || resolveCrewModel(role, env) }
  })
}

/**
 * What the status meter's `✦` segment names. Hermes can say one model because
 * it has one; Wednesday routes a pipeline. When every seat resolves to the same
 * model the single id is honest; when they differ the meter says `crew · N
 * seats` rather than picking a seat and claiming the whole run was that model.
 */
export function crewMeterLabel(crew: Crew | null = activeCrew()): string {
  const ids = [...new Set(crewSeatModels(crew).map(({ model }) => model))]
  if (ids.length === 1) return ids[0]!.split('/').pop() || ids[0]!
  if (crew) return `${crew.name} · ${ids.length} seats`
  return `crew · ${ids.length} seats`
}

/**
 * The model plate (design record D3): the models this factory actually routes,
 * composed from live state — the active route plus the crew seats' resolved
 * models (`resolveCrewModel`, so a seat with no env override shows the team
 * default it would really use). Descriptions are each id's name prior from
 * `inferModelCard` — the same cheap "what does this id suggest" the router
 * consults before a probe — so the plate cannot drift from the factory's own
 * belief about a model.
 *
 * No footers, and the seat rows say `planner  <id>` rather than `<id>  planner
 * seat`. At a 100-column terminal the plate inner is 58 (panel = 62), and the
 * old env-name footers pushed the widest rows to 75 — the CLI clipped them
 * mid-word, so the footer that was meant to explain the row was the part
 * destroyed. The role-first seat rows are the same shape the agent plate uses:
 * pick the seat, type the id it should use.
 *
 * Values are discriminated strings: `route:<id>` sets the single route,
 * `seat:<ENV>` opens the private prompt for one crew slot, `custom` asks for an
 * id the plate has never heard of. The old plate made every choice a blind
 * type-in; picking a model ON the plate is the point.
 */
function modelOptions(extraRows: SelectOption[] = []): SelectOption[] {
  const route = (process.env.DSH_LLM_MODEL ?? '').trim()
  const tagline = (id: string): string => inferModelCard(id).tags.join(' · ')
  const known = new Set<string>()
  const routeRows: SelectOption[] = []
  for (const id of [route, ...CREW_SEATS.map(({ role }) => resolveCrewModel(role))]) {
    if (!id || known.has(id)) continue
    known.add(id)
    routeRows.push({
      title: id,
      desc: `${tagline(id)}${id === route ? ' · active' : ''}`,
      value: `route:${id}`,
    })
  }
  // Teams (2026-10-30, teams are the product): every named crew the operator
  // built, with the active one marked. A pick selects THE TEAM — all its
  // seats move into the pipeline slots at once; that is `/model select team`.
  const crews = loadCrews()
  const teamRows: SelectOption[] = crews.crews.map(crew => ({
    title: crew.name,
    // The seat count says how many ROUTE, not just how many exist: only the
    // first three seats map to a pipeline slot, so a six-seat team is three
    // routing seats and three display seats. "6 seats" alone overstated what
    // a run would use (operator, 2026-11-04).
    desc: `${crewMeterName(crew)} (${crewSeatSummary(crew)})${crew.id === crews.active ? ' · active' : ''}`,
    value: `crew:${crew.id}`,
  }))
  return [
    selectSection('Teams'),
    ...(teamRows.length > 0 ? teamRows : [{ title: 'No teams yet', desc: '/create builds one', value: 'noop-teams' }] as SelectOption[]),
    ...extraRows,
    selectSection('Route'),
    ...routeRows,
    { title: 'Enter a model id…', desc: 'custom — prefix openrouter/ nvidia/ zen/ local/ to pick the provider', value: 'custom' },
    selectSection('Crew seats'),
    // Pipeline order and role-first, same as the agent plate's seat section.
    ...CREW_SEATS.map(({ env, role }) => ({
      title: role,
      desc: resolveCrewModel(role),
      value: `seat:${env}`,
    })),
  ]
}

/**
 * "Local servers (auto-detected)" rows for the /model plate: one row per model
 * on every loopback server that answered a read-only GET /models this session.
 * The scan runs once and is cached; deterministic mode skips it (no network).
 * Value shape: `local::<baseURL>::<model>` — the `::` split survives both the
 * port colon in the URL and `:tag` suffixes in ollama model names.
 */
/**
 * A configured connection, as the model list sees it.
 *
 * `/connect` saves a provider + base URL + key into `~/.wednesday/.env`; the
 * picker used to show only the ONE active route model, so "connect an API key,
 * then choose which model does what" was impossible from the TUI — the same
 * hole opencode's `/models` fills. This enumerates every provider the profile
 * can actually reach. Pure over env so the row-building is testable offline.
 */
export interface ConfiguredConnection {
  label: string
  kind: 'local' | 'openrouter' | 'nvidia'
  baseURL: string
  apiKey: string
  /** Prefix a row's model id needs so the router sends it to this provider. */
  prefix: string
}

export function configuredConnections(env: NodeJS.ProcessEnv = process.env): ConfiguredConnection[] {
  const out: ConfiguredConnection[] = []
  const localBase = (env.LOCAL_LLM_BASE_URL ?? '').trim()
  if (localBase) {
    out.push({ label: 'local (your tunnel / server)', kind: 'local', baseURL: localBase.replace(/\/+$/, ''), apiKey: (env.LOCAL_LLM_API_KEY ?? '').trim() || 'local', prefix: '' })
  }
  const openrouter = (env.OPENROUTER_API_KEY ?? '').trim()
  if (openrouter) {
    out.push({ label: 'OpenRouter', kind: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: openrouter, prefix: 'openrouter/' })
  }
  const nvidia = (env.NVIDIA_API_KEY ?? '').trim()
  if (nvidia) {
    out.push({ label: 'NVIDIA NIM', kind: 'nvidia', baseURL: ((env.NVIDIA_BASE_URL ?? '').trim() || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''), apiKey: nvidia, prefix: 'nvidia/' })
  }
  return out
}

/** Row cap per connection: the plate filters by typing, but it must open fast. */
const CONNECTION_MODEL_CAP = 200

/**
 * Drop the cached model lists. `/connect` changes what the connections CAN
 * serve, and a module-level cache outlives the flow: without this, a provider
 * connected mid-session never appeared in `/model` until the app restarted —
 * the exact "connect a key, then pick a model" loop the operator asked for.
 */
export function resetModelCaches(): void {
  cachedConnectionRows = null
  cachedLocalRows = null
}

async function fetchConnectionModels(connection: ConfiguredConnection, timeoutMs = 2500): Promise<string[]> {
  const { fetch } = await import('undici')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${connection.baseURL}/models`, {
      headers: { authorization: `Bearer ${connection.apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) return []
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? []).map(entry => (typeof entry.id === 'string' ? entry.id : '')).filter(Boolean)
    // A hosted catalogue is alphabetical, so the operator's ACTIVE models can
    // sit 200 rows down. Float the session's own ids to the top, then keep a
    // bounded list — the plate filters, but it must open without a wait.
    const used = new Set(
      [process.env.DSH_LLM_MODEL, ...CREW_SEATS.map(({ role }) => resolveCrewModel(role))]
        .map(id => (id ?? '').trim())
        .filter(Boolean),
    )
    const rank = (id: string): number => (used.has(id) || used.has(`${connection.prefix}${id}`) ? 0 : 1)
    return ids.sort((a, b) => rank(a) - rank(b)).slice(0, CONNECTION_MODEL_CAP)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

let cachedConnectionRows: SelectOption[] | null = null
/**
 * "Models · <connection>" rows: every model every configured connection lists.
 * Values are `assign:<model-id>`, a DIFFERENT verb from `route:` — picking one
 * asks which role should use it, which is the thing the operator asked for.
 */
async function connectionModelRows(): Promise<SelectOption[]> {
  if (cachedConnectionRows) return cachedConnectionRows
  const rows: SelectOption[] = []
  if ((process.env.FACTORY_EXECUTION_MODE ?? '').trim().toLowerCase() === 'deterministic') {
    cachedConnectionRows = rows
    return rows
  }
  const connections = configuredConnections()
  if (connections.length === 0) return (cachedConnectionRows = rows)
  const discovered = await Promise.all(connections.map(async connection => ({
    connection,
    models: await fetchConnectionModels(connection),
  })))
  for (const { connection, models } of discovered) {
    rows.push(selectSection(`Models · ${connection.label}${models.length ? ` (${models.length})` : ''}`))
    if (models.length === 0) {
      rows.push({ title: 'no models listed', desc: `${connection.baseURL} answered nothing — is it running?`, value: 'noop-models' })
      continue
    }
    for (const model of models) {
      // No repeated description: the row already reads as "pick me", and a
      // 40-char id plus a 30-char sentence was clipped on a real 120-column
      // terminal. The footer names the provider instead.
      rows.push({
        title: `${connection.prefix}${model}`,
        footer: connection.kind,
        value: `assign:${connection.prefix}${model}`,
      })
    }
  }
  cachedConnectionRows = rows
  return rows
}

/**
 * Which role should a picked model drive? This is the whole point of the
 * connection list: Wednesday used to fill planner/coder/vision on its own, so
 * the operator could see three seats and control none of them.
 */
async function assignPickedModel(ui: ReplUi, modelId: string): Promise<void> {
  const short = routeLabelOf(modelId)
  const options: SelectOption[] = [
    { title: 'All roles', desc: 'planner · coder · vision — one model does everything', value: 'all' },
    ...CREW_SEATS.map(({ env, role }) => ({ title: `${role} role`, desc: resolveCrewModel(role), footer: 'seat', value: `seat:${env}` })),
    { title: 'Route only', desc: 'the session route; seats keep their own models', value: 'route' },
  ]
  const target = ui.select ? await ui.select(`Use ${short} for`, options) : 'all'
  ui.redraw?.()
  if (target === undefined) return
  if (target === 'all') {
    // Route + every seat, so the operator's pick is what actually runs. The
    // env seats win over the crew default, which is why ALL of them move.
    const prefix = PROVIDER_PREFIXES.find(p => modelId.startsWith(`${p}/`))
    if (prefix !== undefined) {
      process.env.FACTORY_LLM_PROVIDER = prefix
      process.env.DSH_LLM_PROVIDER = prefix
      process.env.DSH_LLM_MODEL = modelId.slice(prefix.length + 1)
    } else {
      process.env.DSH_LLM_MODEL = modelId
    }
    // The stored team is what chat and the meter actually read:
    // `activeCrew().seats[0]` picks the conversational model and
    // `crewMeterName` names the meter. Moving only the env left the operator's
    // pick honoured for the PIPELINE while the screen kept naming (and chat
    // kept calling) the old model — "qwen is always selected" was this split.
    // Move the active team's seats with the pick so one fact drives all three.
    const crew = activeCrew()
    if (crew) updateCrew(crew.id, { seats: crew.seats.map(seat => ({ ...seat, model: modelId })) })
    for (const { env } of CREW_SEATS) process.env[env] = modelId
    ui.crewChanged?.()
    ui.note(`all roles → ${modelId}`)
    // Only print the seat breakdown when the seats actually DIFFER: for the
    // all-roles pick it repeated the same id three times above `route set`
    // (operator screenshot, 2026-11-04: three identical long lines).
    if (new Set(CREW_SEATS.map(({ role }) => resolveCrewModel(role))).size > 1) ui.note(crewSeatLine())
    announceRoute(ui, modelId)
    return
  }
  if (target === 'route') {
    process.env.DSH_LLM_MODEL = modelId
    announceRoute(ui, modelId)
    return
  }
  if (target.startsWith('seat:')) {
    const env = target.slice('seat:'.length)
    const slot = CREW_SEATS.findIndex(entry => entry.env === env)
    const role = CREW_SEATS[slot]?.role ?? 'seat'
    // Same split as "all roles": update the stored team's matching seat when
    // it has one, so the meter and the conversational seat see the pick too.
    const crew = activeCrew()
    if (crew && slot >= 0 && crew.seats[slot]) {
      updateCrew(crew.id, { seats: crew.seats.map((seat, i) => i === slot ? { ...seat, model: modelId } : seat) })
    }
    process.env[env] = modelId
    ui.crewChanged?.()
    ui.note(`${role} role → ${modelId}`)
    ui.note(crewSeatLine())
    return
  }
}

let cachedLocalRows: SelectOption[] | null = null
async function localServerRows(): Promise<SelectOption[]> {
  if (cachedLocalRows) return cachedLocalRows
  const rows: SelectOption[] = []
  if ((process.env.FACTORY_EXECUTION_MODE ?? '').trim().toLowerCase() !== 'deterministic') {
    const { detectLocalServers } = await import('./local-discovery')
    const servers = await detectLocalServers(700)
    for (const server of servers) {
      for (const model of server.models.slice(0, 12)) {
        rows.push({ title: model, desc: server.label, footer: 'local', value: `local::${server.baseURL}::${model}` })
      }
    }
  }
  cachedLocalRows = rows.length > 0 ? [selectSection('Local servers (auto-detected)'), ...rows] : []
  return cachedLocalRows
}

/**
 * Advisories that must not stand between the operator and the UI — see
 * `StartupAdvisories` in screen.ts, which owns the reporting policy.
 */
async function repl(args: string[], bus: PersistentFactoryEventBus, ask: Ask, classic = false, advisories: StartupAdvisories = {}): Promise<void> {
  // `--resume [id]` is a screen-path flag: it is removed before parseFlags,
  // which only knows the run flags. A bare `--resume` picks the newest saved
  // session; an unknown id starts fresh and says so rather than failing.
  let resume: import('./session-store').StoredSession | null = null
  const resumeAt = args.indexOf('--resume')
  if (resumeAt >= 0) {
    const next = args[resumeAt + 1]
    const wanted = next && !next.startsWith('--') ? next : null
    args = [...args.slice(0, resumeAt), ...args.slice(resumeAt + (wanted ? 2 : 1))]
    if (isTty() && !classic) {
      const { loadSession, latestSession } = await import('./session-store')
      resume = wanted ? loadSession(wanted) : latestSession()
      if (!resume) {
        console.error(wanted ? `No saved session: ${wanted} — starting fresh.` : 'No saved sessions yet — starting fresh.')
      }
    }
  }
  const defaults = parseFlags(args)
  if (!(await stat(defaults.workspace)).isDirectory()) throw new Error('Workspace must be a directory.')
  if (isTty() && !classic) {
    await screenRepl(defaults, bus, advisories, resume)
    return
  }
  console.log(banner())
  const ui: ReplUi = {
    ask,
    approve: task => approve(task, ask, classic),
    note: text => console.log(text),
    error: text => console.error(text),
    // A pipe gets the same SHAPE as the screen (views.ts), without the colour:
    // one `status: line` per row keeps it greppable, which raw JSON was not.
    block: lines => {
      for (const line of lines) console.log(line.text)
    },
    // On a pipe there is no screen state to clear, so /clear is a receipt and
    // nothing else — pretending to clear anything here would be a lie.
    clearSession: () => {},
    // A pipe has no rail to thin, but the choice is durable: /display here
    // saves the density the next live session starts with.
    display: mode => (mode ? saveDisplay(mode) : loadDisplay()),
  }
  // First-run onboarding (2026-10-31): a machine with no config and no flag
  // gets the guided setup once — connect, then solo model or team — before
  // the first prompt. Existing operators are marked silently, never re-shown.
  if (stdin.isTTY) {
    const { maybeOnboard } = await import('./onboarding')
    await maybeOnboard(ui, {
      createTeamImpl: async u => { await crewCreateFlow(u as ReplUi) },
      modelPickImpl: async u => {
        resetModelCaches()
        const choice = u.select ? await u.select('Pick a model to start with', modelOptions([...(await connectionModelRows()), ...(await localServerRows())])) : undefined
        if (choice) await handleModelChoice(u as ReplUi, choice)
      },
    })
  }
  await replLoop(defaults, bus, ui, undefined)
}

/** Command palette entries (opencode palette grammar over our verbs). */
export const PALETTE: SelectOption[] = [
  { title: '/help', desc: 'this help', footer: 'commands', value: '/help' },
  { title: '/connect', desc: 'provider · tunnel · local models · probe · save', footer: 'connect', value: '/connect' },
  { title: '/create', desc: 'create a team (name + model per seat)', footer: 'create', value: '/create ' },
  { title: '/status', desc: 'route · model · pool · shape', footer: 'status', value: '/status' },
  { title: '/doctor', desc: 'readiness check, read-only', footer: 'doctor', value: '/doctor' },
  { title: '/stats', desc: 'token usage this session', footer: 'stats', value: '/stats' },
  { title: '/display', desc: 'transcript density: quiet · normal · verbose', footer: 'display', value: '/display ' },
  { title: '/debug', desc: 'live route · seats · paths', footer: 'debug', value: '/debug' },
  { title: '/update', desc: 'check npm; offer to install the pinned newer release', footer: 'update', value: '/update' },
  { title: '/onboard', desc: 'run the first-run setup again', footer: 'onboard', value: '/onboard' },
  { title: '/proof', desc: 'one tiny real task — proves the route a build uses', footer: 'proof', value: '/proof' },
  { title: '/clear', desc: 'clear the session', footer: 'clear', value: '/clear' },
  { title: '/new', desc: 'start a fresh session', footer: 'new', value: '/new' },
  { title: '/q', desc: 'leave the harness', footer: 'exit', value: '/q' },
  { title: '/agents', desc: 'crew profile · seat models', footer: 'agents', value: '/agents' },
  { title: '/crew', desc: 'list · select · edit · delete teams', footer: 'crew', value: '/crew' },
  { title: '/model', desc: 'all models from all connections · pick a role for one', footer: 'model', value: '/model ' },
  { title: '/tasks', desc: 'list persisted Hermes tasks', footer: 'tasks', value: '/tasks' },
  { title: '/result', desc: 'inspect a stored task and result', footer: '<id>', value: '/result ' },
  { title: '/events', desc: 'inspect persisted Factory events', footer: '<id>', value: '/events ' },
  { title: '/run', desc: 'preview and approve a queued/failed task', footer: '<id>', value: '/run ' },
  { title: '/review', desc: 'review the workspace diff', footer: 'review', value: '/review' },
  { title: '/health', desc: 'factory health meter + history', footer: 'health', value: '/health' },
  { title: '/exit', desc: 'leave the harness', footer: 'exit', value: '/exit' },
]

/**
 * Palette rows a typed prefix can land on, best first.
 *
 * Deliberately the SAME matcher the live plate uses (`selectMatching`): before
 * 2026-11-04 there were two, and they disagreed. Pressing Enter before the
 * plate finished opening took the typed-query path and ranked `/review` first;
 * pressing it after the plate opened took the plate path, which preserved
 * PALETTE order and put `/run` first because its description says "preview".
 * One matcher means one answer, whichever beat the other.
 *
 * The list is also the gate: empty means "this is not a command", and the
 * dispatcher's own unknown-verb error is the honest answer — never a modal
 * that swallows the next keystroke (the trap that made every command after
 * `/review` look dead).
 */
function paletteMatches(query: string): SelectOption[] {
  const q = query.trim()
  if (!q) return PALETTE.slice()
  return selectMatching(PALETTE, q, PALETTE.length + 16)
}

/**
 * Agent picker rows (design frame G3): the crew profile picker AND the live
 * seat resolution, because choosing a profile without seeing the seats is
 * choosing blind. Profile rows describe the shape (a footer would clip: the
 * plate is 62 columns wide at a 100-column terminal); seat rows carry what the
 * role resolves to RIGHT NOW plus `set`/`default` provenance — the piece an env
 * name alone cannot tell, since a cleared vision slot still resolves. Picking a
 * seat opens the same private prompt as the model plate's seat rows.
 */
function agentOptions(): SelectOption[] {
  return [
    selectSection('Crew profiles'),
    { title: 'trio', desc: 'planner + coder + vision (default)', value: 'trio' },
    { title: 'duo', desc: 'planner + coder, vision cleared', value: 'duo' },
    selectSection('One model'),
    { title: 'solo', desc: 'one model fills every role', value: 'solo' },
    selectSection('Seats now'),
    ...CREW_SEATS.map(({ env, role }) => ({
      title: role,
      desc: resolveCrewModel(role),
      footer: (process.env[env] ?? '').trim() ? 'set' : 'default',
      value: `seat:${env}`,
    })),
  ]
}

/**
 * Apply a crew profile to the session's model slots. The receipt is the LIVE
 * seat resolution after the change: the old `seats on <route>` was only true
 * when every seat was unset — trio keeps existing overrides (`||=`), and duo's
 * cleared vision slot still resolves to the trio default — so the receipt names
 * what the session will really use. `applied` gates the toast: "nothing to
 * distribute" is not a change.
 */
function applyAgentProfile(profile: string): { note: string; applied: boolean } {
  const route = process.env.DSH_LLM_MODEL ?? ''
  if (!route) return { note: 'no DSH_LLM_MODEL set — nothing to distribute', applied: false }
  if (profile === 'solo') {
    for (const { env } of CREW_SEATS) process.env[env] = route
    return { note: `crew: solo · every seat → ${route}`, applied: true }
  }
  if (profile === 'duo') {
    delete process.env.FACTORY_CREW_VISION_MODEL
    return { note: `crew: duo · vision slot cleared (falls back to ${resolveCrewModel('vision')})`, applied: true }
  }
  for (const { env } of CREW_SEATS) process.env[env] ||= route
  return { note: `crew: trio · ${crewSeatLine()}`, applied: true }
}

/**
 * The empty session composer's invitation (Hermes' own string). The home page
 * shows an example request instead; once the session starts, the prompt says
 * what to type next.
 */
const BROWSE_HINT = 'Type / to browse commands, or Ctrl+P for the palette'

/**
 * The two words that END a session. Their receipt is the exit card, so they
 * are never echoed into the transcript — a saved `✦ /q` row came back as a
 * stale line on every `--resume`. Exported so the dispatch test can pin the
 * contract instead of trusting a name that only exists at runtime (the first
 * version of this helper was referenced but never defined: every typed line
 * in the TUI died with `isExitCommand is not defined`).
 */
export function isExitCommand(line: string): boolean {
  const verb = line.trim().split(/\s+/)[0] ?? ''
  return verb === '/q' || verb === '/exit'
}

/**
 * The session facts `/status` shows, derived from the screen state.
 *
 * Extracted rather than inlined so the live UI and the dispatch test run the
 * SAME function. The first version of this closure referenced `running`, the
 * classic REPL's abort controller, which is not in this function's scope: every
 * pure render test passed, and `/status` answered `error: running is not
 * defined` the moment it was typed in a real TUI. A named function cannot make
 * that mistake silently — the missing name is a compile error here, and the
 * dispatch test executes this exact body.
 */
export function screenStatusContext(
  state: { side?: { tokens?: number } | null; busy: boolean },
  sessionId: string,
  path?: string,
): { sessionId: string; tokens: number; busy: boolean; path?: string } {
  return { sessionId, tokens: state.side?.tokens ?? 0, busy: state.busy, path }
}

async function screenRepl(defaults: ReturnType<typeof parseFlags>, bus: PersistentFactoryEventBus, advisories: StartupAdvisories = {}, resume: import('./session-store').StoredSession | null = null): Promise<void> {
  const screen = new Screen()
  // The ACTIVE crew is what this session routes through. It used to be applied
  // only when the operator picked it from the plate, so a session started with a
  // team marked active but ran the env profile instead: the meter named the
  // team, the pipeline used another model, and the run read as fiction
  // (operator, 2026-11-04). The crew wins — it is the explicit choice — and
  // the env profile fills only the seats the crew leaves open.
  {
    const crew = activeCrew()
    if (crew) applyCrew(crew)
  }
  // Short model label for the composer tag. The full route/model/workspace
//  line lives in the header; repeating it in the box reads as noise.
  const modelLabel = routeLabelOf(process.env.DSH_LLM_MODEL ?? 'auto')
  const meta = headerMeta(modelLabel)
  const state = initialState(wednesdayCompact(), meta)
  state.composerLabel = modelLabel
  state.crewLabel = crewMeterLabel()
  // The commands the operator used this session, most recent first. Recency
  // is a TIE-BREAK in the completion, never an override: a command that does
  // not match the query never surfaces, however often it was used.
  const recentCommands: string[] = []
  // The composer completes WHILE YOU TYPE (ported from qwen-code): the
  // command list, the workspace file index and the recency are the three
  // inputs the engine needs. The engine itself is pure — this is the only
  // place that knows about the world.
  state.completionCommands = COMMAND_SPECS
  state.completionFiles = fileIndex(defaults.workspace)
  state.completionRecent = recentCommands
  // Session identity (Hermes' `Session: 20261024_191508_5024ed` line): stamped
  // once, shown in the capability rail, so a screenshot of a session can be
  // told apart from another five minutes later.
  const sessionId = resume?.id ?? `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}_${Math.random().toString(16).slice(2, 8)}`
  // The invitation (Hermes' composer grammar): the empty box shows an example,
  // not a label. Rotated once per session, so the first screen teaches what to
  // type without a tutorial.
  const EXAMPLES = [
    'What changed in this repo recently?',
    'Add a note to the README explaining the project',
    'Find the failing test and fix it',
  ]
  state.placeholder = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]
  // Identity the banner shows (Hermes' version title, model line, session
  // stamp). Stamped once: a screenshot can be told apart from another session.
  const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
  state.bannerTitle = `wednesday ${pkg.version ?? ''}`.trim()
  state.sessionId = sessionId
  state.startedAt = Date.now()
  state.turnStartedAt = null
  state.turnMs = 0
  // One tip, chosen at startup (Hermes' Tip line): it never flickers, and the
  // list only holds things the product actually does.
  const TIPS = [
    '/connect points at a provider, tunnel, or local server — then probes and saves',
    '/create builds a named team · /model <team name> selects it',
    'type while a run is live to queue the next request',
    '/review shows what changed in the workspace',
    'esc interrupts a live run · ctrl+c twice exits',
    '/stats shows the tokens this session spent',
    '/result <id> reads a finished task back',
  ]
  state.tip = TIPS[Math.floor(Math.random() * TIPS.length)]
  // Context ceiling for the active route. Dynamic: a user-set
  // FACTORY_CONTEXT_LIMIT (or LOCAL_LLM_CONTEXT_LIMIT) wins, so a paid user
  // hosting a larger model gets its real window. Otherwise the local route
  // defaults to the dev model's 13,312 and other routes report unknown (0)
  // until the model answers with a context size. Wednesday never imposes its
  // own cap; the limit is the model's.
  const contextLimit = (): number => {
    const override = Number(
      process.env.FACTORY_CONTEXT_LIMIT ?? process.env.LOCAL_LLM_CONTEXT_LIMIT ?? '',
    )
    if (Number.isFinite(override) && override > 0) return override
    return (process.env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() === 'local'
      ? 13312
      : 0
  }
  /**
   * The banner's right column (Hermes' capability grid, Wednesday's data): what
   * this session can actually do — the crew it will route to and the commands
   * it answers, with a summary line that says how many of each. The harness
   * builds it because only this layer knows what is true; refresh it whenever
   * the truth changes (/model, /connect, /agents).
   */
  const capabilityRows = (): Array<{ text: string; tone: MsgTone }> => {
    const short = (id: string): string => id.split('/').pop() ?? id
    // The right column's real width (screen.ts owns the number). Rows are built
    // to FIT it: a renderer's hard clip cuts a model name mid-word and the
    // panel then reads as corrupted (`qwen2.5-coder-3b-i`).
    const railW = Math.max(20, bannerColumns(stdout.columns ?? 80).right)
    /** Shorten a MODEL id at a version boundary, never mid-word. */
    const fitModel = (model: string, room: number): string => {
      if (model.length <= room) return model
      const cut = model.slice(0, Math.max(2, room - 1))
      const boundary = cut.lastIndexOf('-')
      return `${(boundary > 2 ? cut.slice(0, boundary) : cut).slice(0, Math.max(2, room - 1))}…`
    }
    /** `label: a, b, c, +N more` — packed to the column, never clipped. */
    const pack = (label: string, names: string[]): { text: string; tone: MsgTone } => {
      const head = `${label}: `
      let line = ''
      for (let i = 1; i <= names.length; i++) {
        const hidden = names.length - i
        const candidate = `${head}${names.slice(0, i).join(', ')}${hidden ? `, +${hidden} more` : ''}`
        if (candidate.length > railW) break
        line = candidate
      }
      return { text: line || `${head}…`, tone: 'dim' }
    }
    // Grouped the way Hermes groups toolsets: by what the operator is trying
    // to do, not alphabetically. Anything /help lists that no group names is
    // appended to `work`, so the banner can never advertise fewer commands
    // than the help page does.
    const groups: Array<[string, string[]]> = [
      ['session', ['/status', '/doctor', '/stats', '/display', '/debug', '/compact', '/clear', '/new', '/q']],
      ['setup', ['/connect', '/create', '/model', '/agents', '/crew', '/onboard']],
      ['work', ['/tasks', '/result', '/events', '/run', '/review', '/health']],
      ['system', ['/update']],
      ['help', ['/help']],
    ]
    const named = new Set(groups.flatMap(([, names]) => names))
    for (const [name] of HELP_COMMANDS) {
      if (name.startsWith('/') && !named.has(name)) groups[2]![1].push(name)
    }
    const verbs = HELP_COMMANDS.filter(([name]) => name.startsWith('/')).length
    // When every seat resolves to the SAME model, three identical rows say
    // nothing extra and made the operator think the factory had assigned roles
    // on his behalf. One line says the truth: one model fills all roles.
    // The seats come from `crewSeatModels` — the ACTIVE crew first — so the
    // banner and the meter can never name two different models.
    const seatModels = crewSeatModels().map(({ role, model }) => ({ role, model: short(model) }))
    const uniqueSeats = [...new Set(seatModels.map(seat => seat.model))]
    const activeTeam = activeCrew()
    const crewRows = uniqueSeats.length === 1
      ? [{ text: `crew: ${fitModel(uniqueSeats[0]!, railW - 6)} — ${activeTeam ? `${activeTeam.name} · ` : ''}all roles`, tone: 'dim' as MsgTone }]
      : seatModels.map(seat => ({
        text: `${seat.role}: ${fitModel(seat.model, railW - seat.role.length - 2)}`,
        tone: 'dim' as MsgTone,
      }))
    return [
      { text: 'Available Crew', tone: 'plain' },
      ...crewRows,
      { text: '', tone: 'plain' },
      { text: 'Available Commands', tone: 'plain' },
      ...groups.map(([label, names]) => pack(label, names)),
      { text: '', tone: 'plain' },
      // The footer is the ONE row built without the `pack` helper, and it used
      // to run past the rail: on a 120-column terminal it printed
      // `/help for comman` and stopped. Drop whole segments instead of cutting
      // a word, the same rule the catalog rows follow.
      { text: (() => {
        const bits = [
          `${verbs} commands`,
          uniqueSeats.length === 1 ? '1 model · 3 roles' : `${CREW_SEATS.length} crew seats`,
          '/help',
        ]
        let fitted = ''
        for (let i = 1; i <= bits.length; i++) {
          const candidate = bits.slice(0, i).join(' · ')
          if (candidate.length > railW) break
          fitted = candidate
        }
        return fitted || `${verbs} commands`
      })(), tone: 'dim' },
    ]
  }  /**
   * Show the right rail's content that belongs to the CURRENT page: the home
   * page carries capabilities (the Hermes banner arms it from the first frame),
   * the session view carries the ledger. Refresh on every truth change.
   */
  const refreshRail = (): void => {
    if (!state.side) return
    if (state.home) state.side.rows = capabilityRows()
    else state.side.rows = undefined
    screen.render(state)
  }
  // The rail is armed AT STARTUP now: a capability panel is not a receipt for
  // work that did not happen (that was the old objection to a "0 tokens"
  // panel) — it says what the session IS, the way the Hermes banner lists
  // tools and skills before the first message. The Context ledger takes over
  // with the first request. A resumed session starts where it stopped: the
  // transcript is on screen and the ledger is already spending.
  state.side = resume
    ? { title: 'session', tokens: resume.tokens, limit: contextLimit() }
    : { title: 'wednesday', tokens: 0, limit: contextLimit(), rows: capabilityRows() }
  const history: string[] = []
  if (resume) {
    state.home = false
    state.messages = resume.messages.slice(-200)
    state.placeholder = BROWSE_HINT
    state.composerLabel = resume.composerLabel ?? modelLabel
    state.crewLabel = resume.crewLabel ?? crewMeterLabel()
    state.meta = headerMeta(state.composerLabel)
    // Up-arrow recall is part of what "resume" means: the requests you typed
    // last time are the ones you are most likely to repeat.
    for (const message of state.messages) {
      if (!message.text.startsWith('❯ ')) continue
      const typed = message.text.slice(2)
      if (history[history.length - 1] !== typed) history.push(typed)
    }
  }
  screen.enter()
  // A throw that escapes the awaited chain — a timer callback, a floating
  // promise — dies OUTSIDE the try/finally below with the terminal still in
  // the alternate screen and raw mode on: the frame freezes, keys echo
  // nowhere, Ctrl+C is one more byte nobody reads. That is the 2026-10-16
  // "so freez" report. Whatever the crash turns out to be, it must never be
  // allowed to read as a dead terminal again (see installFatalGuard).
  const stopFatalGuard = installFatalGuard({
    quiet: () => { state.busy = false },
    restore: () => {
      try { stdin.setRawMode(false) } catch { /* the screen path implies a TTY; a stub must not break the guard */ }
      screen.exit()
    },
    report: error => {
      // A fatal stack can carry a provider URL, a request body or a token in
      // an error message. Redact before it reaches the operator's terminal.
      const detail = error instanceof Error && error.stack ? error.stack : String(error)
      console.error(redactSensitiveText(detail))
      console.error('The terminal was restored — the session hit an error and stopped.')
    },
    trace: traceNote,
  })
  // The UI exists first; the meter and the registry check land whenever they
  // land, each reporting through the screen.
  runAdvisories(screen, state, advisories)
  // Home page (opencode start-page grammar): centred crest, centred composer,
  // one footer line. The first request clears it and the stream takes over.
  // A RESUMED session is not on the home page: forcing `home = true` here threw
  // away the transcript the block above had just restored (and `onHome = true`
  // made the first new request clear it), so `--resume` opened the start page
  // with the old session's id on the banner.
  state.home = resume === null
  state.status = ''
  let onHome = resume === null

  /**
   * The first real request leaves the start page. The guard at BOTH call sites
   * is `onHome || state.home`, not the flag alone: `/new` sets `state.home`
   * through `clearSession` while the flag stayed false, so the first message
   * after `/new` was dispatched with the home page still painted — the echo,
   * the thinking and the answer all went to a transcript that page never draws
   * (operator report 2026-11-04: "/new then type hi, nothing happens, still lag
   * in home screen").
   */
  const leaveHome = (): void => {
    onHome = false
    leaveHomeCard(state, contextLimit())
  }
  /**
   * What to do with a row picked out of the command plate.
   *
   * A pick that is a COMPLETE verb runs immediately: pressing Enter on `/tasks`
   * in the plate used to only drop the text into the composer, so the command
   * appeared to need a second Enter before anything happened — reported as
   * "I have to press Enter twice". Only verbs that take an argument (their
   * value ends in a space) hand control back to the composer, because there is
   * nothing left to press Enter for.
   *
   * Returns undefined only when the operator cancels the argument with Ctrl+C,
   * which the caller turns into "back to the composer", never "leave".
   */
  const acceptPick = async (pick: string): Promise<string | undefined> => {
    const complete = !pick.endsWith(' ') && PALETTE.some(entry => entry.value === pick)
    if (complete) return pick
    state.input = pick
    state.cursor = pick.length
    // A command's ARGUMENT is text the app runs (a path, an id, a URL), so a
    // paste there stays raw: a collapsed label in its place would be a broken
    // value, not a tidier one.
    return screen.readLine(state, history, { ctrlC: 'cancel', paste: 'raw' })
  }
  /**
   * A command typed INTO an overlay that is not the overlay's own list.
   *
   * Picking `/model` and then typing `/exit` must leave the picker and leave
   * the session, not append `/exit` to a model filter forever. The overlay
   * returns the line; this queue hands it to the very next `ask` without
   * inventing a second dispatch path.
   */
  let queuedCommand: string | undefined
  /** Requests composed while a run is live; dispatched one per turn, in order. */
  const queuedRequests: string[] = []
  /** One configuration line: prompt in the status, no history, no echo. */
  const readConfigLine = async (prompt?: string): Promise<string | undefined> => {
    for (;;) {
      state.status = prompt ?? ''
      // A configuration value is USED, not read: a model id, a base URL, a
      // credential. A paste there stays raw — no label, no framing — because
      // a collapsed label in a value the app is about to use is a wrong value.
      const value = await screen.readLine(state, [], { ctrlC: 'cancel', paste: 'raw' })
      if (value === undefined && screen.pendingPalette) {
        screen.pendingPalette = false
        screen.render(state)
        continue
      }
      state.status = ''
      // A configuration prompt must not eat a command: typing `/exit` at a
      // "model id" prompt used to be validated as a model id. Queue it and
      // cancel the prompt instead.
      if (value !== undefined && value.trim().startsWith('/')) {
        queuedCommand = value.trim()
        return undefined
      }
      return value
    }
  }
  const ui: ReplUi = {
    // Hints replace the prompt in the status line (opencode footer grammar):
    // showing "wednesday> " there duplicated the composer box.
    ask: async () => {
      // Loop, not straight-line: Esc inside the palette means "cancel this
      // overlay", never "leave the session" (caught in a pty capture — the
      // old `return undefined` killed the run on a dismissed palette).
      for (;;) {
        // An overlay escaped with a typed command lands here first: show the
        // same receipt a typed line gets, then dispatch it.
        if (queuedCommand) {
          const command = queuedCommand
          queuedCommand = undefined
          state.status = ''
          if (onHome || state.home) leaveHome()
          // An exit command is never seen as an echo: the card replaces the
          // screen in the same breath. Saving it only made `--resume` replay a
          // `✦ /q` row from the previous session.
          if (!isExitCommand(command)) {
            state.scroll = 0 // submitting returns to the live tail
            // The same echo grammar as the live composer: a command wears the
            // house star in cyan, so the operator's own line is findable.
            screen.push(state, { text: `${glyph('star')} ${command}`, tone: 'cyan' })
          }
          return command
        }
        if (queuedRequests.length) {
          const request = queuedRequests.shift()!
          state.status = ''
          state.queued = [...queuedRequests]
          // A request typed DURING a live run may carry a paste. It is framed
          // here — at dispatch, not at queue time — so the payload the map
          // holds is the one the model receives.
          const framed = framePasteExpansion(request, screen.pendingPastes)
          if (history[history.length - 1] !== framed) history.push(framed)
          state.scroll = 0 // submitting returns to the live tail
          // The echo shows the COLLAPSED form: the operator's line stays one
          // readable line instead of a wall of pasted text.
          screen.push(state, { text: `❯ ${request.trim()}`, tone: 'bold' })
          return framed
        }
        state.status = state.busy ? BUSY_HINTS : COMPOSER_HINTS
        let value = await screen.readLine(state, history)
        // Ctrl+P sets the flag and returns undefined — reopen with the
        // palette up front. A lone `/` does the same (typed form).
        if (value === undefined && screen.pendingPalette) {
          screen.pendingPalette = false
          screen.render(state)
          traceNote('palette.open via=ctrl+p')
          const pick = await runSelect(stdout, stdout.columns ?? 80, stdout.rows ?? 24, 'Commands', PALETTE, () => screen.frame(state), '', screen, recentCommands)
          traceNote(`palette.pick ${pick === undefined ? '(dismissed)' : JSON.stringify(pick)}`)
          screen.render(state)
          if (pick === undefined) continue // back to the composer
          value = await acceptPick(pick)
          // Ctrl+C while filling in an argument cancels the pick; it must not
          // read as "the session ended", which is what an undefined return
          // means to the REPL loop below.
          if (value === undefined) {
            state.input = ''
            state.cursor = 0
            continue
          }
        }
        // The draft as the operator left it: a paste is still a LABEL here.
        // The label becomes raw text or framed material depending on what the
        // line turns out to be — a COMMAND runs its argument, a REQUEST hands
        // it to the model.
        const draft = value?.trim() ?? ''
        if (draft.startsWith('/')) {
          // A command's argument is something the app USES: the payload goes
          // back in raw, so `/connect <url>` never runs a label.
          value = expandPendingPastePlaceholders(draft, screen.pendingPastes)
        }
        if (value !== undefined && value.trim().startsWith('/')) {
          // The `/` command tab (opencode grammar): anything typed after the
          // slash pre-filters the command list, so `/ta` + return lands on
          // /tasks instead of "unknown command".
          // A command WITH args (`/result <id>`) is already complete: the
          // first word names a palette verb, so run it instead of opening
          // the palette filtered by "result <id>" (which matches nothing).
          const query = value.trim().slice(1)
          const first = value.trim().split(/\s+/)[0] ?? ''
          const names = new Set(PALETTE.map(entry => entry.value.trim()))
          const exact = PALETTE.some(entry => entry.value.trim() === value.trim())
          // ONLY a query that actually matches opens the plate. An unknown verb
          // used to open a zero-match plate, and every later keystroke became
          // its filter — `/review` (missing from PALETTE) trapped the whole
          // session, so every command typed after it looked dead. Hermes has no
          // such trap: an unmatched verb is dispatched and answers for itself.
          const matches = exact || names.has(first) ? [] : paletteMatches(query)
          if (matches.length > 0) {
            traceNote(`palette.open via=typed query=${JSON.stringify(query)}`)
            const pick = await runSelect(stdout, stdout.columns ?? 80, stdout.rows ?? 24, 'Commands', matches, () => screen.frame(state), query, screen, recentCommands)
            traceNote(`palette.pick ${pick === undefined ? '(dismissed)' : JSON.stringify(pick)}`)
            screen.render(state)
            if (pick === undefined) {
              state.input = ''
              state.cursor = 0
              continue
            }
            value = await acceptPick(pick)
            if (value === undefined) {
              state.input = ''
              state.cursor = 0
              continue
            }
          }
        }
        state.status = ''
        if (value !== undefined && value.trim()) {
          // The line as it will be DISPATCHED: a command runs its argument
          // (raw), a request hands the paste to the model as framed material.
          // The value is read AFTER the command plate, so a pick that replaced
          // the typed text is the text that gets dispatched.
          const typed = value.trim()
          const outgoing = outgoingLine(typed, screen.pendingPastes)
          const isCommand = outgoing.command
          // Cap history: an unbounded array of every request (plus command
          // templates and, before askPrivate, model ids) grows for the whole
          // session. 500 entries with consecutive-dupe suppression is plenty
          // for Up-recall; restart begins fresh by design (no disk history).
          //
          // The history keeps the FRAMED request, so an up-arrow recall can
          // put the paste back — payload and all — and a resubmit frames it
          // again instead of sending the bare label.
          if (history[history.length - 1] !== outgoing.text) history.push(outgoing.text)
          if (history.length > 500) history.splice(0, history.length - 500)
          // First real request clears the home card: from here on the stream
          // belongs to the conversation, not to the splash. `state.home` is
          // checked too, so a page switch this closure did not see (a `/new`
          // that set the page without setting the flag) cannot strand the
          // transcript behind the splash.
          if (onHome || state.home) leaveHome()
          // Hermes' two echo grammars, made VISIBLE (2026-11-04): a slash
          // command is a control action and wears the house star in CYAN; a
          // request is the operator speaking and is BOLD with the `❯` mark.
          // Both used to be plain text, so the operator's own line looked
          // like something the app said — in a transcript full of the app's
          // own words, that is the one line the reader must be able to find
          // at a glance.
          if (!isExitCommand(typed)) {
            state.scroll = 0 // submitting returns to the live tail
            // Recency: the commands the operator actually uses float up in
            // the completion list. The list is mutated IN PLACE: the screen
            // holds the array, so a new array would leave it looking at the
            // old one.
            if (isCommand) {
              const name = typed.split(/\s+/)[0]!
              const at = recentCommands.indexOf(name)
              if (at >= 0) recentCommands.splice(at, 1)
              recentCommands.unshift(name)
              if (recentCommands.length > 20) recentCommands.length = 20
            }
            screen.push(state, isCommand
              ? { text: `${glyph('star')} ${typed}`, tone: 'cyan' }
              // The request echo shows the COLLAPSED draft: the operator's own
              // line stays one readable line instead of a wall of pasted text.
              : { text: `❯ ${typed}`, tone: 'bold' })
          }
          return outgoing.text
        }
        return value
      }
    },
    // Configuration prompt: reads one line with no history and no stream echo.
    // The PROMPT is shown in the status line, because a bare composer after
    // "pick ngrok" gives the operator nothing to answer — the first live
    // capture of /connect sat at an unlabelled box. A typed command escapes
    // the prompt instead of being validated as a model id.
    askPrivate: (prompt?: string) => readConfigLine(prompt),
    askSecret: (prompt?: string) => screen.readSecret(state, prompt ?? 'secret'),
    askConfig: (prompt?: string) => readConfigLine(prompt),
    // The full shared preview — exactly what will run and what will prove it.
    // The screen dialog drops fields FROM THE END when the terminal is small,
    // so the most important facts come first (`Task`, `Verify`), with `Time`
    // last; detail stays out of the dialog and on the classic card.
    approve: async task => {
      const preview = await buildRunPreview(task)
      const body = [...preview.lines]
      const mode = (process.env.FACTORY_EXECUTION_MODE ?? '').trim().toLowerCase()
      if (mode && mode !== 'live') body.push(`Mode: ${mode} (deterministic — no model call)`)
      body.push('Approval permits workspace changes. This preview is not a sandbox.')
      return screen.askApproval(state, {
        title: 'Ready to run',
        body: body.join('\n'),
        prompt: 'Run it?',
      })
    },
    // Where the receipt goes depends on the page that will paint it. The
    // transcript is not rendered on the home page, so a note pushed there is
    // written to a surface the operator cannot see — which is exactly what
    // made `/new` read as a freeze: the confirm opens on "No, keep going", a
    // stray Enter keeps the session, the receipt goes to the invisible
    // transcript, and the screen does not change at all. On home the note is
    // the toast row above the meter.
    note: text => state.home ? screen.notify(state, text) : screen.push(state, { text, tone: 'plain' }),
    error: text => screen.push(state, { text, tone: 'red' }),
    progress: text => screen.notify(state, text),
    // One message per line, so a table keeps its per-row tone instead of
    // arriving as a single slab of prose with one colour.
    block: lines => { for (const line of lines) screen.push(state, line) },
    // ONE live row, rewritten in place. A chat turn used to push a
    // `✻ thinking` header and then a row per reasoning line: a wall, and a
    // header that still said "thinking" after the turn had failed. The row is
    // now found by its key, never by its index.
    live: (key, row) => screen.live(state, key, row),
    // The live chat seat, for the activity line. A chat used to fall back to
    // a rotating decorative verb ("winding…") that named nothing.
    chatActivity: activity => { state.chatActivity = activity },
    statusContext: () => screenStatusContext(state, sessionId, defaults.workspace),
    select: async (title, options) => {
      const choice = await runSelect(stdout, stdout.columns ?? 80, stdout.rows ?? 24, title, options, () => screen.frame(state), '', screen)
      // Same escape hatch for every picker: a typed slash command leaves the
      // plate and runs, instead of being treated as a model id.
      if (choice !== undefined && choice.trim().startsWith('/')) {
        queuedCommand = choice.trim()
        return undefined
      }
      return choice
    },
    redraw: () => screen.render(state),
    // Clear the stream, and for /new ALSO take the session ledger (and its
    // token count) with it. The composer and history survive: clearing the
    // screen is not amnesia, and the draft in the box is the operator's.
    //
    // `/clear` stays in the session — Hermes empties the transcript and keeps
    // going. `/new` goes back to the start page. The old code set
    // `state.home = !fresh`, which sent BOTH to the start page, so a /clear
    // threw away the session's screen for a full banner and then painted its
    // receipt into a frame that never renders the transcript: the receipt
    // vanished and the operator could not tell what the command had done.
    clearSession: fresh => {
      state.messages.length = 0
      state.home = fresh
      // Keep the input loop's view of the page in sync: `/new` returns to the
      // start page, so the NEXT request must leave it. Without this line the
      // flag said "stream" while the frame said "home".
      onHome = fresh
      state.status = fresh ? '' : COMPOSER_HINTS
      if (fresh) {
        // A fresh session is the start page again, so it needs the banner's
        // capability column and an example prompt — the same screen a cold
        // start shows, not a banner with an empty right half.
        state.placeholder = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]
        state.side = { title: 'wednesday', tokens: 0, limit: contextLimit(), rows: capabilityRows() }
        state.queued = []
        state.turnStartedAt = null
        state.turnMs = 0
      } else {
        state.side = null
      }
      screen.invalidate()
      screen.render(state)
      // The receipt goes in AFTER the clear, or it clears the screen it was
      // meant to explain. One line is enough; the point is that a deliberate
      // blank never reads as a crash.
      // HOW it is shown depends on which page the clear lands on. `/clear`
      // stays in the session (Hermes' own behaviour: the transcript empties,
      // the session continues), so the receipt is a transcript row. `/new`
      // returns to the start page, whose frame never renders the transcript —
      // a `push` there painted nothing at all, so the receipt becomes the
      // toast row the home frame draws above the meter.
      if (fresh) screen.notify(state, 'session cleared — a fresh session starts here')
      else screen.push(state, { text: 'session cleared', tone: 'dim' })
    },
    // The only place allowed to touch `state` for the live-run keyboard, for
    // exactly the reason replLoop cannot (see ReplUi.watchRun and B70).
    crewChanged: () => {
      // The meter's identity follows the seats: applying a crew profile can turn
      // a single model into a mixed crew (and back), and the meter must say so.
      state.crewLabel = crewMeterLabel()
      if (state.side) state.side.rows = capabilityRows()
      screen.render(state)
    },
    watchRun: onInterrupt => screen.watchRun(state, onInterrupt, text => {
      const request = text.trim()
      if (!request) return
      state.input = ''
      state.cursor = 0
      queuedRequests.push(request)
      // The queue panel above the meter is the visible half of this list
      // (Hermes grammar); the toast only says a row was added.
      state.queued = [...queuedRequests]
      screen.notify(state, `queued · ${queuedRequests.length} waiting`)
    }, () => {
      // A lone "/" typed mid-run opens the command plate over the LIVE screen
      // (opencode grammar — commands must work while a task runs). The pick is
      // QUEUED, not run: the run in flight finishes first, then the loop
      // dispatches the pick through the normal path (ask → dispatch).
      void (async () => {
        screen.pendingPalette = false
        const pick = await runSelect(stdout, stdout.columns ?? 80, stdout.rows ?? 24, 'Commands', PALETTE.slice(), () => screen.frame(state), '', screen, recentCommands)
        traceNote(`palette.pick mid-run ${pick === undefined ? '(dismissed)' : JSON.stringify(pick)}`)
        screen.render(state)
        if (pick === undefined) return
        const complete = !pick.endsWith(' ') && PALETTE.some(entry => entry.value === pick)
        if (complete) {
          queuedCommand = pick
          screen.notify(state, `queued command · ${pick}`)
        } else {
          const request = pick.replace(/\s+$/, '')
          queuedRequests.push(request)
          state.queued = [...queuedRequests]
          screen.notify(state, `queued · ${queuedRequests.length} waiting`)
        }
      })()
    }),
    running: active => {
      state.busy = active
      if (active) {
        state.turnStartedAt = Date.now()
      } else {
        // Freeze the turn clock (Hermes' ⏲ segment) and drop the queue panel:
        // the queue is drained by the loop, so the screen mirrors it.
        state.turnMs = state.turnStartedAt ? Date.now() - state.turnStartedAt : 0
        state.turnStartedAt = null
        state.queued = [...queuedRequests]
      }
      state.status = active ? BUSY_HINTS : COMPOSER_HINTS
      screen.render(state)
    },
    // A model switch changes what the session IS, so the composer tag and the
    // header line follow it immediately — the old code left both showing the
    // startup model while every request ran on the new one.
    routeLabel: label => {
      state.composerLabel = label
      state.crewLabel = crewMeterLabel()
      state.meta = headerMeta(label)
      // The capability rail names the active route, so a /model switch or an
      // applied /connect tunnel repaints it instead of leaving the home page
      // advertising the previous model until restart.
      if (state.home) { if (state.side) state.side.rows = capabilityRows(); screen.render(state) }
      screen.render(state)
    },
    // The rail's title is the session's current task, not the word "session":
    // the panel reads `fix login leak · 2,318 tokens` the way the design board
    // draws it. The first request arms the rail, so this only has to keep up.
    sessionTitle: title => {
      if (!state.side) return
      state.side.title = title
      screen.render(state)
    },
    // Hermes' confirm before a wipe: the gate keeps its cursor on
    // `No, keep going`, so Esc/Enter/`2.` all keep the session.
    confirm: (title, detail, yesLabel) => screen.confirm(state, {
      title,
      body: detail,
      prompt: '',
      focus: 'cancel',
      headline: '✦ confirm',
      choices: [
        { key: '1', label: yesLabel, value: 'run' },
        { key: '2', label: 'No, keep going', value: 'cancel' },
      ],
      hint: '↑/↓ select · Enter confirm · 1/2 quick pick · Esc keeps going',
    }),
    // Hermes' pager for a command answer taller than the window: the whole
    // screen is the answer, `enter` pages down, `esc/q` closes.
    page: (title, lines) => screen.page(state, title, lines),
    // The live density: a getter with no argument, a setter with one. Saving on
    // set is what makes `/display quiet` outlive the session rather than only
    // thinning the rest of this transcript. A switch also ends the current tool
    // run: `×2` after a quiet gap would count invisible calls.
    display: mode => {
      if (!mode) return density
      density = mode
      toolGroup = null
      return saveDisplay(mode)
    },
    // Window pressure (2026-11-01): the meter's `ctx` segment is the LAST
    // request's prompt size, which only the caller knows. Without this the
    // meter fell back to cumulative spend and printed `ctx 29.3K/13.0K`.
    context: tokens => {
      if (!state.side) return
      state.side.contextTokens = Math.max(0, Math.round(tokens))
      screen.render(state)
    },
  }
  const usageBefore = usageSnapshot()
  // Consecutive identical tool calls fold into ONE row (`test ×6`), the way a
  // run of six checks reads as one fact rather than six rows of noise. The fold
  // only happens while the group's row is still the LAST message: anything else
  // pushed in between (a stage row, a line, a panel) ends the run, so the tail
  // is compared by identity rather than trusting a timer or an event type.
  let toolGroup: { index: number; row: ScreenMessage; fold: ToolFold } | null = null
  /**
   * Live activity: what each seat is doing while it does it.
   *
   * Reasoning and talk share ONE row per seat and are rewritten in place — a
   * transcript with a row per token is a wall, not a window. The row is found
   * by its invisible key, never by an index, so the transcript's 200-row cap
   * and any other push cannot point the rewrite at the wrong line.
   *
   * The key is scoped to the RUN (`activity:<run>:<seat>`). It used to be
   * `activity:<seat>` for the whole session, which meant the SECOND build
   * rewrote the FIRST build's planner row — and, worse, appended the second
   * run's reasoning to the first run's text, so the transcript showed a mash
   * of two runs as one seat's thought (B186).
   */
  let activityRun = 0
  const activityRows = new Map<string, { text: string; kind: 'reasoning' | 'text' }>()
  const renderActivity = (activity: NonNullable<EventDetail['activity']>, role?: string): void => {
    const seat = role ?? 'agent'
    if (activity.kind === 'reasoning' || activity.kind === 'text') {
      const key = `activity:${activityRun}:${seat}`
      const text = `${activityRows.get(key)?.text ?? ''}${activity.text ?? ''}`
      activityRows.set(key, { text, kind: activity.kind })
      const row = activityMessage(activity.kind, role, { ...activity, text })
      screen.live(state, key, row)
      return
    }
    // A tool call and a file write are facts of their own: their own rows.
    screen.push(state, activityMessage(activity.kind, role, activity))
  }
  /** The seat's last words, for the dock's detail column. */
  const activityDetail = (activity: NonNullable<EventDetail['activity']>): string | undefined => {
    if (activity.kind === 'tool' || activity.kind === 'file') {
      return activity.detail ?? activity.tool
    }
    const tail = liveTail(activity.text ?? '', 40)
    return tail.length > 0 ? tail : undefined
  }
  // Transcript density, read once at startup so a session continues in the
  // shape the operator chose last time. `/display` changes it live; the rows
  // already on screen keep the shape they were read in.
  let density: DisplayMode = loadDisplay()
  const sink: RunSink = {
    event: (type, role, detail) => {
      // Side panel: live token accounting for the session. The ceiling is
      // the DSH worker session window on the local route (13,312).
      if (state.side) {
        const rows = usageDiff(usageBefore, usageSnapshot())
        state.side.tokens = rows.reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0)
        // Window pressure is the LARGEST single prompt this run sent, not the
        // sum of every call: nine 3K calls are nine separate windows, not one
        // 27K window. The old `29.3K/13.0K` meter was that sum divided by the
        // window, which is why it read as a broken gauge.
        let peak = state.side.contextTokens ?? 0
        for (const row of rows) {
          if (row.promptTokens > peak) peak = row.promptTokens
        }
        if (peak > 0) state.side.contextTokens = peak
        state.side.limit = (() => {
          const override = Number(process.env.FACTORY_CONTEXT_LIMIT ?? process.env.LOCAL_LLM_CONTEXT_LIMIT ?? '')
          if (Number.isFinite(override) && override > 0) return override
          return (process.env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() === 'local' ? 13312 : 0
        })()
      }
      // The crew dock is fed by the same events that print as rows, so the
      // two can never disagree about who is working.
      // The dock's detail is the concrete thing (a command, the files written),
      // falling back to the tool name: `tester verifying · npm test` says what
      // is happening, where `· verification.test` only says which subsystem.
      if (type === 'task.created') {
        // A new run opens a new LIVE-ROW scope: the seats of this run get
        // their own rows, so the previous run's receipts stay in the
        // transcript exactly as they were written (B186).
        activityRun += 1
        activityRows.clear()
      }
      state.crew = crewUpdate(
        state.crew ?? [],
        type,
        role,
        detail?.activity
          ? activityDetail(detail.activity)
          : detail?.detail ?? detail?.tool ?? detail?.note,
        detail?.status,
      )
      // Live activity: the row is rewritten in place as the seat works.
      if (type === 'agent.activity' && detail?.activity) {
        renderActivity(detail.activity, role)
        return
      }
      // quiet: the rail keeps the stages and the answer, and drops the tool
      // trail. The dock and the ledger above already updated, so the run is
      // still visible without a row per call.
      if (type === 'tool.called' && density === 'quiet') return
      if (type === 'tool.called' && detail?.tool && role) {
        const live = density !== 'verbose' && toolGroup &&
          toolGroup.index === state.messages.length - 1 &&
          state.messages[toolGroup.index] === toolGroup.row
          ? toolGroup
          : null
        const next = foldTool(live?.fold ?? null, detail.tool, role, detail.note, detail.detail)
        if (live) {
          state.messages[live.index] = next.row
          toolGroup = { index: live.index, row: next.row, fold: next.fold }
          // A rewrite adds no rows, so push's sticky-scroll arithmetic does not
          // apply here; the frame just repaints.
          screen.render(state)
        } else {
          screen.push(state, next.row)
          toolGroup = { index: state.messages.length - 1, row: next.row, fold: next.fold }
        }
        return
      }
      // A finished seat's live row stops saying "thinking": it becomes the
      // receipt of what the seat thought, so a completed run does not read as
      // a seat that is still working. The key is the SAME run-scoped key the
      // activity rows use, or the receipt lands on the wrong run's row.
      if (type === 'agent.completed' && role) {
        const key = `activity:${activityRun}:${role}`
        const live = activityRows.get(key)
        const index = state.messages.findIndex(message => message.live === key)
        if (live && index >= 0) {
          const row = activityMessage(
            live.kind,
            role,
            { kind: live.kind, text: live.text },
            live.kind === 'reasoning' ? 'thought' : 'said',
          )
          screen.live(state, key, row)
        }
      }
      // The role already travels in the row (`┊ ✿ agent started · planner`), so
      // a second `── planner` header would say it twice.
      screen.push(state, eventMessage(type, role, detail))
    },
    line: (text, toneName) => screen.push(state, { text: streamLine(text), tone: toneName }),
    panel: (title, lines) => screen.push(state, { text: '', tone: 'plain', panel: { title, lines } }),
    diff: rows => {
      for (const row of rows) screen.push(state, row)
    },
    // `quiet` asks for the outcome, not the patch; `verbose` reads further.
    patchBudget: () => PATCH_BUDGETS[density],
  }
  const spinner = setInterval(() => spinnerTick(screen, state), 120)
  // A terminal that misses SIGWINCH used to keep the old frame until the next
  // keypress — which meant resizing an approval card shredded the layout and
  // left it that way. Poll the two size properties (cheap), repaint once when
  // they move, and let a floating overlay repaint itself from its own listener.
  const sizeWatch = setInterval(() => {
    if (screen.syncSize(stdout) && !screen.overlayOpen()) screen.render(state)
  }, 150)
  const onResize = (): void => {
    screen.resize(stdout.columns ?? 80, stdout.rows ?? 24)
    // An overlay owns the surface; its resize listener already repainted it.
    // Painting the base frame here would erase the plate the operator is using.
    if (!screen.overlayOpen()) screen.render(state)
  }
  stdout.on('resize', onResize)
  try {
    // Home card already ends with its hint line; pushing another here
    // duplicated it on screen (caught in a real pty capture).
    // First-run onboarding on the screen path, right before the loop starts.
    if (process.env.WEDNESDAY_NO_ONBOARDING !== '1') {
      const { maybeOnboard } = await import('./onboarding')
      await maybeOnboard(ui, {
        createTeamImpl: async u => { await crewCreateFlow(u as ReplUi) },
        modelPickImpl: async u => {
          resetModelCaches()
        const choice = u.select ? await u.select('Pick a model to start with', modelOptions([...(await connectionModelRows()), ...(await localServerRows())])) : undefined
          if (choice) await handleModelChoice(u as ReplUi, choice)
        },
      })
    }
    await replLoop(defaults, bus, ui, sink, screen)
  } finally {
    stopFatalGuard()
    clearInterval(spinner)
    clearInterval(sizeWatch)
    stdout.removeListener('resize', onResize)
    state.busy = false
    // Persist before leaving the alternate screen: the goodbye card may offer a
    // way back only if the file is actually on disk. A save failure is silent
    // by design — the card then says goodbye instead of promising a resume.
    const { saveSession, exitCard } = await import('./session-store')
    const saved = state.messages.length > 0
      ? saveSession({
        id: sessionId,
        startedAt: state.startedAt ?? Date.now(),
        savedAt: Date.now(),
        composerLabel: state.composerLabel,
        crewLabel: state.crewLabel,
        tokens: state.side?.tokens ?? 0,
        messages: state.messages,
      })
      : null
    screen.exit()
    // Hermes clears screen and scrollback, then prints the goodbye at a clean
    // top-left — the live chrome and the transcript are not left stranded above
    // the card (#38252 in its tracker, same reason here).
    stdout.write('\x1b[2J\x1b[3J\x1b[H')
    for (const line of exitCard({
      id: sessionId,
      durationMs: Date.now() - (state.startedAt ?? Date.now()),
      messages: saved ? state.messages : [],
    })) stdout.write(`${line}\n`)
  }
}

/**
 * Approval preflight (2026-10-05).
 *
 * `requireLiveConfig()` used to be called from ONE place — the classic
 * `approve()` — so the screen path, the one a real operator actually uses, had
 * no gate whatsoever: it built the approval card, took `y`, submitted the task
 * and watched the architect die on `NVIDIA_API_KEY is not set`. The retry card
 * was byte-identical, which is why "y does nothing" was reported instead of
 * "the credential is missing".
 *
 * So the gate moves to the dispatch layer, above BOTH `ui.approve`
 * implementations, and it is a NAMED blocker rather than a throw: the operator
 * gets the reason and the one action that clears it, and no approval card is
 * ever shown for a run that cannot start.
 *
 * The three-way result exists because the callers must not lie about what
 * happened. The bare-request path prints `cancelled by operator.` when the gate
 * returns false; a blocked run was never cancelled by anyone.
 */
type GateResult = 'approved' | 'cancelled' | 'blocked'

async function approveOrBlock(ui: ReplUi, task: EngineeringTask): Promise<GateResult> {
  const blocker = liveConfigBlocker()
  if (!blocker) return (await ui.approve(task)) ? 'approved' : 'cancelled'
  ui.error(`blocked before approval: ${blocker.message}`)
  ui.note(blocker.remedy)
  return 'blocked'
}

/**
 * Resolve one model-plate pick to a model id, for a SEAT. Shared by /create,
 * /crew edit, /model's seat rows and /agents, so every surface picks a seat
 * model the same way — from the plate (route rows, auto-detected local
 * servers, teams) or a custom typed id.
 *
 * Returns: a model id to use · `null` = "keep the current/default, no change"
 * (team rows and section headers are not models) · `undefined` = cancel.
 */
async function seatChoiceModel(ui: ReplUi, choice: string): Promise<string | null | undefined> {
  if (choice === 'custom') {
    const id = ui.askPrivate ? await ui.askPrivate('Model id: ') : await ui.ask('Model id: ')
    if (id === undefined) return undefined
    if (!id.trim()) return null
    validateModel(id.trim())
    return id.trim()
  }
  if (choice.startsWith('local::')) {
    const rest = choice.slice('local::'.length)
    const sep = rest.indexOf('::')
    const { connectLocalServer } = await import('./connect')
    await connectLocalServer(rest.slice(0, sep), rest.slice(sep + 2))
    resetModelCaches()
    return rest.slice(sep + 2)
  }
  if (choice.startsWith('route:')) return choice.slice('route:'.length)
  if (choice.startsWith('seat:')) {
    const env = choice.slice('seat:'.length)
    const role = env === 'FACTORY_CREW_PLANNER_MODEL' ? 'planner' : env === 'FACTORY_CREW_CODER_MODEL' ? 'coder' : 'vision'
    return resolveCrewModel(role)
  }
  // crew: / section headers / noop rows are not a model for a single seat.
  return null
}

/**
 * Pick the model for ONE crew seat (planner / coder / vision / worker-N).
 * Screen path: the model plate (route + local servers + teams + custom).
 * Classic path: a private prompt (never echoed, never in history).
 *
 * Returns the chosen id, or undefined when the operator cancelled.
 */
async function pickSeatModel(ui: ReplUi, role: string, current: string): Promise<string | undefined> {
  if (ui.select) {
    const choice = await ui.select(`Model for the ${role} seat`, modelOptions(await localServerRows()))
    ui.redraw?.()
    if (choice === undefined) return undefined
    const model = await seatChoiceModel(ui, choice)
    if (model === undefined) return undefined
    return model ?? current
  }
  const id = ui.askPrivate
    ? await ui.askPrivate(`Model id for the ${role} seat (prefix openrouter/ nvidia/ zen/ local/ to pin provider) [${current}]: `)
    : await ui.ask(`Model id for the ${role} seat [${current}]: `)
  if (id === undefined) return undefined
  if (!id.trim()) return current
  validateModel(id.trim())
  return id.trim()
}

/**
 * The team-creation flow, shared by `/crew create` and `/create [name]` so the
 * two verbs can never drift apart. A name given on the command line skips the
 * first prompt. Seat roles name MODEL SLOTS (planner/coder/vision), not
 * pipeline stages; extras are display seats. Each seat's model is PICKED from
 * the model plate (pickSeatModel) — the operator chooses the models and the
 * team is made of them.
 */
async function crewCreateFlow(ui: ReplUi, nameArg?: string): Promise<void> {
  const { addCrew, applyCrew } = await import('./crew-store')
  let name = nameArg?.trim() ?? ''
  if (!name) name = (ui.ask ? await ui.ask('Team name: ') : undefined)?.trim() ?? ''
  // A piped next line is the next COMMAND, not a name: over a pipe, `/exit`
  // used to be eaten as the team name and a junk crew got created.
  if (name.startsWith('/')) {
    ui.error(`team name cannot start with "/" — cancelled (nothing created).`)
    return
  }
  if (!name) return
  // Seat roles name MODEL SLOTS, not pipeline stages: the pipeline runs
  // architect → planner → coder → tester → reviewer, and crewSlotFor() folds
  // every non-vision stage onto the coder slot. The first three seats hold the
  // three slots; extras are display seats the dock shows when events name them.
  const roles = ['planner', 'coder', 'vision']
  const defaultModel = process.env.DSH_LLM_MODEL ?? 'qwen2.5-coder-3b-instruct'
  const seats: { role: string; model: string }[] = []
  // ONE shape pick instead of "how many seats? then a plate per seat"
  // (2026-11-01): /create used to ask three-to-four questions before a single
  // model was chosen, which is the clunky flow the operator flagged. The
  // common team is the same model in all three slots, and now it is one Enter.
  let shape: string | undefined
  if (ui.select) {
    shape = await ui.select(`Team "${name}" — how is it staffed?`, [
      { title: '3 seats · same model', desc: defaultModel, footer: '1 pick', value: 'same-3' },
      { title: '3 seats · pick one per role', desc: 'planner · coder · vision', value: 'pick-3' },
      { title: '1 seat · same model', desc: defaultModel, footer: 'solo', value: 'same-1' },
      { title: 'Custom size…', desc: 'choose the seats and each model', value: 'custom' },
    ])
    ui.redraw?.()
    if (shape === undefined) return
  }
  if (shape === 'same-3' || shape === 'same-1') {
    const size = shape === 'same-3' ? 3 : 1
    for (let i = 0; i < size; i++) seats.push({ role: roles[i]!, model: defaultModel })
  } else {
    const sizeStr = shape === 'custom' || !ui.select
      ? await ui.ask('Number of seats (1, 2, 3, ...): ')
      : undefined
    const size = Math.max(1, parseInt(sizeStr ?? '3', 10) || 3)
    for (let i = 0; i < size; i++) {
      const role = i < roles.length ? roles[i]! : `worker-${i + 1}`
      // The seat's model is PICKED from the model plate on the screen path —
      // the operator selects the models and the team is made of them.
      const model = await pickSeatModel(ui, role, defaultModel)
      if (model === undefined) return
      seats.push({ role, model })
    }
  }
  const crew = addCrew(name, seats)
  applyCrew(crew)
  ui.crewChanged?.()
  // The receipt says how many seats ROUTE, not just how many exist: only the
  // first three map to a pipeline slot, and the extras are display seats.
  ui.note(`team created: ${crew.name} · ${crewSeatSummary(crew)} · ${crew.seats.map(s => `${s.role}=${s.model}`).join(' ')}`)
  ui.note(`select it anytime with: /model ${crew.name}`)
}

/**
 * Edit one team's seats (and its name). Shared by `/crew edit <name>` and the
 * team's action plate, so the two paths can never drift.
 */
async function crewEditFlow(ui: ReplUi, target: Crew): Promise<void> {
  const { loadCrews, updateCrew, applyCrew } = await import('./crew-store')
  const nameAnswer = ui.ask ? await ui.ask(`New name [${target.name}]: `) : undefined
  const name = nameAnswer && nameAnswer.trim() ? nameAnswer.trim() : target.name
  const sizeStr = ui.ask ? await ui.ask(`Number of seats [${target.seats.length}]: `) : undefined
  const newSize = sizeStr && sizeStr.trim()
    ? Math.max(1, parseInt(sizeStr, 10) || target.seats.length)
    : target.seats.length
  const defaultModel = process.env.DSH_LLM_MODEL ?? 'qwen2.5-coder-3b-instruct'
  const roles = ['planner', 'coder', 'vision']
  const seats: { role: string; model: string }[] = []
  for (let i = 0; i < newSize; i++) {
    const role = i < roles.length ? roles[i]! : `worker-${i + 1}`
    const oldModel = target.seats[i]?.model ?? defaultModel
    // Same picker as /create: dismiss keeps the old model, a pick (plate row
    // or custom id) replaces it.
    const picked = await pickSeatModel(ui, role, oldModel)
    const model = picked === undefined ? oldModel : picked
    seats.push({ role, model })
  }
  updateCrew(target.id, { name, seats })
  const updated = loadCrews().crews.find(c => c.id === target.id)
  if (updated && updated.id === loadCrews().active) { applyCrew(updated); ui.crewChanged?.() }
  ui.note(`crew updated: ${updated?.name} · ${updated?.seats.length} seat${(updated?.seats.length ?? 0) === 1 ? '' : 's'}`)
}

/**
 * What the operator can DO with a team, as a plate.
 *
 * Picking a team used to activate it and nothing else, so there was NO way to
 * delete, rename or re-staff one from the TUI — `/crew delete <name>` existed
 * only as a typed command nobody remembered (operator, 2026-11-04: "a created
 * team must be deletable from the UI — no option exists today").
 *
 * `Use this team` is first because it is the common case, and the destructive
 * action is LAST and behind a confirmation.
 */
async function crewActionFlow(ui: ReplUi, crew: Crew, isActive: boolean): Promise<void> {
  const { setActiveCrew, applyCrew, deleteCrew, updateCrew } = await import('./crew-store')
  const action = ui.select ? await ui.select(`Team: ${crew.name}`, [
    { title: 'Use this team', desc: 'route this session through it', footer: isActive ? 'active' : 'team', value: 'use' },
    { title: 'Edit seats', desc: 'change the models this team answers with', value: 'edit' },
    { title: 'Rename team', desc: 'change the name only', value: 'rename' },
    { title: 'Delete team', desc: 'remove it from the team list', value: 'delete' },
  ]) : undefined
  ui.redraw?.()
  if (action === undefined) return
  if (action === 'use') {
    setActiveCrew(crew.id)
    applyCrew(crew)
    ui.crewChanged?.()
    ui.note(`crew: ${crew.name} · ${crew.seats.map(s => s.role).join(' + ')}`)
    return
  }
  if (action === 'edit') {
    await crewEditFlow(ui, crew)
    return
  }
  if (action === 'rename') {
    const answer = ui.ask ? await ui.ask(`New name [${crew.name}]: `) : undefined
    if (!answer || !answer.trim()) { ui.note('kept — nothing renamed'); return }
    updateCrew(crew.id, { name: answer.trim() })
    ui.crewChanged?.()
    ui.note(`crew renamed: ${crew.name} → ${answer.trim()}`)
    return
  }
  if (action === 'delete') {
    if (ui.confirm) {
      const go = await ui.confirm(
        `Delete crew "${crew.name}"?`,
        'This removes the crew definition. The seats and models are not affected.',
        'Yes, delete it',
      )
      if (!go) { ui.note('kept — nothing deleted'); return }
    }
    deleteCrew(crew.id)
    ui.crewChanged?.()
    ui.note(`crew deleted: ${crew.name}`)
  }
}

/**
 * Handle one /model plate choice. Extracted so the /model verb, the onboarding
 * flow, and any future caller apply picks IDENTICALLY: team, local server,
 * seat, custom, route.
 */
async function handleModelChoice(ui: ReplUi, choice: string): Promise<void> {
  if (choice === 'noop-teams' || choice === 'noop-models') return
  // A model listed by a configured connection: the operator picks BOTH the
  // model and the role it serves (item: seats were filled automatically).
  if (choice.startsWith('assign:')) {
    await assignPickedModel(ui, choice.slice('assign:'.length))
    return
  }
  if (choice.startsWith('crew:')) {
    // Teams (2026-10-30): one pick installs the WHOLE team — every
    // seat lands in its pipeline slot, a smaller team clears what it
    // does not fill (applyCrew), and the receipt names the live seats
    // so the operator can see who answers what.
    const id = choice.slice('crew:'.length)
    const crew = loadCrews().crews.find(c => c.id === id)
    if (!crew) {
      ui.error('that team no longer exists — /create or /crew list')
      return
    }
    setActiveCrew(crew.id)
    applyCrew(crew)
    ui.crewChanged?.()
    ui.note(`team active: ${crew.name} · ${crew.seats.length} seat${crew.seats.length === 1 ? '' : 's'}`)
    ui.note(crewSeatLine())
    ui.progress?.(`team → ${crew.name}`)
    return
  }
  if (choice.startsWith('local::')) {
    // A model on an auto-detected local server: connect that server (saved
    // to the profile, applied live) and route to the picked model.
    const rest = choice.slice('local::'.length)
    const sep = rest.indexOf('::')
    const baseURL = rest.slice(0, sep)
    const model = rest.slice(sep + 2)
    const { connectLocalServer } = await import('./connect')
    await connectLocalServer(baseURL, model)
    resetModelCaches()
    ui.note(`connected · ${new URL(baseURL).host} · ${model} · all seats`)
    announceRoute(ui, model)
    ui.crewChanged?.()
    return
  }
  if (choice.startsWith('seat:')) {
    const slot = choice.slice('seat:'.length)
    const role = CREW_SEATS.find(entry => entry.env === slot)?.role ?? slot
    // The seat's model comes from the SAME plate the team flow uses — pick a
    // model per role from the list, not a blind typed id.
    const id = await pickSeatModel(ui, role, resolveCrewModel(role))
    if (id === undefined || !id.trim()) return
    const picked = id.trim()
    // A crew's first seats ARE the pipeline slots (applyCrew maps index →
    // planner/coder/vision), so an env-only edit leaves the active team — and
    // therefore the meter and the conversational seat — on the old model.
    const crew = activeCrew()
    const index = CREW_SEATS.findIndex(entry => entry.env === slot)
    if (crew && index >= 0 && crew.seats[index]) {
      updateCrew(crew.id, { seats: crew.seats.map((seat, i) => i === index ? { ...seat, model: picked } : seat) })
    }
    process.env[slot] = picked
    ui.note(`${role} seat = ${picked}`)
    ui.progress?.(`${role} → ${routeLabelOf(id.trim())}`)
    return
  }
  const id = choice === 'custom'
    ? (ui.askPrivate ? await ui.askPrivate('Model id: ') : await ui.ask('Model id: '))
    : choice.slice('route:'.length)
  if (id === undefined || !id.trim()) return
  validateModel(id.trim())
  // 2026-10-31 provider pins: a `provider/model` id also switches the route
  // provider, otherwise DSH_LLM_MODEL would carry the prefix into a route
  // that does not know it (e.g. `nvidia/…` sent to the openrouter route).
  const trimmed = id.trim()
  const prefix = PROVIDER_PREFIXES.find(p => trimmed.startsWith(`${p}/`))
  if (prefix !== undefined) {
    process.env.FACTORY_LLM_PROVIDER = prefix
    process.env.DSH_LLM_PROVIDER = prefix
    process.env.DSH_LLM_MODEL = trimmed.slice(prefix.length + 1)
  } else {
    process.env.DSH_LLM_MODEL = trimmed
  }
  announceRoute(ui, trimmed)
  // This path moves the ROUTE only, by design. Say so whenever the seats still
  // resolve to a different model — with or without a stored team. Before this,
  // a route-only pick on a profile with env seats left the home page naming
  // qwen and the operator concluded the picker was ignored (2026-11-05).
  const team = activeCrew()
  const seats = [...new Set(CREW_SEATS.map(({ role }) => resolveCrewModel(role)))]
  const seatLabel = seats.join(' · ')
  if (team) {
    ui.note(`route only — team ${team.name} keeps its own seats (${seatLabel})`)
  } else if (seats.length > 0 && !seats.includes(trimmed)) {
    ui.note(`route only — seats still ${seatLabel}; pick the model again and choose "All roles" to move them`)
  }
}

/**
 * The REPL dispatch loop — exported so it can be driven in-process.
 *
 * This is the seam that matters: every command the operator can type runs
 * through here, and the piped (`--classic`) tests exercise a DIFFERENT `ui` than
 * the TTY one. A screen-only path therefore had zero coverage, which is how
 * "state is not defined" shipped: the crash was behind `if (screen)`, so every
 * child-process test passed while every real request died. `dispatch-test.ts`
 * drives this function with a real `Screen` and a fake `ui`, so the TTY path is
 * covered too.
 */
export async function replLoop(
  defaults: ReturnType<typeof parseFlags>,
  bus: PersistentFactoryEventBus,
  ui: ReplUi,
  sink: RunSink | undefined,
  screen?: Screen,
): Promise<void> {
  // Ctrl+C on the CLASSIC path arrives as SIGINT (the screen path is in raw mode
  // and uses Esc). The policy — abort a live run, leave an idle session — lives
  // in interrupt.ts so it can be tested without a real signal (Windows cannot
  // deliver one to a child process).
  let running: AbortController | null = null
  // An operator halt must leave a receipt (design record C7): the run layer
  // reports the stage as failed, which alone reads like the work broke rather
  // than stopped at the operator's word. Both entry points — Esc on the screen
  // path, SIGINT/130 on the classic path — come through abortRun.
  let operatorAbort = false
  // Chat memory (2026-10-30, real chat loop): the conversation lives for the
  // session; `/clear` and `/new` start a fresh one. Per-request length is
  // capped by `buildChatRequest`, so a long chat cannot blow the context.
  const chatHistory: ChatMessage[] = []
  let chatTipShown = false
  // One dead endpoint is one fact. These two carry the streak of IDENTICAL
  // chat failures so the second one is a counted line instead of a second
  // card (operator report, 2026-11-04: the same `Chat failed` card three
  // times in a row).
  let lastChatFailure = ''
  let chatFailureStreak = 0
  // Chat turn counter: every chat turn owns ONE live row, and the row's key
  // must be unique per turn. A shared key would make the second turn rewrite
  // the first turn's answer (B186).
  let chatTurns = 0
  const abortRun = (): void => {
    if (!running) return
    operatorAbort = true
    running.abort()
  }
  const stopInterrupt = installInterrupt({
    isRunning: () => running !== null,
    abort: abortRun,
    // Ctrl+C only reaches SIGINT with raw mode OFF — i.e. exactly the window
    // where nobody is reading keys (no composer, no dialog, between
    // attachments). Exiting from there must hand the terminal back first, or
    // the operator is left staring at a frozen frame with a hidden shell
    // behind it and no key — not even Ctrl+C — appears to do anything.
    restore: screen
      ? () => {
        try { stdin.setRawMode(false) } catch { /* the screen path implies a TTY; a stub must not break the exit */ }
        screen.exit()
      }
      : undefined,
  })
  try {
    await askLoop()
  } finally {
    stopInterrupt()
  }

  async function askLoop(): Promise<void> {
  for (;;) {
    const input = await ui.ask('wednesday> ')
    if (input === undefined) { traceNote('composer.leave'); break }
    const line = input.trim()
    if (!line) continue
    traceNote(`dispatch ${JSON.stringify(line)}`)
    if (line === '/exit') break
    try {
      if (line === '/help' || line.startsWith('/help ')) {
        // Hermes' transcript grammar: a `+---+` header, `── Category ──`
        // sections, one aligned row per verb, then the tip block. `/help <text>`
        // filters instead of dumping 30 rows at someone looking for one.
        const rows = renderHelp(stdout.columns ?? 80, HELP_COMMANDS, HELP_GROUPS, HELP_FLAGS, line.slice('/help'.length))
        if (ui.block) ui.block(rows)
        else ui.note(rows.map(row => row.text).join('\n'))
        continue
      }
      /**
       * Hermes' rule for command output (`createSlashHandler`): a reply longer
       * than two lines is PAGED, not echoed — the whole window becomes the
       * answer. A transcript flood was the /tasks complaint: the table
       * arrived, the frame kept the tail, and the top of the answer could
       * not be read from inside the app at all. `ui.page` is the screen's
       * pager; the classic path prints plain and keeps its shape.
       */
      const pageLong = async (title: string, rows: ViewLine[]): Promise<void> => {
        const text = rows.map(row => row.text)
        if (ui.page && (text.length > 2 || text.join('\n').length > 180)) await ui.page(title, text)
        else if (ui.block) ui.block(rows)
        else ui.note(text.join('\n'))
      }
      if (line === '/agents') {
        if (ui.select) {
          const choice = await ui.select('Select agent', agentOptions())
          ui.redraw?.()
          if (choice === undefined) continue
          const seat = CREW_SEATS.find(entry => `seat:${entry.env}` === choice)
          if (seat) {
            // Same plate picker as /model's seat rows: pick the model for the
            // role from the list; a model id is configuration, so the custom
            // path stays a private prompt out of the stream.
            const id = await pickSeatModel(ui, seat.role, resolveCrewModel(seat.role))
            if (id === undefined || !id.trim()) continue
            process.env[seat.env] = id.trim()
            ui.note(`${seat.role} seat = ${id.trim()}`)
            ui.progress?.(`${seat.role} → ${routeLabelOf(id.trim())}`)
            continue
          }
          const applied = applyAgentProfile(choice)
          ui.note(applied.note)
          ui.crewChanged?.()
          if (applied.applied) ui.progress?.(`crew → ${choice}`)
          continue
        }
        // Classic path has no floating plate: numbered prompt instead of dead.
        // A PIPE cannot answer a menu — its next line is the next command, and
        // prompting for it turned `/help` into "Unknown profile: /help". With
        // no terminal there is nobody to ask, so print the live crew instead.
        if (!stdin.isTTY) {
          ui.note(`crew: ${crewSeatLine()}`)
          continue
        }
        ui.note('Crew profiles: 1) trio (planner + coder + vision)  2) duo (planner + coder)  3) solo (one model, all roles)');
        const choice = (await ui.ask('Profile [1-3]: '))?.trim()
        if (choice === undefined || !choice) continue
        const profile = choice === '1' ? 'trio' : choice === '2' ? 'duo' : choice === '3' ? 'solo' : null
        if (!profile) { ui.error(`Unknown profile: ${choice} (choose 1-3)`); continue }
        ui.note(applyAgentProfile(profile).note)
        ui.crewChanged?.()
        continue
      }
      if (line === '/crew' || line.startsWith('/crew ')) {
        const { loadCrews, saveCrews, updateCrew, deleteCrew, applyCrew, activeCrew, setActiveCrew, crewMeterName, crewSeatCount, crewSeatSummary } = await import('./crew-store')
        const arg = line.slice('/crew'.length).trim()
        const sub = arg.split(/\s+/)[0]?.toLowerCase() ?? ''
        const rest = arg.slice(sub.length).trim()
        const store = loadCrews()
        if (sub === '' || sub === 'list') {
          if (store.crews.length === 0) {
            ui.note('No crews yet. /crew create to build one.')
            continue
          }
          const choice = ui.select ? await ui.select('Select crew', store.crews.map(c => ({
            title: c.name, desc: `${crewSeatSummary(c)} · ${[...new Set(c.seats.map(s => s.model))].join(', ')}`, footer: c.id === store.active ? 'active' : 'crew', value: c.id,
          }))) : undefined
          if (choice === undefined) continue
          if (choice.startsWith('seat:')) { /* n/a */ }
          const picked = store.crews.find(c => c.id === choice)
          if (!picked) continue
          // A picked team opens its ACTION plate: use it, re-staff it, rename
          // it, delete it. Activating it used to be the ONLY thing a pick did,
          // so a team created in the TUI could never be removed from it.
          await crewActionFlow(ui, picked, picked.id === store.active)
          continue
        }
        if (sub === 'create') {
          await crewCreateFlow(ui, rest || undefined)
          continue
        }
        if (sub === 'delete') {
          if (!rest) { ui.error('Usage: /crew delete <name>'); continue }
          const target = store.crews.find(c => c.name.toLowerCase() === rest.toLowerCase())
          if (!target) { ui.error(`No crew named: ${rest}`); continue }
          if (ui.confirm) {
            const go = await ui.confirm(`Delete crew "${target.name}"?`, 'This removes the crew definition. The seats and models are not affected.', 'Yes, delete it')
            if (!go) { ui.note('kept — nothing deleted'); continue }
          }
          deleteCrew(target.id)
          ui.crewChanged?.()
          ui.note(`crew deleted: ${target.name}`)
          continue
        }
        if (sub === 'edit') {
          if (!rest) { ui.error('Usage: /crew edit <name>'); continue }
          const target = store.crews.find(c => c.name.toLowerCase() === rest.toLowerCase())
          if (!target) { ui.error(`No crew named: ${rest}`); continue }
          // The SAME flow the action plate runs, so a team edited by command
          // and a team edited by plate can never end up different.
          await crewEditFlow(ui, target)
          continue
        }
        ui.error(`Unknown /crew subcommand: ${sub} (list, create, delete, edit)`)
        continue
      }
      if (line === '/create' || line.startsWith('/create ')) {
        // `/create [name]` is the top-level team verb; it runs the SAME flow as
        // `/crew create` (crewCreateFlow), so the two can never drift.
        await crewCreateFlow(ui, line.slice('/create'.length).trim() || undefined)
        continue
      }
      if (line === '/model') {
        if (ui.select) {
          // The plate lists teams first, then the models each configured
          // connection serves, then auto-detected local servers, then the route
          // rows and seats — one pick applies through the SAME handler the
          // onboarding uses, so the two surfaces can never disagree.
          //
          // Reading the connections is a network call (a dead tunnel waits for
          // its timeout), so the spinner is armed FIRST: a silent second before
          // the plate opens is exactly what "the menu freezes" feels like.
          ui.progress?.('reading models from your connections…')
          ui.running?.(true)
          let extraRows: SelectOption[] = []
          try {
            extraRows = [...(await connectionModelRows()), ...(await localServerRows())]
          } finally {
            ui.running?.(false)
          }
          const choice = await ui.select('Select model', modelOptions(extraRows))
          ui.redraw?.()
          if (choice === undefined) continue
          await handleModelChoice(ui, choice)
          continue
        }
        ui.note(`model: ${process.env.DSH_LLM_MODEL ?? '(unset)'} (set with /model provider/model)`)
        // Classic path still sees the teams (2026-10-30) AND the connections
        // (2026-11-01): the plate is TTY-only, so piped runs get the same
        // facts as plain lines instead of a different product.
        const crews = loadCrews()
        for (const crew of crews.crews) {
          ui.note(`  team: ${crew.name} · ${crew.seats.length} seat${crew.seats.length === 1 ? '' : 's'} — pick with /model ${crew.name}${crew.id === crews.active ? ' [active]' : ''}`)
        }
        for (const connection of configuredConnections()) {
          const models = await fetchConnectionModels(connection)
          ui.note(`  connection: ${connection.label} — ${models.length} model(s)${models.length ? `: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''}` : ' (no /models answer)'}`)
        }
        ui.note('  in a terminal, /model opens the picker: choose a model, then choose the role that uses it.')
        continue
      }
      if (line.startsWith('/model ')) {
        const arg = line.slice(7).trim()
        // Typing a TEAM name selects the whole team (2026-10-30): `/model
        // my-crew` is the fastest path from the composer. A named team wins
        // over a model id — the team is the operator's own creation; unknown
        // names fall through to the model-id path unchanged.
        const crew = loadCrews().crews.find(c => c.name.toLowerCase() === arg.toLowerCase())
        if (crew) {
          setActiveCrew(crew.id)
          applyCrew(crew)
          ui.crewChanged?.()
          ui.note(`team active: ${crew.name} · ${crew.seats.length} seat${crew.seats.length === 1 ? '' : 's'}`)
          ui.note(crewSeatLine())
          ui.progress?.(`team → ${crew.name}`)
          continue
        }
        const model = arg
        validateModel(model)
        process.env.DSH_LLM_MODEL = model
        announceRoute(ui, model)
        continue
      }
      if (line === '/connect') {
        // The onboarding step: ask once, prove the endpoint, save outside the
        // repo, apply live. A cancelled flow changes nothing. Transports:
        // auto-detected local servers, ngrok, Cloudflare, local proxy,
        // OpenRouter, NVIDIA NIM.
        await connectFlow(ui)
        // The new provider's catalogue must be visible on the very next
        // /model, not after a restart.
        resetModelCaches()
        continue
      }
      if (line === '/update') {
        // Force a registry check (bypasses the daily cache). When a newer
        // release exists, ask ONCE and, on yes, install the EXACT pinned
        // version from the official registry via npm (see updater.ts).
        // Piped/scripted runs never prompt — they just get the command.
        const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
        const version = typeof pkg.version === 'string' ? pkg.version : 'unknown'
        const channel = channelOf(version)
        const { installUpdate, updateCommandLine } = await import('./updater')
        // A registry check can spend seconds behind a dead network. Say so
        // before awaiting it: the old path went silent, and a silent screen
        // under a typed command is indistinguishable from a freeze.
        ui.progress?.('checking npm for a newer release…')
        const found = await resolveUpdate({ version, stateDir: STATE_HOME, force: true })
        if (!found) {
          await emitBlock(ui, `wednesday ${version} · npm channel "${channel}"\nup to date — no newer release on npm for channel "${channel}".`, 'Update')
          continue
        }
        await emitBlock(ui, [
          `wednesday ${found.current} → ${found.remote} is available (npm channel "${channel}")`,
          `install: ${updateCommandLine(found.remote)}   (exact pinned version, registry.npmjs.org over HTTPS)`,
        ].join('\n'), 'Update')
        let yes = false
        if (ui.confirm) {
          yes = await ui.confirm(
            `Update wednesday to ${found.remote}?`,
            `Runs: ${updateCommandLine(found.remote)} — npm verifies the tarball against the registry checksum. Restart wednesday afterwards to run the new version.`,
            'Yes, update now',
          )
        } else if (isTty()) {
          yes = (await ui.ask(`Install ${found.remote} globally now? [y/N] `))?.trim().toLowerCase() === 'y'
        }
        if (!yes) {
          ui.note(`not now — later: ${updateCommandLine(found.remote)}`)
          continue
        }
        ui.progress?.('installing update from npm…')
        const outcome = installUpdate({ version: found.remote })
        if (outcome.ok) {
          if (isTty() && shouldAutoRestart()) {
            // Auto-restart onto the new version (operator, 2026-11-01): re-exec
            // the same command once, guarded by WEDNESDAY_JUST_UPDATED so it
            // can never loop. The old process stays alive until the child
            // exits so the terminal is never torn down under it.
            ui.note(`updated to wednesday ${outcome.installed} — restarting on the new version…`)
            process.env.WEDNESDAY_JUST_UPDATED = '1'
            const { spawn } = await import('node:child_process')
            const { fileURLToPath } = await import('node:url')
            screen?.exit()
            const bin = fileURLToPath(new URL('../../bin/wednesday.js', import.meta.url))
            const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
              stdio: 'inherit',
              env: { ...process.env, WEDNESDAY_JUST_UPDATED: '1' },
            })
            child.on('exit', code => process.exit(code ?? 0))
            return
          }
          ui.note(`updated to wednesday ${outcome.installed} — exit and run wednesday again to use it`)
        } else {
          ui.error(`update ${outcome.stage} failed: ${safeError(new Error(outcome.detail))} — manual: ${updateCommandLine(found.remote)}`)
        }
        continue
      }
      if (line === '/uninstall') {
        // Uninstall lives in the BACKEND, not the menu (operator decision
        // 2026-11-01): a TUI must not delete its own config mid-session. The
        // CLI owns it; the website's install section documents it. Typing the
        // verb here answers with the exact commands instead of running them.
        ui.note('uninstall runs outside the TUI — exit first (/q or ctrl+c twice), then:')
        ui.note('  wednesday uninstall              # asks, then removes ~/.wednesday config + state')
        ui.note('  wednesday uninstall --package    # also removes the global npm package')
        ui.note('your projects and workspace are never touched — see the website install section.')
        continue
      }
      if (line === '/onboard') {
        // Re-run the first-run setup (connect → solo model or team → proof → tips).
        const { runOnboarding } = await import('./onboarding')
        await runOnboarding(ui, {
          createTeamImpl: async u => { await crewCreateFlow(u as ReplUi) },
          modelPickImpl: async u => {
            resetModelCaches()
        const choice = u.select ? await u.select('Pick a model to start with', modelOptions([...(await connectionModelRows()), ...(await localServerRows())])) : undefined
            if (choice) await handleModelChoice(u as ReplUi, choice)
          },
        })
        continue
      }
      if (line === '/proof') {
        // The same tiny real turn onboarding runs, on demand: the cheapest
        // honest answer to "is my route actually working?".
        const { renderProof, runProof } = await import('./proof')
        const receipt = await runProof(ui)
        renderProof(ui, receipt)
        continue
      }
      if (line === '/status') {
        // The CLI's `wednesday status`, inside the session: a route change made
        // with /connect or /model used to be invisible until the operator knew
        // to restart and run a second command. Same renderer, so the two can
        // never disagree about what the route is. The screen path adds the
        // session facts Hermes shows (id, spend, whether an agent is running).
        const { renderStatus } = await import('./status')
        const crew = activeCrew()
        await emitBlock(
          ui,
          renderStatus(process.env, undefined, ui.statusContext?.() ?? {}, crew),
          'Status',
        )
        continue
      }
      if (line === '/doctor') {
        // Read-only readiness, in the session. A failing check is the one place
        // the operator should see red AND the reason, not an exit code.
        const { renderDoctor, runDoctor } = await import('./doctor')
        const rendered = renderDoctor(await runDoctor())
        await emitBlock(ui, rendered.text, 'Doctor')
        continue
      }
      if (line === '/stats') {
        // Token usage for the LIVE session, by model. The registry is a
        // module-level counter every provider records into, so this is the
        // real spend since the process started - not a stored history an
        // operator has to trust. Hermes' `/usage` grammar: a leading blank,
        // an indented `✦` heading, then the numbers under it.
        const rows = usageSnapshot()
        const mode = (process.env.FACTORY_EXECUTION_MODE ?? 'live').trim().toLowerCase()
        if (rows.length === 0) {
          // Say "usage" in both branches so the answer reads as the same
          // command, whether the session has spent tokens or not.
          await emitBlock(ui, [
            '',
            '  ✦ Session usage',
            mode === 'deterministic'
              ? '  Tokens: 0 — deterministic mode runs no model.'
              : '  Tokens: 0 — no model calls yet in this session.',
          ].join('\n'), 'Usage')
        } else {
          const wide = Math.max(...rows.map(row => `${row.provider}/${row.model}`.length))
          const total = rows.reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0)
          const calls = rows.reduce((sum, row) => sum + row.calls, 0)
          await emitBlock(ui, [
            '',
            '  ✦ Session usage',
            `  Tokens: ${total.toLocaleString('en-US')} across ${calls} call${calls === 1 ? '' : 's'}`,
            ...rows.map(row =>
              `  ${(`${row.provider}/${row.model}`).padEnd(wide)}  ${String(row.promptTokens).padStart(7)} in  ${String(row.completionTokens).padStart(7)} out  (${row.calls}x)`),
          ].join('\n'), 'Usage')
        }
        continue
      }
      if (line === '/display' || line.startsWith('/display ')) {
        // Density is a SETTING with a getter: bare `/display` answers with the
        // current mode, `/display quiet|normal|verbose` changes it. The screen
        // path answers from its live value and saves on set; a pipe reads and
        // writes the same store, so the choice survives either surface.
        const current = ui.display?.() ?? loadDisplay()
        const want = line.slice('/display'.length).trim().toLowerCase()
        if (!want) {
          ui.note(`display: ${current} — ${DISPLAY_HINTS[current]}`)
          continue
        }
        if (!isDisplayMode(want)) {
          ui.error(`Unknown display mode: ${want} (quiet, normal, verbose)`)
          ui.note(`display: ${current} — ${DISPLAY_HINTS[current]}`)
          continue
        }
        const applied = ui.display?.(want) ?? saveDisplay(want)
        ui.note(`display set: ${applied} — ${DISPLAY_HINTS[applied]}`)
        continue
      }
      if (line === '/debug') {
        // One screen of what this session is ACTUALLY running with: the route,
        // every crew seat resolved the way the router will use it, and the
        // paths the run writes to. Read-only, and deliberately verbose - this
        // is the screen you paste into a bug report.
        const provider = (process.env.FACTORY_LLM_PROVIDER ?? '').trim().toLowerCase() || '(default)'
        const seatLines = CREW_SEATS.map(({ env, role }) => `  ${role.padEnd(8)} ${resolveCrewModel(role)}`).join('\n')
        // Shorten the state paths to the part after `.wednesday`: the absolute
        // prefix is the machine, not the configuration, and it is long enough
        // to wrap mid-word the moment a profile sits deep in a user folder.
        const rel = (p: string): string => {
          const at = p.replace(/\\/g, '/').lastIndexOf('.wednesday/')
          return at >= 0 ? `~/.wednesday/${p.slice(at + 11).replace(/\\/g, '/')}` : p
        }
        await emitBlock(ui, [
          'Wednesday Debug',
          '',
          `Route: ${provider}`,
          `Model: ${(process.env.DSH_LLM_MODEL ?? '').trim() || '(unset)'}`,
          provider === 'local' ? `Endpoint: ${(process.env.LOCAL_LLM_BASE_URL ?? '').trim() || '(default 127.0.0.1:1337)'}` : '',
          `Execution: ${(process.env.FACTORY_EXECUTION_MODE ?? 'live').trim() || 'live'}`,
          `Workspace: ${defaults.workspace}`,
          'Crew seats:',
          seatLines,
          'Paths:',
          `  Tasks: ${rel(EVENTS_PATH)}`,
          `  State: ${rel(STATE_HOME)}`,
        ].filter(Boolean).join('\n'), 'Debug')
        continue
      }
      if (line === '/compact') {
        // Manual compaction (opencode's `/compact`): the same deterministic
        // pass the auto path runs, on command. Refuses honestly when there is
        // nothing to compact rather than printing a no-op success.
        const budget = resolvePromptBudget()
        const result = compactHistory(chatHistory, { budget, force: 'soft' })
        if (result.dropped === 0) {
          ui.note(chatHistory.length === 0
            ? 'nothing to compact — this session has no conversation yet'
            : `context is fine — ${Math.max(0, chatHistory.length)} turns, nothing dropped`)
          continue
        }
        chatHistory.length = 0
        chatHistory.push(...result.history)
        ui.note(`compacted: dropped ${result.dropped} older turn${result.dropped === 1 ? '' : 's'} · ~${result.before} → ~${result.after} tokens`)
        if (budget > 0) ui.context?.(result.after)
        continue
      }
      if (line === '/clear' || line === '/new') {
        // Clear the screen. The loop keeps running: /clear empties the stream,
        // /new does the same and drops the session ledger so the next request
        // reads as the first one. Both are pure screen state, which is exactly
        // why they go through `ui` and not through `screen` here (B100).
        // The screen path clears its own stream and prints the surviving
        // receipt itself; a pipe has nothing to clear and needs the line.
        //
        // Hermes asks before it wipes: `/clear` opens `Clear the current
        // session?` and `/new` opens `Start a new session?`, both with
        // `Yes, …` and `No, keep going`. A transcript is unrecoverable
        // (nothing but the saved session survives), so an accidental
        // `/clear` used to cost the whole session's work. The confirm is
        // a hook: a pipe answers every prompt with its next line, and
        // inheriting "Unknown profile: /help" from that was B110's
        // mistake, so only a real terminal gets the dialog.
        const fresh = line === '/new'
        if (ui.confirm) {
          const go = await ui.confirm(
            fresh ? 'Start a new session?' : 'Clear the current session?',
            'This ends the current conversation and clears the transcript.',
            fresh ? 'Yes, start a new session' : 'Yes, clear the session',
          )
          if (!go) {
            ui.note('kept going — nothing was cleared')
            continue
          }
        }
        // Chat memory dies with the session exactly like the transcript does.
        chatHistory.length = 0
        const announced = line === '/new' ? 'session cleared — a fresh session starts here' : 'session cleared'
        if (ui.clearSession) ui.clearSession(fresh)
        if (!screen) ui.note(announced)
        continue
      }
      if (line === '/q') {
        // A one-key exit, like a shell. Same behaviour as /exit, so neither
        // the classic path nor the screen path has a second exit contract.
        break
      }
      if (line === '/review' || line.startsWith('/review ')) {
        // The workspace's diff, read-only, and SCOPED: the stat first (which
        // files, how big), then the patch for the changed FILES ONLY, bounded.
        // The first version printed the whole patch, which on this repository
        // is a 500-line wall that scrolls the receipt off the screen — a review
        // nobody reads. `/review <file>` narrows to one path; `/review all`
        // prints the whole patch for the rare time you actually want it.
        const where = defaults.workspace
        const run = (args: string[]): string | null => {
          const done = spawnSync('git', ['-C', where, ...args], { encoding: 'utf8', windowsHide: true })
          return done.status === 0 ? done.stdout.trim() : null
        }
        if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') {
          ui.error(`${where} is not a git repository - /review shows the diff of the workspace.`)
          continue
        }
        const status = run(['status', '--porcelain']) ?? ''
        if (!status) {
          ui.note('workspace is clean - nothing to review.')
          continue
        }
        // Which file? `all` means every file; otherwise one path after the verb.
        const want = line.slice('/review'.length).trim()
        const paths = status.split('\n').map(row => row.slice(3).trim()).filter(Boolean)
        const target = want && want !== 'all' ? paths.find(p => p.includes(want)) : undefined
        if (want && want !== 'all' && !target) {
          ui.error(`No changed file matches: ${want}`)
          ui.note(`changed: ${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` (+${paths.length - 8} more)` : ''}`)
          continue
        }
        const files = target ? [target] : paths
        const changed = files.length
        // `--stat` with no `--` before N files is a pathspec-ambiguity: git
        // treats `diff --stat a.ts b.ts` as THREE paths and, with untracked
        // ones in the list, prints nothing at all. The explicit `--` plus a
        // stat that lists every file is what makes the table appear.
        const stat = run(['diff', '--stat', '--', ...files]) ?? ''
        await emitBlock(ui, [
          `review: ${changed} file(s) in ${where}`,
          ...(stat ? stat.split('\n') : []),
        ].join('\n'), 'Review')
        if (want === 'all') {
          await emitBlock(ui, run(['diff', ...files]) ?? '', target ? `Review · ${target}` : 'Review · all files')
          continue
        }
        // One bounded patch per file, so the receipt stays on screen and the
        // operator can ask for the rest (`/review <file>` or `/review all`).
        // Whole-repo default is the stat table plus a SHORT preview: the point
        // of /review is "what changed", and the answer is the table. The diff
        // is there when asked for, which is what a one-file review is.
        //
        // The preview diffs ONE file, not every file: the loop used to run a
        // blocking `spawnSync` git per changed file, and on this repository
        // (35 dirty files) that froze the screen for ~8 seconds — keystrokes
        // queued in the PTY and the frame sat dead. The stat table above is
        // the answer to "what changed"; the preview is a taste of the shape,
        // and `/review <file>` / `/review all` are the ways to read more.
        const width = viewWidth()
        const budget = target ? 200 : 24
        let lines = 0
        for (const file of target ? files : files.slice(0, 1)) {
          for (const row of (run(['diff', '--unified=2', '--', file]) ?? '').split('\n')) {
            if (lines >= budget) break
            ui.block?.([{ text: wrapText(row, width)[0] ?? row, tone: 'dim' }])
            lines += 1
          }
        }
        const more = target
          ? lines >= budget ? `\n… ${target} trimmed at ${budget} lines — /review all prints the whole diff.` : ''
          : `\n… first diff shown; ${files.length - 1} more file(s) — /review <file> for one, /review all for everything.`
        if (more) ui.note(more.trim())
        continue
      }
      if (line === '/tasks') {
        const store = await loadStore()
        // A shaped table, newest first (views.ts). The old one-liner per task
        // made a long objective wrap across three unaligned rows, which is the
        // "so big long response" complaint — and the response went to the
        // transcript, whose tail is all a window ever shows. Now it pages.
        await pageLong('Tasks', taskListLines(store.tasks.map(toTaskRow), viewWidth()))
        continue
      }
      if (line === '/health') {
        // A meter that takes seconds must LOOK alive: the old handler awaited
        // every probe in silence, so a slow tunnel read as a frozen screen.
        // The spinner is already wired to `busy`, so arming it is the whole
        // progress surface.
        ui.running?.(true)
        ui.progress?.('health: probing endpoints…')
        try {
          const report = await runHealthChecks()
          recordHealthReport(report)
          const lamp = (status: string): string => status === 'ok' ? 'OK' : status === 'degraded' ? 'WARN' : 'DOWN'
          const tone = (status: string): MsgTone => status === 'down' ? 'red' : status === 'degraded' ? 'yellow' : 'green'
          // Wall time, not the sum of parallel probes: summing made a 0.7s
          // report claim "1952ms", which reads as a stuck app rather than a
          // measurement.
          const wall = Math.max(0, ...report.checks.map(check => check.ms))
          const lines: ViewLine[] = [
            { text: `factory health: ${lamp(report.overall)} (${report.checks.length} checks, ${wall}ms)`, tone: tone(report.overall) },
            ...report.checks.map(check => ({
              text: `[${lamp(check.status)}] ${check.label}: ${check.detail}`,
              tone: tone(check.status),
            })),
          ]
          const history = readHealthHistory()
          if (history.length > 1) {
            lines.push({ text: `trend: ${history.map(entry => entry.overall).join(' → ')}`, tone: 'dim' })
          }
          if (report.checks.some(check => check.id === 'proxy' && check.status === 'down')) {
            lines.push({ text: 'hint: /connect points the route at a tunnel directly — no local proxy needed.', tone: 'dim' })
          }
          // Wrap to the content column: a long probe detail used to run under
          // the session rail, which is the one place text must never go.
          // Eleven checks page, like every other long answer — the meter's
          // history and trend belong on one readable screen, not a flood.
          const width = viewWidth()
          const wrapped = lines.flatMap(line => wrapText(line.text, width).map(text => ({ text, tone: line.tone })))
          if (ui.page && wrapped.length > 2) await ui.page('Health', wrapped.map(row => row.text))
          else ui.block?.(wrapped)
        } finally {
          ui.running?.(false)
        }
        continue
      }
      if (line.startsWith('/')) {
        const [command, ...parts] = line.split(/\s+/)
        // `--raw` is the escape hatch: a shaped view for a person, the stored
        // record for a pipe. Both are first-class, so neither is a workaround.
        const raw = parts.includes('--raw')
        const id = parts.filter(part => part !== '--raw').join(' ')
        if (!['/run', '/result', '/events'].includes(command)) throw new Error(`Unknown command: ${command} (try /help)`)
        if (!id) throw new Error(`Usage: ${command} <id> [--raw] (try /tasks to list ids)`)
        const record = (await loadStore()).tasks.find(task => task.id === id)
        if (!record) throw new Error(`Task not found: ${id} (try /tasks to list ids)`)
        if (command === '/result') {
          if (raw) ui.note(JSON.stringify(record, null, 2))
          else if (ui.page) await ui.page(`Task ${id}`, taskDetailLines(record, viewWidth()).map(row => row.text))
          else ui.block?.(taskDetailLines(record, viewWidth()))
        } else if (command === '/events') {
          const events = await bus.list(id)
          if (raw) ui.note(JSON.stringify(events, null, 2))
          else if (ui.page) await ui.page(`Events ${id}`, eventTrailLines(events, viewWidth()).map(row => row.text))
          else ui.block?.(eventTrailLines(events, viewWidth()))
        }
        else {
          if (!['queued', 'failed'].includes(record.status)) throw new Error(`Cannot run task in status: ${record.status} (expected queued or failed; /result ${id} to inspect)`)
          if (!record.engineeringTask.verification?.testCommands.length) throw new Error('Stored task needs verification commands before running.')
          if (!(await stat(record.engineeringTask.workspace)).isDirectory()) throw new Error(`Workspace must be a directory: ${record.engineeringTask.workspace} (pass --workspace dir).`)
          ui.sessionTitle?.(sessionTitleFor(record.engineeringTask.objective))
          if (await approveOrBlock(ui, record.engineeringTask) === 'approved') {
            ui.running?.(true)
            try {
              const controller = new AbortController()
              running = controller
              // Same keyboard contract as a fresh request: Esc interrupts,
              // typing composes the next request instead of vanishing. The
              // keyboard belongs to whoever owns the draft (see ReplUi.watchRun),
              // never to this loop.
              const stop = ui.watchRun?.(abortRun) ?? (() => {})
              try { await runRecorded(id, bus, sink, controller.signal, record.engineeringTask.workspace) } finally {
                stop()
                if (operatorAbort) {
                  ui.note('run halted at your request — nothing further ran.')
                  operatorAbort = false
                }
              }
            } finally {
              running = null
              ui.running?.(false)
            }
          }
        }
        continue
      }
      // Zero-config path (2026-10-03): a bare request just works. Explicit
      // flags still win; otherwise the workspace decides. We only warn when
      // the guess is untrustworthy — never a blocking prompt mid-flow.
      // Inline flags (`fix X --test "cmd"`) are honored per request: the help
      // advertises them, so swallowing them into the objective text would be a
      // lie. Quoted values stay intact.
      //
      // The keyboard watches the BUILD from here. Enter detached the composer
      // and the approval gate attaches only after the repo analysis, so
      // without this the app sits for seconds with no input listener at all:
      // typing shows nothing, arrows and Enter queue into whatever attaches
      // next (a stray "/" lands inside the gate, which ignores it, and Enter
      // there silently cancels the run), and Ctrl+C stops being a key and
      // becomes a SIGINT that exits. That whole picture was reported as "type
      // / and everything freezes" (2026-10-16). With the watcher the terminal
      // stays in raw mode and a press means "forget this request".
      const inline = parseInlineFlags(line)
      if (!inline.objective) throw new Error('Supply a request first (flags alone do not run anything).')
       // Intent router (2026-10-30, chunk 4): the referee between chat and
       // build. Questions and conversation answer directly (streamed, with
       // session memory); build work runs the pipeline and the approval
       // gate. BUILD signals win, chat is the default remainder — a wrong
       // build costs one denied card, a wrong chat silently builds nothing.
       const intent = classifyIntent(inline.objective.trim())
       if (intent.intent === 'chat' && inline.objective.trim().length > 1) {
         // Chat (2026-10-30, real chat loop): a question is a conversation
         // turn — streamed in pieces, carried with session memory, routed
         // to the ACTIVE CREW's conversational seat (the team the operator
         // built and selected), not one hardcoded model. Concrete build
         // work below this gate still runs the factory pipeline.
         const crew = activeCrew()
         const seatModel = crew?.seats[0]?.model?.trim() ?? ''
         const resolved = resolveChatRoute(seatModel)
         if ('blocker' in resolved) {
           ui.note(`Chat blocked: ${resolved.blocker}`)
           continue
         }
         let route: ChatRoute = resolved.route
         // A seat id from another provider is meaningless on this route (a
         // bare local id inside OpenRouter): keep the route's model, say so.
         if (seatModel && seatFitsRoute(route, seatModel)) {
           route = { ...route, model: seatModel }
         } else if (seatModel) {
           ui.note(`Crew seat ${seatModel} does not fit the ${route.name} route — using ${route.model}.`)
         }
         // Auto-compaction BEFORE the request (2026-11-01): at ≥67% of the
         // window keep room to work, at ≥87% keep only the newest exchange.
         // Sending the full history instead let the server silently truncate
         // the operator's own request out of the prompt.
         {
           const budget = resolvePromptBudget()
           const compacted = compactHistory(chatHistory, { budget })
           if (compacted.level !== null && compacted.dropped > 0) {
             chatHistory.length = 0
             chatHistory.push(...compacted.history)
             ui.note(`context ${compacted.level === 'hard' ? 'nearly full' : 'filling up'} — compacted ${compacted.dropped} older turn${compacted.dropped === 1 ? '' : 's'} (~${compacted.before} → ~${compacted.after} tokens)`)
             ui.context?.(compacted.after)
           }
         }
         ui.running?.(true)
         const chatStartedAt = Date.now()
         const chatAbort = new AbortController()
         const stopWatch = screen?.watchInterrupt(() => { chatAbort.abort() }) ?? (() => {})
         /**
          * THE ONE LIVE ROW of this turn.
          *
          * On the SCREEN there is exactly one row for the whole turn: it
          * streams the reasoning, the answer joins it, and it ends honestly
          * (a failed turn says `stopped`, not `thinking`). The key is unique
          * per turn — a reused key makes the next turn eat this one's row.
          *
          * On a PIPE there is no screen to rewrite, so the classic path keeps
          * printing the thinking header and the lines as they complete.
          */
         const liveKey = `chat:${++chatTurns}`
         let reasoningText = ''
         let answerText = ''
         let chatPhase: 'reasoning' | 'answering' = 'reasoning'
         const paintLive = (outcome: 'ok' | 'failed' = 'ok'): void => {
           ui.live?.(liveKey, chatLiveRow(reasoningText, answerText, chatPhase, outcome))
         }
         // The activity line names the real thing while the chat is live:
         // who is answering and whether it is thinking or answering. It used
         // to fall back to a rotating decorative verb ("winding…"), which
         // said nothing about a chat at all.
         ui.chatActivity?.({ role: 'chat', detail: 'thinking' })
         // The answer arrives in pieces; the terminal wants lines. Deltas
         // buffer to the next newline (an 80-column guard flushes one very
         // long unbroken line), so streaming reads as text, not fragments.
         let lineBuf = ''
         let answering = false
         const onDelta = (piece: string): void => {
           // The answer supersedes the thinking: once real content arrives,
           // the row says so instead of claiming the model is still thinking.
           if (!answering) {
             answering = true
             thinkingOpen = false
             chatPhase = 'answering'
             ui.chatActivity?.({ role: 'chat', detail: 'answering' })
             if (thinkBuf.trim()) ui.block?.([{ text: `  │ ${thinkBuf.trim()}`, tone: 'dim' }])
             thinkBuf = ''
           }
           if (ui.live) {
             // The screen path: the answer goes INTO the live row, so the
             // operator sees it once, growing, in the place the thinking was.
             // Pushing it as rows as well would show it twice.
             answerText += piece
             paintLive()
             return
           }
           lineBuf += piece
           let nl = lineBuf.indexOf('\n')
           while (nl !== -1) {
             ui.note(lineBuf.slice(0, nl) || '·')
             lineBuf = lineBuf.slice(nl + 1)
             nl = lineBuf.indexOf('\n')
           }
           if (lineBuf.length >= 80) { ui.note(lineBuf); lineBuf = '' }
         }
         // Thinking is VISIBLE (2026-11-01): a slow 3B model used to sit behind
         // a spinner with nothing on screen, which reads as a frozen app. A
         // reasoning model's `reasoning_content` now streams as dim rows under
         // one `✻ thinking` header, and non-reasoning models simply never open
         // it. Bounded so a rambling model cannot bury the session.
         let thinkingOpen = false
         let thinkBuf = ''
         let thinkLines = 0
         // Twelve lines, not twenty-four (2026-11-04): a 3B reasoning model
         // narrates every checklist step, and a full-screen thinking block
         // pushed the actual answer and the run's own rows off the page. The
         // tail says more is there instead of pretending the thought ended.
         const THINK_LINE_CAP = 12
         /** Model prose, minus the markdown it cannot render. */
         const tidyThought = (line: string): string =>
           line.replace(/\*\*/g, '').replace(/^\s*[-*]\s+/, '· ').trimEnd()
         const onReasoning = (piece: string): void => {
           if (answering) return
           if (ui.live) {
             // The screen path: the reasoning goes INTO the one live row,
             // which is rewritten as the words arrive. The old grammar pushed
             // a `✻ thinking` header and then a row per line — a wall, and a
             // header that still said "thinking" after the turn was over.
             reasoningText += piece
             paintLive()
             return
           }
           if (!thinkingOpen) {
             thinkingOpen = true
             ui.block?.([{ text: '✻ thinking', tone: 'dim' }])
           }
           thinkBuf += piece
           let nl = thinkBuf.indexOf('\n')
           while (nl !== -1) {
             const line = thinkBuf.slice(0, nl)
             thinkBuf = thinkBuf.slice(nl + 1)
             if (thinkLines < THINK_LINE_CAP) {
               const text = tidyThought(line)
               if (text.trim()) ui.block?.([{ text: `  │ ${text}`, tone: 'dim' }])
               thinkLines++
             } else if (thinkLines === THINK_LINE_CAP) {
               thinkLines++
               ui.block?.([{ text: '  │ … thinking continues', tone: 'dim' }])
             }
             nl = thinkBuf.indexOf('\n')
           }
           if (thinkBuf.length >= 100) {
             if (thinkLines <= THINK_LINE_CAP) ui.block?.([{ text: `  │ ${thinkBuf}`, tone: 'dim' }])
             thinkLines++
             thinkBuf = ''
           }
         }
         try {
           const userText = inline.objective.trim()
           // Memory only on a completed turn: a failed or halted exchange is
           // not remembered, so the next turn keeps question/answer order.
           const answer = await chatComplete(
             route,
             buildChatRequest(chatHistory, userText),
             onDelta,
             chatAbort.signal,
             onReasoning,
           )
           if (lineBuf.trim()) ui.note(lineBuf)
           lineBuf = ''
           // The live row is final: the reasoning is frozen and the answer
           // stands under it. Nothing is still "thinking" now.
           paintLive()
           // A turn that worked ends the failure streak: the next failure is a
           // NEW fact and gets its own card.
           lastChatFailure = ''
           chatFailureStreak = 0
           chatHistory.push({ role: 'user', content: userText }, { role: 'assistant', content: answer.text })
           // Window pressure first: `tokensIn` is what this turn actually
           // carried, which is the only true measure of how full the context is.
           if (answer.tokensIn > 0) ui.context?.(answer.tokensIn)
           // Auto-compaction is never silent: if turns were dropped to fit the
           // window, the operator must know the model is no longer reading them.
           if ((answer.droppedTurns ?? 0) > 0) {
             ui.note(`context was full — dropped ${answer.droppedTurns} older turn${answer.droppedTurns === 1 ? '' : 's'} to fit the window`)
           }
           // The turn receipt (Hermes' `⋯ 2.1s · model · tokens` grammar): the
           // answer alone leaves the operator guessing WHICH model spoke and
           // what it cost. Same shape as the run receipt, so one session reads
           // consistently.
           const seconds = ((Date.now() - chatStartedAt) / 1000).toFixed(1)
           const cost = answer.tokensIn || answer.tokensOut
             ? ` · ${answer.tokensIn} in / ${answer.tokensOut} out`
             : ''
           ui.note(`⋯ ${seconds}s · ${route.name}/${route.model}${cost}`)
           if (!chatTipShown) {
             chatTipShown = true
             ui.note('Tip: to build something, phrase it as a task — e.g. "Add a hello world function --test \"node -e \\\"console.log(42)\\\"\""')
           }
         } catch (err) {
           lineBuf = ''
           thinkBuf = ''
           const why = safeError(err)
           const reason = chatFailureLine(why)
           // A turn the OPERATOR stopped is not a failure. It said
           // "Chat failed: This operation was aborted", which reads as the
           // app breaking when the app did exactly what it was told.
           const stopped = chatAbort.signal.aborted
           // A rejected model id is a picker problem, not a build problem: say
           // which, so the next action is `/model`, not a reformulated task.
           const badModel = /not a valid model id|invalid model|model not found|404/i.test(why)
           // The live row closes honestly: a stopped turn says `stopped`, not
           // `thinking`. A row that still claims to be thinking after the
           // turn is over is a lie the operator has to read past.
           if (ui.live) paintLive('failed')
           if (stopped) {
             ui.note('Chat stopped at your request — nothing was sent.')
           } else {
             // A failure is a CARD, not two prose rows: the cause, what did not
             // happen, and the one next action. The old pair wrapped into a
             // full-width wall that read as the app breaking rather than as a
             // turn that never started.
             const nextStep = badModel
               ? 'That id is not in the route\'s catalogue — /model to pick one it lists, then retry.'
               : 'Ask for the build as a task: "build index.html --test ..." and approve the card.'
             // The SAME failure twice is one fact, not two cards: three identical
             // `Chat failed` cards in a row (operator report, 2026-11-04) read
             // as the app breaking. The second and later ones collapse into a
             // counted line; a turn that WORKS resets the streak.
             const receipt = chatFailureReceipt(reason, nextStep, { reason: lastChatFailure, count: chatFailureStreak })
             lastChatFailure = reason
             chatFailureStreak = receipt.count
             if (receipt.repeat) {
               ui.note(receipt.text)
             } else if (ui.panel) {
               ui.panel('Turn failed', receipt.lines)
             } else {
               ui.note(receipt.text)
               // Say what did NOT happen. An operator who just asked for a
               // website reads an empty folder as "the build silently did
               // nothing" — it never started one.
               ui.note(`Nothing was built: a chat turn never writes files. ${nextStep}`)
             }
           }
         } finally {
           stopWatch()
           ui.running?.(false)
           // The chat is over: the activity line must stop naming a seat that
           // is no longer working.
           ui.chatActivity?.(null)
         }
         continue
       }
      let buildCancelled = false
      const stopBuildWatch = screen?.watchInterrupt(() => { buildCancelled = true }) ?? (() => {})
      let task: EngineeringTask
      try {
        const auto = defaults.tests.length > 0 || inline.tests.length > 0
          ? null
          : detectDefaults(inline.workspace ?? defaults.workspace)
        if (auto && !hasProjectMarker(inline.workspace ?? defaults.workspace)) {
          // Name the intent, not the generated script: the old note printed the
          // whole `node -e "…"` guess, three wrapped lines of shell before the
          // operator had even seen the approval card.
          ui.note(`No project file in ${inline.workspace ?? defaults.workspace} — ${verificationLabel(auto.tests)}. Pass --test "command" to be exact.`)
        }
        // The guess names `npm test` but package.json has no test script: that
        // run is red before it starts. Say so at approval time, not after.
        const ws = inline.workspace ?? defaults.workspace
        if (auto && hasProjectMarker(ws) && auto.tests.some(t => t.includes('npm test')) && !packageHasTestScript(ws)) {
          ui.note('Note: package.json has no "test" script — "npm test" will fail. Pass --test "command" to be exact.')
        }
        const tests = inline.tests.length > 0 ? inline.tests : auto ? auto.tests : [...defaults.tests]
        const requiredFiles = [...defaults.requiredFiles, ...inline.requiredFiles]
        // makeTask walks the whole workspace (languages, key files, test files)
        // to build the plan, which on a real repo takes long enough to look like
        // a hang: the confirm card used to appear a beat after Enter with a dead
        // screen in between. Say what is happening, and keep the scanner lit.
        //
        // Progress goes through `ui`, NOT through the Screen: `replLoop` has no
        // screen state (and must not reach for one — the previous
        // `screen.notify(state, …)` here referenced a `state` that only exists in
        // screenRepl's closure, so every request on the TTY path died with
        // "state is not defined" while every piped test passed).
        ui.progress?.('reading workspace…')
        ui.running?.(true)
        try {
          task = await makeTask(inline.objective, tests, requiredFiles, inline.workspace ?? defaults.workspace, auto)
        } finally {
          ui.running?.(false)
        }
      } finally {
        stopBuildWatch()
      }
      // A press during the build lands after it (the walk cannot be cut
      // mid-flight), and the honest answer then is "forget this request" —
      // not a gate for a run the operator already waved off.
      if (buildCancelled) {
        ui.note('cancelled by operator.')
        continue
      }
      ui.sessionTitle?.(sessionTitleFor(task.objective))
      const gate = await approveOrBlock(ui, task)
      if (gate === 'approved') {
        ui.running?.(true)
        try {
          // Esc during a run interrupts it (opencode footer promise): a
          // keypress watch arms an AbortController handed to the run. Ctrl+C on
          // the classic path reaches the same controller through SIGINT.
          const controller = new AbortController()
          running = controller
          // Same keyboard contract as the /run path above: the draft is the
          // screen's, so the watch is armed through the ui hook, not here.
          const stop = ui.watchRun?.(abortRun) ?? (() => {})
          try {
            await submitAndRun(task, bus, sink, controller.signal)
          } finally {
            stop()
            if (operatorAbort) {
              ui.note('run halted at your request — nothing further ran.')
              operatorAbort = false
            }
            running = null
            if (screen) screen.requestAbort = false
          }
        } finally {
          ui.running?.(false)
        }
      } else if (gate === 'cancelled' && screen) {
        // Classic approve() prints this itself; the screen dialog resolves
        // silently, so the stream needs the receipt or a cancel reads as a
        // freeze (nothing happened, no message). A BLOCKED run never reaches
        // here — it already printed why, and claiming the operator cancelled
        // work they never saw would be a second lie on top of the first.
        ui.note('cancelled by operator.')
      }
    } catch (error) {
      ui.error(`error: ${safeError(error)}`)
      // Interactive input errors do not discard the session.
    }
  }
  }
}

/**
 * The CLI entry point, exported rather than self-invoked.
 *
 * It used to run at import time, which made this module UNTESTABLE: every
 * `import` of harness.ts started a session that took over stdin. That is the
 * same hole, one level up, that let "state is not defined" ship — the screen
 * path could not be driven in-process, so it had no tests at all. `bin/wednesday.js`
 * now calls `main()` explicitly, and `dispatch-test.ts` can import the dispatch
 * loop and drive it with a real Screen.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const rawArgs = argv
  // Reversible fallback: --classic restores the JSON task preview.
  const classic = rawArgs.includes('--classic')
  const args = rawArgs.filter(arg => arg !== '--classic')
  await loadConfig()
  if (args[0] === '--setup') {
    const { setup } = await import('./setup')
    await setup()
    return
  }
  if (args[0] === '--help') {
    console.log('Wednesday — one application, seven internal engineering layers (development build)')
    console.log('Usage: wednesday                      (just type what you want)')
    console.log('       wednesday "fix the login leak" (one-shot run, approve inline)')
    console.log('       wednesday --repl [--workspace dir] [--classic]')
    console.log('       wednesday --resume [id] (reopen the last saved session)')
    console.log('       wednesday connect  (point at a tunnel · probe · save)')
    console.log('       wednesday --setup  (private local key + model setup)')
    console.log('       wednesday status   (route · model · pool · shape)')
    console.log('       wednesday doctor   (readiness check, read-only)')
    console.log('       wednesday --version')
    console.log('Flags (optional): --test "cmd" --required-file path --workspace dir')
    console.log('Local development link: npm link; remove command: npm uninstall --global wednesday')
    console.log(HELP)
    return
  }
  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
    console.log(`wednesday ${pkg.version ?? 'unknown'}`)
    return
  }
  if (args[0] === 'connect') {
    await connectCli()
    return
  }
  if (args[0] === 'status') {
    const { renderStatus } = await import('./status')
    console.log(renderStatus(process.env, undefined, {}, activeCrew()))
    return
  }
  if (args[0] === 'doctor') {
    const { renderDoctor, runDoctor } = await import('./doctor')
    const rendered = renderDoctor(await runDoctor())
    console.log(rendered.text)
    if (!rendered.ok) process.exitCode = 1
    return
  }
  if (args[0] === 'uninstall') {
    const { uninstallCli } = await import('./uninstall')
    await uninstallCli(args.slice(1))
    return
  }
  // Update notice: TTY humans only — never in piped/scripted runs, never in
  // deterministic mode, never blocking. Opt out with WEDNESDAY_NO_UPDATE_CHECK=1.
  const toScreen = isTty() && !classic && (!args.length || args[0] === '--repl')
  const updateNotice = async (): Promise<string | null> => {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
    if (typeof pkg.version !== 'string') return null
    // force: EVERY start really checks the registry (operator, 2026-11-01).
    // The cache still stores the remote version, so the home banner survives
    // cache-hit days without an extra fetch.
    return checkForUpdates({ version: pkg.version, stateDir: STATE_HOME, force: true })
  }
  // Exit-time check (operator, 2026-11-01): every close re-checks too, so a
  // release that landed mid-session is named on the way out. Skipped on the
  // auto-restart handoff (WEDNESDAY_JUST_UPDATED=1) — the child just updated.
  const exitUpdateCheck = async (enabled: boolean): Promise<void> => {
    if (!enabled || !shouldAutoRestart()) return
    try {
      const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
      if (typeof pkg.version !== 'string') return
      const notice = await checkForUpdates({ version: pkg.version, stateDir: STATE_HOME, force: true })
      if (notice) console.error(`\n${notice}\n`)
    } catch { /* a failed exit check is not news */ }
  }
  const wantUpdateCheck = stdin.isTTY && stdout.isTTY &&
    (process.env.FACTORY_EXECUTION_MODE ?? 'live').trim().toLowerCase() !== 'deterministic' &&
    process.env.WEDNESDAY_NO_UPDATE_CHECK !== '1'
  const advisories: StartupAdvisories = {}
  if (wantUpdateCheck) {
    advisories.update = async () => {
      try {
        return await updateNotice()
      } catch {
        return null
      }
    }
  }
  if (!toScreen && wantUpdateCheck) {
    const notice = await advisories.update!()
    if (notice) console.error(`\n${notice}\n`)
  }
  // One reader for the whole session — and only when the classic line
  // mode actually needs it. Creating it eagerly gave the TUI a SECOND reader
  // on stdin: readline echoes whatever it does not recognise, so every mouse
  // report landed on screen as `0;42;16M` text. The screen path owns stdin.
  // One reader for the whole session, created lazily by the classic prompt —
  // and only when the classic line mode actually needs it. Creating it eagerly
  // gave the TUI a SECOND reader on stdin: readline echoes whatever it does not
  // recognise, so every mouse report landed on screen as `0;42;16M` text. The
  // screen path owns stdin. See classic-ask.ts for the recall + EOF contract.
  const ask: Ask = createClassicAsk({ input: stdin, output: stdout })
  const bus = new PersistentFactoryEventBus({
    filePath: EVENTS_PATH,
  })
  try {
    // A damaged legacy store must never kill a fresh session: start empty and
    // say so, like the health meter's fail-open rule below.
    try {
      await migrateLegacyState()
    } catch (error) {
      console.error(`startup note: legacy state not migrated (${safeError(error)}); starting fresh.`)
    }
    // Startup health: one advisory line + history entry, never blocking.
    // Offline-safe (~1s, no spend, no model calls). Opt out for scripts
    // with WEDNESDAY_NO_STARTUP_HEALTH=1.
    // On the screen path the meter is handed to screenRepl and runs after
    // enter(), reported as a toast — visible, and off the critical path.
    if (process.env.WEDNESDAY_NO_STARTUP_HEALTH !== '1') {
      advisories.health = async () => {
        try {
          const report = await runHealthChecks()
          recordHealthReport(report)
          const lamp = report.overall === 'ok' ? 'OK' : report.overall === 'degraded' ? 'WARN' : 'DOWN'
          return `health: ${lamp} (${report.checks.length} checks) — /health for detail`
        } catch {
          return null
        }
      }
      if (!toScreen) {
        const line = await advisories.health()
        if (line) console.log(`startup ${line}`)
      }
    }
    if (!args.length || args[0] === '--repl') {
      await repl(args.length ? args.slice(1) : [], bus, ask, classic, advisories)
      await exitUpdateCheck(wantUpdateCheck)
      return
    }
    if (args[0] === '--resume') {
      await repl(args, bus, ask, classic, advisories)
      await exitUpdateCheck(wantUpdateCheck)
      return
    }
    const request = args.shift()!.trim()
    if (!request || request.startsWith('--')) throw new Error('Supply a request first.')
    const { tests, requiredFiles, workspace } = parseFlags(args)
    const task = await makeTask(request, tests, requiredFiles, workspace)
    if (await approve(task, ask, classic)) await submitAndRun(task, bus)
  } finally {
    ask.close()
  }
}

/**
 * Run the CLI, then exit safely.
 *
 * Exported (not a bare top-level `void main()`) so importing this module has no
 * side effects — see the note on `main`.
 */
export async function run(argv?: string[]): Promise<void> {
  return main(argv).catch(error => {
    console.error(`error: ${safeError(error)}`)
    process.exitCode = 1
  }).finally(() => {
  // The cordis Context retains handles (event bus, sqlite, timers). Calling
  // process.exit() with them still open tears those handles down mid-close,
  // which trips libuv's UV_HANDLE_CLOSING assert on Windows: the child dies
  // with 0xC0000409 before Node can flush, on roughly half of all runs. Let the
  // loop drain first and only force the exit if something is still holding it
  // open after a short grace period. The timer is unref'd, so a clean shutdown
  // never waits for it.
    process.exitCode = process.exitCode ?? 0
    try { stdin.pause() } catch { /* not a TTY, or already closed */ }
    const bail = setTimeout(() => process.exit(process.exitCode ?? 0), 500)
    if (typeof bail.unref === 'function') bail.unref()
  })
}

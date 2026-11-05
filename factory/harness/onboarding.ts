/**
 * First-run onboarding — what Hermes/pi-ai do on a fresh install.
 *
 * Trigger: the screen REPL runs `maybeOnboard(ui)` once, before the first
 * prompt, and only when this machine has never been set up (no
 * `~/.wednesday/.env` AND no `onboarded.json` flag in the state dir). A
 * machine that already has a config is marked done silently — upgrading
 * must never replay a tutorial at an existing operator.
 *
 * The flow itself is four steps, all reusing the real commands so the
 * onboarding can never drift from the product:
 *   1. welcome card (what Wednesday is, in three lines)
 *   2. `/connect` — point at a provider/tunnel/local server, probe, save
 *   3. choose: one model now (the /model plate) · create a team (/create)
 *      · skip — every step is a command and can be run later
 *   4. prove it — one tiny real worker turn, verified on disk (skippable).
 *      The first real request used to be the first test of the route; when it
 *      was broken the operator paid for a failed run and the card blamed the
 *      wrong cause (B195). The proof is the cheap, honest result moment.
 * Then a tips card and the flag is written. `/onboard` re-runs it on
 * demand. `WEDNESDAY_NO_ONBOARDING=1` opts out entirely.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_PATH } from './config'
import { STATE_HOME } from '../paths'
import { connectFlow, type ConnectUi } from './connect'
import { proofRoute, renderProof, runProof, type ProofResult } from './proof'
import type { SelectOption } from './screen'
import type { ViewLine } from './views'

export interface OnboardUi extends ConnectUi {
  block?(lines: ViewLine[]): void
}

export interface OnboardingDeps {
  configPath?: string
  stateDir?: string
  connectFlowImpl?: typeof connectFlow
  /** The /model plate's choice handler (solo start). */
  modelPickImpl?: (ui: OnboardUi) => Promise<void>
  /** The /create flow (team start). */
  createTeamImpl?: (ui: OnboardUi) => Promise<void>
  /**
   * The 60-second proof. The default is the real worker turn; tests stub it
   * so onboarding never spawns a model. It must return a receipt, not throw.
   */
  proveItImpl?: (ui: OnboardUi) => Promise<ProofResult>
}

export function onboardedFlagPath(stateDir = STATE_HOME): string {
  return join(stateDir, 'onboarded.json')
}

export function markOnboarded(stateDir = STATE_HOME): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(onboardedFlagPath(stateDir), JSON.stringify({ at: new Date().toISOString() }), 'utf8')
  } catch { /* the flag is best-effort; a failed write just replays onboarding next start */ }
}

/** True when this machine has never completed setup. Marks silently when a config already exists. */
export function onboardingNeeded(opts: { configPath?: string; stateDir?: string } = {}): boolean {
  if (process.env.WEDNESDAY_NO_ONBOARDING === '1') return false
  const configPath = opts.configPath ?? CONFIG_PATH
  const stateDir = opts.stateDir ?? STATE_HOME
  if (existsSync(onboardedFlagPath(stateDir))) return false
  if (existsSync(configPath)) {
    markOnboarded(stateDir)
    return false
  }
  return true
}

const WELCOME = [
  'wednesday — one terminal command, a whole engineering backend behind it.',
  '',
  'You describe a task. Wednesday plans it, builds it, verifies it with real',
  'commands, repairs what fails, and hands you a receipt. You approve once.',
  '',
  'Your keys never leave this machine: they live in ~/.wednesday/.env,',
  'outside any repository.',
]

const TIPS = [
  'type a request in plain language — that is the whole UI',
  '/connect   point at a provider, tunnel, or local model server',
  '/model     pick one model, or a whole team by name',
  '/create    build a named team (name + a model per seat)',
  '/proof     re-run the tiny real task — same route as a build',
  '/help      every command · /doctor checks readiness · /tasks lists runs',
  'esc interrupts a live run · ctrl+c twice exits · / to browse commands',
]

export async function runOnboarding(ui: OnboardUi, deps: OnboardingDeps = {}): Promise<void> {
  const say = (lines: string[]): void => {
    if (ui.block) ui.block(lines.map(text => ({ text, tone: 'plain' as const })))
    else ui.note(lines.join('\n'))
  }

  say(WELCOME)
  ui.note('')
  ui.note('step 1 of 3 — connect a model source (this probes it, then saves):')
  const connect = deps.connectFlowImpl ?? connectFlow
  const result = await connect(ui, { path: deps.configPath })
  if (!result.ok && !result.cancelled) ui.note('no connection yet — you can run /connect again anytime.')

  ui.note('')
  ui.note('step 2 of 3 — how do you want to work?')
  let pick: string | undefined
  if (ui.select) {
    pick = await ui.select('Start with', [
      { title: 'One model, right now', desc: 'pick from the /model plate — fastest way to a first run', value: 'solo' },
      { title: 'Create a team', desc: 'name it and give each seat a model — /model <team> switches later', value: 'team' },
      { title: 'Skip for now', desc: '/connect · /model · /create are always there', value: 'skip' },
    ])
  } else {
    const answer = (await ui.ask('Start with: 1) one model  2) create a team  3) skip [1-3]: '))?.trim()
    pick = answer === '2' ? 'team' : answer === '3' ? 'skip' : answer === '1' || answer === '' ? 'solo' : undefined
  }
  if (pick === 'solo' && deps.modelPickImpl) await deps.modelPickImpl(ui)
  else if (pick === 'team' && deps.createTeamImpl) await deps.createTeamImpl(ui)

  // Step 3 is the RESULT moment, not another setup form: one tiny real turn
  // through the same worker a build uses, verified on disk. It is skippable and
  // never a gate — a failed proof is a named route problem, not a dead end.
  ui.note('')
  const route = proofRoute()
  if (route.problem) {
    ui.note(`step 3 of 3 — proof skipped: ${route.problem}`)
  } else {
    ui.note('step 3 of 3 — prove it: one tiny real task through the same worker a build uses.')
    let prove = false
    if (ui.select) {
      const choice = await ui.select('Prove it now?', [
        {
          title: 'Run the 60-second proof',
          desc: `one real file written and verified by ${route.model} — recommended`,
          value: 'run',
        },
        { title: 'Skip', desc: 'type your first request instead', value: 'skip' },
      ])
      prove = choice === 'run'
    } else {
      const answer = (await ui.ask('Run the 60-second proof? [Y/n]: '))?.trim().toLowerCase()
      // EOF is not consent to spend a model call.
      prove = answer !== undefined && answer !== 'n' && answer !== 'no'
    }
    if (prove) {
      const proof = deps.proveItImpl ?? runProof
      const receipt = await proof(ui)
      renderProof(ui, receipt)
    } else {
      ui.note('proof skipped — your first request will use the same route.')
    }
  }

  ui.note('')
  say(TIPS)
  markOnboarded(deps.stateDir)
  ui.note('')
  ui.note('onboarding done — saved. Type your first request below. (/onboard runs this again)')
}

/** Run the onboarding only when this machine has never been set up. */
export async function maybeOnboard(ui: OnboardUi, deps: OnboardingDeps = {}): Promise<void> {
  if (!onboardingNeeded(deps)) return
  await runOnboarding(ui, deps)
}

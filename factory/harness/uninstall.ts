/**
 * `wednesday uninstall` (CLI only) — remove Wednesday's local footprint.
 *
 * Two scopes, deliberately separated:
 *   1. USER DATA — `~/.wednesday/.env` (keys) and `~/.wednesday/state/`
 *      (sessions, events, crews, caches). Deleted only after an explicit
 *      confirm gate; the receipt lists every path that was removed.
 *   2. THE PACKAGE — `npm rm -g @lab1207/wednesday`. Only ever run when the
 *      operator passes `--package`.
 *
 * The TUI menu deliberately does NOT carry /uninstall (operator decision
 * 2026-11-01): a terminal UI must not delete its own config mid-session. The
 * website's install section documents this command; typing /uninstall in the
 * TUI prints these instructions instead of running anything.
 *
 * Never touched: the project repository, the workspace, any other app's
 * files. The plan is computed first and shown before anything is deleted.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { CONFIG_PATH } from './config'
import { redactSensitiveText } from '../security/redaction'
import { STATE_HOME } from '../paths'

export interface UninstallUi {
  note(text: string): void
  error(text: string): void
  confirm?(title: string, detail: string, yesLabel: string): Promise<boolean>
  ask?(prompt: string): Promise<string | undefined>
}

export interface UninstallPlan {
  configPath: string
  stateHome: string
  targets: string[]
}

export const PACKAGE_NAME = '@lab1207/wednesday'
export const PACKAGE_REMOVE_CMD = `npm rm -g ${PACKAGE_NAME}`

/** What uninstall WOULD delete right now (read-only). */
export function planUninstall(configPath = CONFIG_PATH, stateHome = STATE_HOME): UninstallPlan {
  const targets = [configPath, stateHome].filter(target => existsSync(target))
  return { configPath, stateHome, targets }
}

export interface UninstallResult {
  confirmed: boolean
  removed: string[]
  kept: string[]
}

export async function runUninstall(
  ui: UninstallUi,
  opts: { configPath?: string; stateHome?: string; assumeYes?: boolean } = {},
): Promise<UninstallResult> {
  // Deterministic/test mode must never delete real user data: a suite driving
  // every verb over a pipe has no business rm-ing the operator's profile.
  if (
    (process.env.FACTORY_EXECUTION_MODE ?? '').trim().toLowerCase() === 'deterministic' &&
    opts.assumeYes !== true &&
    opts.configPath === undefined &&
    opts.stateHome === undefined
  ) {
    ui.note('uninstall skipped in deterministic mode — pass explicit paths to test it.')
    return { confirmed: false, removed: [], kept: planUninstall(opts.configPath, opts.stateHome).targets }
  }
  const plan = planUninstall(opts.configPath, opts.stateHome)
  if (plan.targets.length === 0) {
    ui.note('nothing to remove — no wednesday config or state exists on this machine.')
    return { confirmed: true, removed: [], kept: [] }
  }
  const listed = plan.targets.map(target => `  ${target}`).join('\n')
  let go = opts.assumeYes === true
  if (!go) {
    if (ui.confirm) {
      go = await ui.confirm(
        'Uninstall wednesday?',
        `This permanently deletes your local wednesday data:\n${listed}\n\nThe installed package and your project repositories are NOT touched.`,
        'Yes, delete my wednesday data',
      )
    } else {
      const answer = (await ui.ask?.('Delete wednesday config + state? [y/N] '))?.trim().toLowerCase()
      go = answer === 'y' || answer === 'yes'
    }
  }
  if (!go) {
    ui.note('kept — nothing was deleted.')
    return { confirmed: false, removed: [], kept: plan.targets }
  }
  const removed: string[] = []
  for (const target of plan.targets) {
    await rm(target, { recursive: true, force: true })
    removed.push(target)
  }
  ui.note(`removed:\n${removed.map(target => `  ${target}`).join('\n')}`)
  ui.note(`to remove the installed package too, run:\n  ${PACKAGE_REMOVE_CMD}`)
  ui.note('your projects were not touched. Reinstall anytime: npm i -g @lab1207/wednesday')
  return { confirmed: true, removed, kept: [] }
}

/** `wednesday uninstall [--yes] [--package]` — the same flow on a plain terminal. */
export async function uninstallCli(args: string[]): Promise<void> {
  const assumeYes = args.includes('--yes') || args.includes('-y')
  const removePackage = args.includes('--package')
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Uninstall needs your own terminal (it asks before deleting); never pipe it.')
  }
  const readline = createInterface({ input: stdin, output: stdout, terminal: true })
  readline.on('SIGINT', () => readline.close())
  const ui: UninstallUi = {
    note: text => console.log(text),
    error: text => console.error(text),
    ask: async prompt => readline.question(prompt),
  }
  try {
    await runUninstall(ui, { assumeYes })
  } finally {
    readline.close()
  }
  if (removePackage) {
    console.log(`\nrunning: ${PACKAGE_REMOVE_CMD}`)
    const done = spawnSync('npm', ['rm', '-g', PACKAGE_NAME], { encoding: 'utf8', windowsHide: true })
    if (done.status === 0) console.log('package removed.')
    else console.error(`npm rm failed (exit ${done.status}): ${redactSensitiveText((done.stderr ?? '').trim())}`)
  }
}

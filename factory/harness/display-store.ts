/**
 * Display store — transcript density, remembered across sessions.
 *
 * A run's rail has three honest densities. `quiet` keeps the stages and the
 * answer but drops the tool rows and the diff (the shape an operator wants
 * when they trust the run and only read the outcome). `normal` is the default:
 * identical calls fold into one row and the patch is bounded. `verbose` keeps
 * every call and raises the patch budget, for the run you need to audit.
 *
 * The mode is a SETTING, not session state: opening a new terminal should not
 * silently put the rail back to a density the operator changed away from. So
 * it lives next to the crew store, in `~/.wednesday/state/display.json` — never
 * the repo, never a session ledger.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME } from '../paths'

export type DisplayMode = 'quiet' | 'normal' | 'verbose'

export const DISPLAY_MODES: DisplayMode[] = ['quiet', 'normal', 'verbose']

/** What each density means, in the operator's words (getter + receipt). */
export const DISPLAY_HINTS: Record<DisplayMode, string> = {
  quiet: 'stages and answers, no tool rows or diff',
  normal: 'tool runs fold · short diff',
  verbose: 'every tool call · full diff',
}

export function isDisplayMode(value: string): value is DisplayMode {
  return (DISPLAY_MODES as string[]).includes(value)
}

function displayFile(): string { return join(STATE_HOME, 'display.json') }
function ensureDir(): void { try { mkdirSync(STATE_HOME, { recursive: true }) } catch { /* exists */ } }

/**
 * The saved mode, or `normal`.
 *
 * A missing file, unreadable JSON, or a mode this build does not know all mean
 * the same thing: the operator never chose a density here, so the default is
 * the one to run. Guessing from a corrupt file is how a broken write would
 * turn into a transcript that silently hides work.
 */
export function loadDisplay(): DisplayMode {
  ensureDir()
  if (!existsSync(displayFile())) return 'normal'
  try {
    const raw = JSON.parse(readFileSync(displayFile(), 'utf8'))
    return typeof raw?.mode === 'string' && isDisplayMode(raw.mode) ? raw.mode : 'normal'
  } catch { return 'normal' }
}

export function saveDisplay(mode: DisplayMode): DisplayMode {
  ensureDir()
  writeFileSync(displayFile(), JSON.stringify({ mode }, null, 2), 'utf8')
  return mode
}

/**
 * The run's patch, as transcript rows.
 *
 * `/review` proved this shape already: read-only, bounded, ONE `git diff` for
 * the whole set. The version that shelled out per file froze the screen for
 * eight seconds on a dirty repository (B-series), so the patch is asked for in
 * a single call and then split per file. A file with no patch (untracked, or
 * staged-only) simply does not appear — it is already named in the result
 * card's `files:` line, and inventing content for it would be a guess.
 *
 * This is `changes vs HEAD`, not "changes this run made": on a clean tree the
 * two are identical, and on a dirty one the pre-existing edits belong to the
 * same working tree the operator is about to read. The header says `vs HEAD`
 * so the claim is the one that is actually true.
 */
import { spawnSync } from 'node:child_process'
import { diffRow, parsePatch, type ScreenMessage } from './screen'
import type { DisplayMode } from './display-store'

/** Bound: enough patch to recognize the change, not enough to own the frame. */
export const PATCH_BUDGET = 14

/** `/display verbose`: the operator asked to audit the run, so show more. */
export const PATCH_BUDGET_VERBOSE = 40

/**
 * Rows of patch each density allows. `quiet` gets none — the operator asked
 * for the outcome, and the `files:` line in the result card still names what
 * changed. A table rather than a ternary so the policy is one fact per mode.
 */
export const PATCH_BUDGETS: Record<DisplayMode, number> = {
  quiet: 0,
  normal: PATCH_BUDGET,
  verbose: PATCH_BUDGET_VERBOSE,
}

interface PatchResult {
  rows: ScreenMessage[]
  /** True when the budget cut the patch short (the caller can hint at /review). */
  truncated: boolean
}

function git(workspace: string, args: string[]): string | null {
  const done = spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return done.status === 0 ? done.stdout : null
}

export function patchRows(workspace: string, files: string[], budget = PATCH_BUDGET): PatchResult {
  if (!files.length) return { rows: [], truncated: false }
  const patch = git(workspace, ['diff', '--no-color', '--unified=1', '--', ...files])
  if (!patch?.trim()) return { rows: [], truncated: false }
  let added = 0
  let removed = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) added++
    else if (raw.startsWith('-') && !raw.startsWith('---')) removed++
  }
  const rows: ScreenMessage[] = [{
    text: diffRow('hunk', `@@ ${files.length === 1 ? files[0] : `${files.length} files`} vs HEAD · +${added} -${removed}`),
    tone: 'plain',
  }]
  const sections = patch.split(/^diff --git /m).filter(section => section.trim())
  let shown = 0
  let truncated = false
  for (const section of sections) {
    // `a/src/x.ts b/src/x.ts` — the b-path is the file the operator knows.
    const name = /^a\/.+ b\/(.+)$/m.exec(section)?.[1]?.trim() ?? 'file'
    // One file already names itself in the header above; several need a rule
    // per file or the rows below it are anonymous.
    if (sections.length > 1) {
      if (shown >= budget) { truncated = true; break }
      rows.push({ text: diffRow('hunk', `@@ ${name}`), tone: 'plain' })
      shown += 1
    }
    for (const line of parsePatch(`diff --git ${section}`)) {
      if (shown >= budget) { truncated = true; break }
      rows.push({ text: diffRow(line.kind, line.text), tone: 'plain' })
      shown += 1
    }
    if (truncated) break
  }
  return { rows, truncated }
}

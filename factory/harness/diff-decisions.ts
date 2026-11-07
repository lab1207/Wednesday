/**
 * Acting on a diff: accept it, or throw it away (2026-11-05).
 *
 * `/review` showed what changed and stopped there. The operator who did
 * not like the change had to leave the harness and run git by hand, and
 * the one who liked it had to remember what to type. A review you cannot
 * act on is a screenshot.
 *
 * The two decisions, and what they MEAN:
 *
 *  - ACCEPT: stage the files. `git add` is the git-native "this is
 *    accepted" step: it is reversible (`git restore --staged`), it does
 *    not create a commit, and it does not rewrite history. The factory
 *    never commits on its own - the operator decides when the commit
 *    happens, with their own message, in their own tool.
 *
 *  - REJECT: put the files back the way they were. For a tracked file
 *    that is `git restore` (index and worktree back to HEAD). For a file
 *    the run CREATED, it is a delete - and a delete of the operator's
 *    own untracked file would be a disaster, so only files the run is
 *    known to have created are removed.
 *
 * Every operation is scoped to the given file list. Nothing here runs
 * `git clean`, `git reset --hard`, or any command that touches a path the
 * caller did not name.
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export interface DiffDecision {
  /** True when every named file was handled. */
  ok: boolean
  /** One line per outcome, for the receipt. */
  lines: string[]
}

function git(workspace: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const done = spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    status: done.status ?? 1,
    stdout: (done.stdout ?? '').trim(),
    stderr: (done.stderr ?? '').trim(),
  }
}

/**
 * Is a path TRACKED by git? (pure over git's answer)
 *
 * A tracked file can be restored; an untracked one can only be deleted.
 * Asking git is the honest way to tell - `git ls-files` is the index, and
 * the index is the truth about what git knows.
 */
export function isTracked(workspace: string, file: string): boolean {
  const done = git(workspace, ['ls-files', '--error-unmatch', '--', file])
  return done.status === 0
}

/**
 * Did this file exist in HEAD? (pure over git's answer)
 *
 * The difference matters for a rejection: a file that was in HEAD is
 * RESTORED, and a file that was not is one the run CREATED - restoring it
 * means removing it. `git ls-files` cannot tell the two apart once the new
 * file has been staged, so HEAD is asked directly.
 */
export function existsInHead(workspace: string, file: string): boolean {
  const done = git(workspace, ['cat-file', '-e', `HEAD:${file}`])
  return done.status === 0
}

/**
 * Stage the named files: the operator accepted this change.
 *
 * A file that cannot be staged is reported, and the OTHER files are still
 * staged - a partial accept that silently did nothing is worse than a
 * partial accept that says what happened.
 */
export function acceptFiles(workspace: string, files: string[]): DiffDecision {
  const lines: string[] = []
  let ok = true
  if (files.length === 0) {
    return { ok: false, lines: ['nothing to accept - no files were changed'] }
  }
  for (const file of files) {
    const done = git(workspace, ['add', '--', file])
    if (done.status === 0) {
      lines.push(`accepted: ${file}`)
    } else {
      ok = false
      lines.push(`could not accept ${file}: ${done.stderr || 'git add failed'}`)
    }
  }
  if (ok) {
    lines.push('staged - commit when you are ready (the factory never commits on its own)')
  }
  return { ok, lines }
}

/**
 * Put the named files back the way they were: the operator rejected this
 * change.
 *
 * Tracked files are restored (index and worktree). Untracked files - the
 * ones the run CREATED - are deleted, because leaving them behind would
 * leave the rejected work sitting in the workspace. A file that is neither
 * (already clean, or gone) is reported and skipped.
 */
export function rejectFiles(workspace: string, files: string[]): DiffDecision {
  const lines: string[] = []
  let ok = true
  if (files.length === 0) {
    return { ok: false, lines: ['nothing to reject - no files were changed'] }
  }
  for (const file of files) {
    // THE PATH CHECK COMES FIRST (2026-11-05). A path that escapes the
    // workspace is refused before git is asked anything about it, so a
    // malformed or hostile name can never reach a delete.
    const target = resolve(workspace, file)
    const root = resolve(workspace)
    if (target !== root && !target.startsWith(root + sep)) {
      ok = false
      lines.push(`refused to reject ${file}: the path is outside the workspace`)
      continue
    }
    // A file that was in HEAD is RESTORED. A file that was not is one the
    // run CREATED - even when it has already been staged, in which case
    // `git ls-files` would call it tracked and a restore would be a lie.
    if (existsInHead(workspace, file)) {
      const done = git(workspace, ['restore', '--staged', '--worktree', '--', file])
      if (done.status === 0) {
        lines.push(`rejected: ${file} (restored)`)
      } else {
        ok = false
        lines.push(`could not reject ${file}: ${done.stderr || 'git restore failed'}`)
      }
      continue
    }
    // Created by the run: drop it from the index (if it was staged) and
    // delete it from disk.
    const status = git(workspace, ['status', '--porcelain', '--', file])
    if (status.status !== 0 || !status.stdout) {
      lines.push(`already clean: ${file}`)
      continue
    }
    git(workspace, ['rm', '--force', '--cached', '--', file])
    try {
      rmSync(target, { force: true })
      lines.push(`rejected: ${file} (removed - the run created it)`)
    } catch (err) {
      ok = false
      lines.push(`could not reject ${file}: ${err instanceof Error ? err.message : 'delete failed'}`)
    }
  }
  return { ok, lines }
}

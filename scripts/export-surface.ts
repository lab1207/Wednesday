/**
 * The public repository's surface, in ONE place.
 *
 * WHY A SEPARATE MODULE: the exporter decides what the public repo gets, and
 * the release regression decides what the public repo must not contain. Two
 * copies of the allow list drift, and a drifted list is a list that lets
 * things through. Both import this.
 *
 * WHY THIS IS A SUPERSET OF THE npm TARBALL: npm's `files` array in
 * package.json ships a subset of these roots (it excludes the test files
 * and a few heavy directories), so a clean export surface is a clean npm
 * surface. The regression still checks the npm surface directly, because a
 * superset argument is only as good as the subset claim -- and the npm
 * surface is the one an installer actually gets.
 */

/** Files that are allowed into the public repository. */
export const ALLOW_FILES = new Set([
  '.gitignore',
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'THIRD_PARTY_LICENSES.md',
  'package.json',
  'package-lock.json',
])

/** Directory roots that are allowed into the public repository. */
export const ALLOW_DIRS = ['bin/', 'factory/', 'crewai/', 'ecc/', 'shared/', 'scripts/', 'media/', '.github/']

/** Never public, even though they are tracked. */
export const DENY = [
  /^docs\//,
  /^site\//,
  /^wednesday-theme\//,
  /^AGENTS\.md$/,
  /^factory\/tmp\//,
  // The Ink renderer was orphaned by the 2026-11-14 harness removal: it imports
  // deleted modules and cannot run. It is untracked locally, so it must be
  // denied by name or the exporter (which copies the working tree) ships it.
  /^factory\/tui-ink\//,
  /(^|\/)\.env/,
  /(^|\/)state\//,
]

/** Is this repository-relative path part of the public surface? */
export function allowed(file: string): boolean {
  if (DENY.some(rx => rx.test(file))) return false
  if (ALLOW_FILES.has(file)) return true
  return ALLOW_DIRS.some(dir => file.startsWith(dir))
}

/**
 * Every file the public surface would carry, from the working tree.
 *
 * WHY TRACKED FILES PLUS UNTRACKED-BUT-NOT-IGNORED: a new file that is
 * about to be committed must not be silently left out of the export, and a
 * generated/runtime file must stay out.
 */
export function publicFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter(allowed)
}

import { execFileSync } from 'node:child_process'

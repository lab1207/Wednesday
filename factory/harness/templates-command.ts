/**
 * `/templates` - the requests the operator wants to run AGAIN (2026-11-05).
 *
 * The factory could not repeat itself. The operator typed a request, it
 * ran, and the request was gone with the scrollback: there was no way to
 * save it, name it, or run it a second time. Every repeated request was
 * retyped by hand, and every retyping was a chance to type it differently.
 *
 * A template is that request, stored under the operator's own state home
 * (`~/.wednesday/state/templates.json`), never in the repo. The STORE is
 * `factory/harness/task-templates.ts`; this file is the command SURFACE -
 * the pure helpers that decide what a template looks like on screen.
 *
 * The grammar is one word per action so it works over a pipe:
 *   /templates                    list them
 *   /templates show <name>        what is in one
 *   /templates save <name>        save the request you just made
 *   /templates run <name>         run it again
 *   /templates delete <name>      forget it
 */
import type { TaskTemplate } from './task-templates'

/** One line per template for the list (pure). */
export function templateLines(templates: TaskTemplate[]): string[] {
  if (templates.length === 0) return []
  return templates.map(template => {
    const uses = template.useCount ?? 0
    const used = uses > 0 ? ` · used ${uses}x` : ''
    return `${template.name}: ${template.request}${used}`
  })
}

/**
 * The template summary for a receipt (pure).
 *
 * The request is trimmed to one line: a template whose summary is a
 * paragraph cannot be picked from a list.
 */
export function templateSummary(template: TaskTemplate): string {
  const request = template.request.replace(/\s+/g, ' ').trim()
  return request.length > 80 ? `${request.slice(0, 77)}...` : request
}

/**
 * The flags a saved template carries, as the harness wants them (pure).
 *
 * A template is a request AND its verification. Saving only the prose
 * would replay a request that no longer has the test it was written for,
 * and a replay that fails for a different reason is a confusing replay.
 *
 * Both shapes are read: the ARRAY form (what the harness writes today, so
 * a request with two `--test` flags keeps both) and the older STRING form
 * (a single test, and a comma-joined required-file list).
 */
export function templateFlags(template: TaskTemplate): { tests: string[]; requiredFiles: string[] } {
  const flags = template.flags ?? {}
  const asList = (value: string | string[] | undefined): string[] => {
    if (Array.isArray(value)) return value.map(item => item.trim()).filter(Boolean)
    if (typeof value === 'string' && value.trim()) return [value.trim()]
    return []
  }
  const requiredFiles = asList(flags['required-file'])
    .flatMap(item => item.split(','))
    .map(item => item.trim())
    .filter(Boolean)
  return {
    tests: asList(flags.test),
    requiredFiles,
  }
}

/**
 * The flags a template carries, as ONE line for a receipt (pure).
 *
 * A flag whose value is a list is printed once per value, because the
 * command line that made it had one `--flag` per value.
 */
export function templateFlagLines(template: TaskTemplate): string[] {
  const flags = template.flags ?? {}
  const lines: string[] = []
  for (const [key, value] of Object.entries(flags)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) lines.push(`--${key} "${item}"`)
  }
  return lines
}

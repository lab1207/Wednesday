/**
 * EXTERNAL SKILLS — the operator's own skills, discovered from disk
 * (2026-11-11, operator ask: "a skill directory the operator can drop in and
 * have Wednesday discover").
 *
 * WHY THIS ADAPTER EXISTS:
 *
 * Until now the factory's skills were all OURS: the DSH packages, the ECC
 * playbooks, the distilled doctrine cards. The operator could read them and
 * could not add one. That is the wrong shape for a factory whose whole point
 * is that the structure -- not the model -- carries the work: the operator's
 * own playbook is the most specific knowledge there is.
 *
 * THE SHAPE (the same one ECC uses, so the selector and the builder need no
 * new code): a skill is a DIRECTORY with a `SKILL.md` in it, whose YAML
 * frontmatter carries a `name:` and a `description:`. The body is the
 * instruction the seat receives.
 *
 * WHERE SKILLS ARE LOOKED FOR:
 *
 *   1. `<workspace>/.wednesday/skills/` -- the PROJECT's skills. They travel
 *      with the repository, so a clone brings them along.
 *   2. `~/.wednesday/skills/` -- the OPERATOR's skills. `/skills install`
 *      puts them here. This is the home that can be overridden with
 *      `WEDNESDAY_SKILLS_HOME`.
 *
 * The project home is checked FIRST: a project-specific skill is more
 * specific than a global one, and a same-named pair resolves to the project
 * copy. The same order is used by `list()` and by `load()`, so the entry the
 * operator SEES is the entry the seat GETS.
 *
 * THE NAMESPACE: `ext:`. Every external skill is `ext:<directory>`. The
 * directory name is the key, not the frontmatter name, because the directory
 * is what the operator typed and what lives on disk; the frontmatter name is
 * free to be prettier, and it is carried in the description when it differs.
 *
 * ONE BROKEN SKILL NEVER BREAKS THE CATALOG: a directory without a readable
 * `SKILL.md`, or with frontmatter the parser does not understand, is skipped
 * (and `/skills` can say why).
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { parseSkillFile, type SkillSource } from './ecc-skill-adapter'
import type { KnowledgeSkill, SelectableSkill } from './types'
import { SKILLS_HOME, workspaceSkillsHome } from '../paths'

/** The namespace every external skill carries. */
export const EXTERNAL_SKILL_PREFIX = 'ext:'

/** How much of a skill body a seat may receive (the ECC cap, same ceiling). */
const CONTENT_CAP = 2000

/**
 * The homes the adapter reads, most specific first.
 *
 * `workspace` is optional on purpose: the knowledge builder knows the
 * workspace, but a caller that does not (a listing in the terminal) still
 * gets the operator's own skills.
 *
 * `operatorHome` defaults to the operator's skills home and can be pointed
 * somewhere else -- the install flow needs to see the SAME home it writes
 * to, and a test must never touch the operator's real one.
 */
export function externalSkillHomes(
  workspace?: string,
  operatorHome: string = SKILLS_HOME,
): string[] {
  const homes: string[] = []
  if (workspace) homes.push(workspaceSkillsHome(workspace))
  homes.push(operatorHome)
  return homes
}

/** One skill on disk, with the path it was found at. */
export interface ExternalSkillEntry {
  /** The id the selector and the builder use: `ext:<directory>`. */
  id: string
  /** The directory name (the key). */
  directory: string
  /** The frontmatter name, when the file declared one. */
  declaredName?: string
  /** The frontmatter description. */
  description: string
  /** The absolute path of the skill's `SKILL.md`. */
  file: string
  /** The home it came from. */
  home: string
}

/** Why a directory was not a skill (for `/skills`, never silent). */
export interface ExternalSkillProblem {
  directory: string
  home: string
  reason: string
}

/** The whole picture: the skills, and the directories that were not skills. */
export interface ExternalSkillCatalog {
  entries: ExternalSkillEntry[]
  problems: ExternalSkillProblem[]
}

/**
 * Read every skill directory under the given homes.
 *
 * The scan is shallow on purpose: a skill is ONE directory with a `SKILL.md`
 * in it. Walking deeper would pick up the skill's own reference material as
 * if they were skills.
 */
export async function scanExternalSkills(
  homes: string[] = externalSkillHomes(),
): Promise<ExternalSkillCatalog> {
  const entries: ExternalSkillEntry[] = []
  const problems: ExternalSkillProblem[] = []
  const seen = new Set<string>()

  for (const home of homes) {
    let dirs: string[]
    try {
      dirs = (await readdir(home, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      // A home that does not exist yet is not an error: the operator has not
      // installed anything, and that is the normal state of a fresh machine.
      continue
    }
    for (const directory of dirs) {
      if (seen.has(directory)) continue
      const file = join(home, directory, 'SKILL.md')
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        problems.push({
          directory,
          home,
          reason: 'no SKILL.md in it',
        })
        continue
      }
      const parsed = parseSkillFile(text)
      if (!parsed) {
        problems.push({
          directory,
          home,
          reason: 'SKILL.md has no frontmatter with a name',
        })
        continue
      }
      seen.add(directory)
      entries.push({
        id: `${EXTERNAL_SKILL_PREFIX}${directory}`,
        directory,
        declaredName:
          parsed.name && parsed.name !== directory ? parsed.name : undefined,
        description: parsed.description,
        file,
        home,
      })
    }
  }

  return { entries, problems }
}

/**
 * The adapter the knowledge layer consumes.
 *
 * It implements the SAME `list()` / `load()` shape as every other source, so
 * the relevance ranking, the char caps and the builder are untouched.
 */
export class ExternalSkillAdapter implements SkillSource {
  constructor(private readonly homes?: string[]) {}

  async list(workspace?: string): Promise<SelectableSkill[]> {
    const homes = this.homes ?? externalSkillHomes(workspace)
    const { entries } = await scanExternalSkills(homes)
    return entries.map(entry => ({
      name: entry.id,
      description: entry.description,
      invocation: { modelInvocable: true },
    }))
  }

  async load(
    name: string,
    workspace?: string,
  ): Promise<KnowledgeSkill | undefined> {
    if (!name.startsWith(EXTERNAL_SKILL_PREFIX)) return undefined
    const directory = name.slice(EXTERNAL_SKILL_PREFIX.length)
    // A key is a directory name: no separators, no parent hops. The id comes
    // from the operator's own disk, and a skill id must never be able to
    // point outside the skills home.
    if (!directory || directory.includes('/') || directory.includes('\\')) {
      return undefined
    }
    if (directory.includes('..')) return undefined

    const homes = this.homes ?? externalSkillHomes(workspace)
    const { entries } = await scanExternalSkills(homes)
    const entry = entries.find(candidate => candidate.id === name)
    if (!entry) return undefined

    let text: string
    try {
      text = await readFile(entry.file, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseSkillFile(text)
    if (!parsed) return undefined

    const content =
      parsed.body.length <= CONTENT_CAP
        ? parsed.body
        : `${parsed.body.slice(0, CONTENT_CAP)}\n\n[truncated ${parsed.body.length - CONTENT_CAP} characters]`

    return {
      name: entry.id,
      description: entry.description,
      source: 'external-skills',
      provider: 'operator',
      content,
    }
  }
}

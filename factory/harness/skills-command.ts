/**
 * `/skills` — the operator's own skills (2026-11-11).
 *
 * THE ASK: "a skill directory the operator can drop in and have Wednesday
 * discover". Before this command the factory's skills were all ours: the DSH
 * packages, the ECC playbooks, the distilled doctrine. The operator could
 * read them and could not add one.
 *
 * THE GRAMMAR:
 *
 *   /skills                       the skills that are installed
 *   /skills path                  where they are looked for
 *   /skills install <file.skill>  install a package (or a skill folder)
 *   /skills remove <name>         remove an installed skill
 *
 * EVERY RECEIPT SAYS WHERE. A skill that was installed somewhere the
 * operator cannot find is a skill that does not exist, as far as the
 * operator is concerned.
 */

import { join } from 'node:path'

import {
  EXTERNAL_SKILL_PREFIX,
  externalSkillHomes,
  scanExternalSkills,
} from '../knowledge/external-skill-adapter'
import {
  installSkillPackage,
  removeInstalledSkill,
} from '../knowledge/skill-package'
import { SKILLS_HOME } from '../paths'

/** The surface this command needs (the harness's ReplUi satisfies it). */
export interface SkillsUi {
  note(text: string): void
  error(text: string): void
}

/** What the command needs to know about the session. */
export interface SkillsCommandOptions {
  /** The workspace, so the project's own skills are listed too. */
  workspace?: string
  /** Where installed skills live (defaults to the operator's skills home). */
  home?: string
}

/** One line per skill, with the home it came from. */
export function skillCatalogLines(
  entries: Awaited<ReturnType<typeof scanExternalSkills>>['entries'],
  homes: string[],
): string[] {
  return entries.map(entry => {
    const scope = entry.home === homes[homes.length - 1] ? 'operator' : 'project'
    const declared = entry.declaredName ? ` (frontmatter name: ${entry.declaredName})` : ''
    const description = entry.description ? ` — ${entry.description}` : ''
    return `  ${entry.id}${declared}  [${scope}]${description}`
  })
}

/**
 * Run the `/skills` command.
 *
 * @param ui - where the receipts go.
 * @param arg - the rest of the line.
 * @param options - the session's workspace and skills home.
 */
export async function skillsFlow(
  ui: SkillsUi,
  arg: string,
  options: SkillsCommandOptions = {},
): Promise<void> {
  const home = options.home ?? SKILLS_HOME
  // The listing reads the SAME home the install writes to.
  const homes = externalSkillHomes(options.workspace, home)
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  const rest = parts.slice(1).join(' ')

  if (verb === 'path' || verb === 'paths') {
    ui.note('skills are looked for in:')
    for (const homePath of homes) {
      const scope = homePath === home ? 'operator (installed)' : 'project'
      ui.note(`  ${homePath}  [${scope}]`)
    }
    ui.note('a skill is a FOLDER with a SKILL.md in it (frontmatter: name, description)')
    return
  }

  if (verb === 'install') {
    if (!rest) {
      ui.error('install what? /skills install <file.skill> (or a skill folder)')
      return
    }
    const result = await installSkillPackage(rest, home)
    if (!result.ok) {
      ui.error(`skill not installed: ${result.error}`)
      return
    }
    ui.note(
      `skill installed: ${result.name} (${result.files ?? 0} file${result.files === 1 ? '' : 's'}) → ${result.path}`,
    )
    if (result.audit) {
      ui.note(
        `  audit: ${result.audit.verdict} (${result.audit.filesScanned} file(s) scanned)`,
      )
    }
    for (const warning of result.warnings ?? []) {
      ui.note(`  ! ${warning}`)
    }
    ui.note('  it is available to the seats on the next request.')
    return
  }

  if (verb === 'remove' || verb === 'uninstall' || verb === 'rm') {
    if (!rest) {
      ui.error('remove which skill? /skills remove <name>')
      return
    }
    const name = rest.replace(new RegExp(`^${EXTERNAL_SKILL_PREFIX}`), '')
    const result = await removeInstalledSkill(name, home)
    if (!result.ok) {
      ui.error(result.error ?? 'the skill was not removed')
      return
    }
    ui.note(`skill removed: ${name} (from ${join(home, name)})`)
    return
  }

  if (verb) {
    ui.error(`unknown: /skills ${verb} — try: /skills · path · install <file.skill> · remove <name>`)
    return
  }

  // THE LISTING.
  const { entries, problems } = await scanExternalSkills(homes)
  if (entries.length === 0) {
    ui.note('no external skills yet.')
    ui.note(`  drop a folder with a SKILL.md into ${home} — it is picked up on the next request.`)
  } else {
    ui.note(`external skills: ${entries.length}`)
    for (const line of skillCatalogLines(entries, homes)) ui.note(line)
  }
  for (const problem of problems) {
    ui.note(`  (skipped ${problem.directory}: ${problem.reason})`)
  }
}

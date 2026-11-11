/**
 * ECC skills-direct adapter — waking the dormant `skills/` surface (user
 * direction 2026-09-21: wake the factory). The checkout carries 286
 * `SKILL.md` playbooks; the knowledge layer only ever read DSH skill
 * packages. This adapter exposes ECC skills through the SAME list/load
 * shape so the existing selector + builder + cap machinery picks them up
 * with zero changes: ECC entries are namespaced `ecc:`, content capped,
 * selection still relevance-ranked and char-capped (C2 protects ceilings).
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export interface EccSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}

export interface SkillSource {
  list(workspace?: string): Promise<SelectableSkill[]>
  load(name: string, workspace?: string): Promise<KnowledgeSkill | undefined>
}

export const ECC_SKILL_PREFIX = 'ecc:'
const CONTENT_CAP = 2000

export function defaultEccSkillsHome(): string {
  return (
    process.env.ECC_SKILLS_HOME ??
    join(fileURLToPath(new URL('../..', import.meta.url)), 'ecc-source', 'skills')
  )
}

export function parseSkillFile(text: string): {
  name: string
  description: string
  whenToUse?: string
  body: string
} | null {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  let name = ''
  const descriptionParts: string[] = []
  let currentKey: string | null = null
  for (const line of lines.slice(1, end)) {
    const field = /^([a-zA-Z_]+):\s*(.*)$/.exec(line)
    if (field && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentKey = field[1]
      if (currentKey === 'name') name = field[2].trim()
      if (currentKey === 'description' && field[2].trim()) {
        descriptionParts.push(field[2].trim())
      }
      continue
    }
    if (currentKey === 'description' && line.trim()) {
      descriptionParts.push(line.trim())
    }
  }
  if (!name) return null
  const body = lines.slice(end + 1).join('\n').trim()
  return { name, description: descriptionParts.join(' '), body }
}

function extractWhenToUse(body: string): string | undefined {
  const lines = body.split('\n')
  const start = lines.findIndex(line =>
    /^#{1,4}\s*when to use/i.test(line.trim()),
  )
  if (start < 0) return undefined
  const bullets = lines
    .slice(start + 1)
    .filter(line => /^\s*[-*]\s+/.test(line))
    .slice(0, 5)
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
  return bullets.length > 0 ? bullets.join(' ') : undefined
}

export class EccSkillAdapter implements SkillSource {
  constructor(
    private readonly skillsHome: string = defaultEccSkillsHome(),
  ) {}

  async list(): Promise<EccSkillSummary[]> {
    let dirs: string[]
    try {
      dirs = (await readdir(this.skillsHome, { withFileTypes: true }))
        .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
        .map((entry: { name: string }) => entry.name)
        .sort()
    } catch {
      return []
    }
    const out: EccSkillSummary[] = []
    for (const dir of dirs) {
      try {
        const text = await readFile(join(this.skillsHome, dir, 'SKILL.md'), 'utf8')
        const parsed = parseSkillFile(text)
        if (!parsed) continue
        out.push({
          name: `${ECC_SKILL_PREFIX}${parsed.name}`,
          description: parsed.description,
          whenToUse: extractWhenToUse(parsed.body),
          invocation: { modelInvocable: true, userInvocable: false },
        })
      } catch {
        // One broken skill never breaks the catalog.
      }
    }
    return out
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (!name.startsWith(ECC_SKILL_PREFIX)) return undefined
    const dir = name.slice(ECC_SKILL_PREFIX.length)
    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) return undefined
    try {
      const text = await readFile(join(this.skillsHome, dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFile(text)
      if (!parsed) return undefined
      const content =
        parsed.body.length <= CONTENT_CAP
          ? parsed.body
          : `${parsed.body.slice(0, CONTENT_CAP)}\n\n[truncated ${parsed.body.length - CONTENT_CAP} characters]`
      return {
        name: `${ECC_SKILL_PREFIX}${parsed.name}`,
        description: parsed.description,
        whenToUse: extractWhenToUse(parsed.body),
        source: 'ecc-skills',
        provider: 'ecc',
        content,
      }
    } catch {
      return undefined
    }
  }
}

/**
 * Composite source: DSH packages first (incumbent), ECC playbooks appended.
 * Structural typing keeps DshSkillAdapter untouched — it already satisfies
 * list()/load().
 */
export class CompositeSkillSource implements SkillSource {
  constructor(
    private readonly primary: SkillSource,
    private readonly secondary: SkillSource,
  ) {}

  async list(workspace?: string): Promise<SelectableSkill[]> {
    const [first, second] = await Promise.all([
      this.primary.list(workspace),
      this.secondary.list(workspace),
    ])
    const seen = new Set(first.map(skill => skill.name))
    return [...first, ...second.filter(skill => !seen.has(skill.name))]
  }

  /**
   * Load a skill by id.
   *
   * BOTH branches are asked, primary first. The old rule routed by a
   * hardcoded prefix (`ecc:` -> the secondary branch), which only worked for
   * the INNERMOST composite: at the outer levels the secondary branch is a
   * different chain, so every ECC skill was LISTED and then returned
   * `undefined` when the builder asked for its content (proved 2026-11-11:
   * 286 skills listed, none loadable through the service's chain).
   *
   * The branches are asked in LIST order instead, so the branch that won the
   * name in `list()` is the branch that answers in `load()`. A branch that
   * does not know the name returns `undefined`, which is how "I do not have
   * it" is spelled everywhere in this file.
   */
  async load(name: string, workspace?: string): Promise<KnowledgeSkill | undefined> {
    return (
      (await this.primary.load(name, workspace)) ??
      (await this.secondary.load(name, workspace))
    )
  }
}

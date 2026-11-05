import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillDefinition,
  SkillSummary,
} from '@deepseek-ai/dsh-skill'

import type {
  KnowledgeQuery,
  KnowledgeSkill,
} from './types'

export class DshSkillAdapter {
  constructor(
    private readonly context: Context,
  ) {}

  async list(
    workspace?: string,
  ): Promise<SkillSummary[]> {
    return this.context.skills.list({
      cwd: workspace,
    })
  }

  async load(
    name: string,
    workspace?: string,
  ): Promise<KnowledgeSkill | undefined> {
    const skill = await this.context.skills.get(
      name,
      {
        cwd: workspace,
      },
    )

    if (skill === undefined) {
      return undefined
    }

    return this.toKnowledgeSkill(skill)
  }

  async loadRelevant(
    query: KnowledgeQuery,
  ): Promise<KnowledgeSkill[]> {
    const summaries = await this.list(query.workspace)

    const ranked = this.rank(summaries, query)

    const limit = query.maxSkills ?? 8

    const selected: KnowledgeSkill[] = []

    for (const summary of ranked.slice(0, limit)) {
      const skill = await this.load(
        summary.name,
        query.workspace,
      )

      if (skill !== undefined) {
        selected.push(skill)
      }
    }

    return selected
  }

  private rank(
    skills: SkillSummary[],
    query: KnowledgeQuery,
  ): SkillSummary[] {
    const objective = query.objective.toLowerCase()
    const role = query.role?.toLowerCase()
    const stack = query.stack?.toLowerCase()

    return [...skills]
      .filter(skill => skill.invocation.modelInvocable)
      .map(skill => ({
        skill,
        score: this.score(
          skill,
          objective,
          role,
          stack,
        ),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.skill.name.localeCompare(b.skill.name),
      )
      .map(entry => entry.skill)
  }

  private score(
    skill: SkillSummary,
    objective: string,
    role?: string,
    stack?: string,
  ): number {
    let score = 0

    const haystack = [
      skill.name,
      skill.description,
      skill.whenToUse ?? '',
    ]
      .join(' ')
      .toLowerCase()

    const tokens = [
      ...objective.split(/\W+/),
      ...(role ? role.split(/\W+/) : []),
      ...(stack ? stack.split(/\W+/) : []),
    ].filter(token => token.length >= 3)

    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 1
      }
    }

    return score
  }

  private toKnowledgeSkill(
    skill: SkillDefinition,
  ): KnowledgeSkill {
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      source: skill.source,
      provider: skill.provider,
      content: skill.content,
    }
  }
}
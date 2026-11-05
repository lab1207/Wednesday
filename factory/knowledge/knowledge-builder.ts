import type {
  KnowledgeContext,
  KnowledgeQuery,
  KnowledgeSkillSource,
} from './types'

import {
  DshSkillAdapter,
} from './dsh-skill-adapter'

import {
  SkillSelector,
} from './skill-selector'

export class KnowledgeBuilder {
  constructor(
    private readonly adapter: KnowledgeSkillSource,
    private readonly selector: SkillSelector = new SkillSelector(),
  ) {}

  async build(
    query: KnowledgeQuery,
  ): Promise<KnowledgeContext> {
    const summaries = await this.adapter.list(
      query.workspace,
    )

    const selected = this.selector.select(
      summaries,
      query,
    )

    const skills = []

    for (const entry of selected) {
      const skill = await this.adapter.load(
        entry.skill.name,
        query.workspace,
      )

      if (skill !== undefined) {
        skills.push(skill)
      }
    }

    const rendered = capChars(
      skills
        .map(skill => [
          `<factory_skill name="${skill.name}">`,
          `Source: ${skill.source}`,
          `Provider: ${skill.provider}`,
          '',
          skill.content,
          '</factory_skill>',
        ].join('\n'))
        .join('\n\n'),
      query.maxChars ?? 6000,
    )

    return {
      skills,
      rendered,
    }
  }
}

/** C2 depth: bound the injected prompt payload for small-model ceilings. */
function capChars(value: string, max: number): string {
  if (value.length <= max) return value
  return [
    value.slice(0, max),
    '',
    `[truncated ${value.length - max} characters]`,
  ].join('\n')
}
import type {
  KnowledgeContext,
  KnowledgeQuery,
  KnowledgeSkill,
  KnowledgeSkillSource,
} from './types'

import {
  DshSkillAdapter,
} from './dsh-skill-adapter'

import {
  SkillSelector,
} from './skill-selector'

import {
  loadProjectMemory,
  renderProjectMemory,
} from './project-memory'

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

    // THE WORKSPACE'S OWN MEMORY (2026-11-05).
    //
    // The knowledge layer was twenty adapters of STATIC doctrine - the same
    // card for every workspace, every run - so the factory forgot everything
    // between runs and re-derived the same test command every time. The
    // memory is what it already learned about THIS workspace.
    //
    // It is injected ALWAYS, not through the relevance selector: a selector
    // that only picked it when the request happened to contain the word
    // "project" would drop the most useful fact in the room. It is also
    // small (a few lines), and it is skipped entirely when the workspace has
    // learned nothing yet - an empty memory is noise.
    const workspace = (query.workspace ?? process.cwd()).trim() || process.cwd()
    const memory = loadProjectMemory(workspace)
    const memoryBlock = memory.facts.length > 0
      ? renderProjectMemory(workspace, 1200)
      : ''
    const memorySkill: KnowledgeSkill[] = memoryBlock.length > 0
      ? [
          {
            name: 'project:memory',
            description: 'What the factory already learned about this workspace.',
            whenToUse: 'always, for work in this workspace',
            source: 'project-memory',
            provider: 'wednesday',
            content: memoryBlock,
          },
        ]
      : []

    const rendered = capChars(
      [
        ...memorySkill.map(skill => [
          `<factory_skill name="${skill.name}">`,
          `Source: ${skill.source}`,
          `Provider: ${skill.provider}`,
          '',
          skill.content,
          '</factory_skill>',
        ].join('\n')),
        ...skills.map(skill => [
          `<factory_skill name="${skill.name}">`,
          `Source: ${skill.source}`,
          `Provider: ${skill.provider}`,
          '',
          skill.content,
          '</factory_skill>',
        ].join('\n')),
      ]
        .join('\n\n'),
      query.maxChars ?? 6000,
    )

    return {
      skills: [...memorySkill, ...skills],
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
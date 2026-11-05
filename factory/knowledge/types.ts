export interface KnowledgeSkill {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  content: string
}

/**
 * Minimal selectable shape (structural): DSH summaries and ECC summaries
 * both satisfy it, so one selector ranks both catalogs.
 */
export interface SelectableSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean }
}

/** Structural skill source: DshSkillAdapter satisfies it untouched. */
export interface KnowledgeSkillSource {
  list(workspace?: string): Promise<SelectableSkill[]>
  load(name: string, workspace?: string): Promise<KnowledgeSkill | undefined>
}

export interface KnowledgeQuery {
  objective: string
  role?: string
  stack?: string
  workspace?: string
  maxSkills?: number
  maxChars?: number
}

export interface KnowledgeContext {
  skills: KnowledgeSkill[]
  rendered: string
}
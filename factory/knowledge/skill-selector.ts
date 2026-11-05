import type {
  KnowledgeQuery,
  SelectableSkill,
} from './types'

export interface SelectedSkill {
  skill: SelectableSkill
  score: number
  reasons: string[]
}

const DOMAIN_WORDS = new Set([
  'deepseek',
  'harness',
  'repository',
  'repo',
])

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'when',
  'where',
  'what',
  'which',
  'your',
  'their',
  'have',
  'has',
  'are',
  'was',
  'were',
  'use',
  'using',
  'in',
  'on',
  'of',
  'to',
  'a',
  'an',
  'or',
  'as',
  'by',
  'is',
  'be',
'pull',
'request',
])

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/\W+/)
        .map(token => token.trim())
        .filter(
  token =>
    token.length >= 3 &&
    !STOP_WORDS.has(token) &&
    !DOMAIN_WORDS.has(token),
),
    ),
  ]
}

export class SkillSelector {
  select(
    skills: SelectableSkill[],
    query: KnowledgeQuery,
  ): SelectedSkill[] {
    const objectiveTerms = tokenize(query.objective)
    const roleTerms = tokenize(query.role ?? '')
    const stackTerms = tokenize(query.stack ?? '')

    return skills
      .filter(skill => skill.invocation.modelInvocable)
      .map(skill => {
        const result = this.score(
          skill,
          objectiveTerms,
          roleTerms,
          stackTerms,
        )

        return {
          skill,
          score: result.score,
          reasons: result.reasons,
        }
      })
      .filter(entry => entry.score >= 8)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.skill.name.localeCompare(b.skill.name),
      )
      .slice(0, query.maxSkills ?? 5)
  }

  private score(
    skill: SelectableSkill,
    objectiveTerms: string[],
    roleTerms: string[],
    stackTerms: string[],
  ): {
    score: number
    reasons: string[]
  } {
    let score = 0
    const reasons: string[] = []

    const name = skill.name.toLowerCase()
    const description =
      skill.description.toLowerCase()

    const whenToUse =
      (skill.whenToUse ?? '').toLowerCase()

    for (const term of objectiveTerms) {
      if (name.includes(term)) {
        score += 8
        reasons.push(
          `name matched objective "${term}"`,
        )
      }

      if (whenToUse.includes(term)) {
        score += 5
        reasons.push(
          `whenToUse matched objective "${term}"`,
        )
      }

      if (description.includes(term)) {
        score += 2
        reasons.push(
          `description matched objective "${term}"`,
        )
      }
    }

    for (const term of roleTerms) {
      if (name.includes(term)) {
        score += 6
        reasons.push(
          `name matched role "${term}"`,
        )
      }

      if (whenToUse.includes(term)) {
        score += 4
        reasons.push(
          `whenToUse matched role "${term}"`,
        )
      }

      if (description.includes(term)) {
        score += 1
        reasons.push(
          `description matched role "${term}"`,
        )
      }
    }

    for (const term of stackTerms) {
      if (name.includes(term)) {
        score += 6
        reasons.push(
          `name matched stack "${term}"`,
        )
      }

      if (whenToUse.includes(term)) {
        score += 4
        reasons.push(
          `whenToUse matched stack "${term}"`,
        )
      }

      if (description.includes(term)) {
        score += 1
        reasons.push(
          `description matched stack "${term}"`,
        )
      }
    }

    return {
      score,
      reasons: [...new Set(reasons)],
    }
  }
}
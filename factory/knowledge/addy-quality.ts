/**
 * In-flight doubt + written constraints — distilled Factory knowledge
 * (2026-09-24).
 *
 * addyosmani/agent-skills (MIT) packs 25 lifecycle skills; most overlap
 * our pipeline and Pocock cards (validation, not adoption). Two are
 * genuinely new structure: doubt-driven-development (a fresh-context
 * reviewer biased to DISPROVE, applied in-flight while correction is
 * cheap — our vote/duel judge finished artifacts, nothing doubts a
 * decision mid-flight) and constraint-driven-development (the quality
 * bar as a written contract with defaults, plus a diff-watch that
 * catches the bar being quietly lowered — our policy gate blocks bad
 * tool calls, nothing watches the diff for weakened checks).
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const ADDY_QUALITY_PREFIX = 'addy:'

interface AddyQualitySkillDef {
  name: string
  description: string
  whenToUse: string
  content: string
}

const DOUBT_CONTENT = [
  'DOUBT DOCTRINE (distilled from addyosmani/agent-skills doubt-driven-development, MIT):',
  'A confident answer is not a correct one: long sessions quietly promote assumptions into facts. Subject every non-trivial decision to a fresh-context reviewer biased to DISPROVE, not approve — before it stands.',
  'Non-trivial means: new or modified branching logic; unfamiliar code; high stakes (auth, security logic, migrations, irreversible operations); anywhere verifying now is cheaper than debugging later.',
  'This is not review: review is a verdict on a finished artifact; doubt is in-flight, while course-correction is still cheap. Doubt the plan before building, doubt the seam before implementing.',
  'The doubter cross-examines assumptions and hunts hidden failure modes; anything unchallenged does not stand.',
].join('\n')

const CONSTRAINTS_CONTENT = [
  'CONSTRAINTS DOCTRINE (distilled from addyosmani/agent-skills constraint-driven-development, MIT):',
  'Decide the quality bar once, enforce it everywhere: record it as a written contract (dimensions plus thresholds; supply sane defaults where nobody has a number), so no stage quietly lowers it to reach green.',
  'Watch the diff for a weakened bar: new suppressions, skipped or deleted tests, stripped assertions, unimplemented stubs, thresholds edited down. A weakening diff is a finding, not a shortcut.',
  'More code than anyone will read is itself a smell: clarity over cleverness, enforced by the contract, not by taste.',
].join('\n')

const ADDY_QUALITY_SKILLS: AddyQualitySkillDef[] = [
  {
    name: `${ADDY_QUALITY_PREFIX}doubt-driven`,
    description:
      'In-flight disprove-biased review: fresh-context doubter hunts failure modes in non-trivial decisions before they stand.',
    whenToUse:
      'when a plan, seam, or decision carries branching logic, unfamiliar code, or high stakes; planner and coder stages before committing to a path',
    content: DOUBT_CONTENT,
  },
  {
    name: `${ADDY_QUALITY_PREFIX}constraint-driven`,
    description:
      'Written quality contract with defaults plus diff-watch: the bar is decided once and weakenings are findings.',
    whenToUse:
      'when no quality bar is written down, when checks get silenced to reach green; reviewer and repair stages',
    content: CONSTRAINTS_CONTENT,
  },
]

export class AddyQualityAdapter {
  async list(): Promise<SelectableSkill[]> {
    return ADDY_QUALITY_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true },
    }))
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    const found = ADDY_QUALITY_SKILLS.find(skill => skill.name === name)
    if (!found) return undefined
    return {
      name: found.name,
      description: found.description,
      whenToUse: found.whenToUse,
      source: 'addy-distilled',
      provider: 'addyosmani',
      content: found.content,
    }
  }
}

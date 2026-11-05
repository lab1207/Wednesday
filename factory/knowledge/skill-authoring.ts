/**
 * Skill authoring discipline — distilled Factory knowledge (2026-09-24).
 *
 * anthropics/skills skill-creator (Apache-2.0 — verified per-skill
 * LICENSE.txt; the repo's source-available docx/pdf/pptx/xlsx skills
 * are excluded by our license-first rule and untouched here) is the
 * meta-skill for writing skills: draft the skill, run test prompts
 * against it, evaluate qualitatively and quantitatively, and optimize
 * the description for triggering accuracy. It pairs with our evolution
 * card: evolution gates whether a card change survives, this disciplines
 * how a card is written so it triggers. Doctrine only — the eval-viewer
 * scripts and harness stay behind.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const SKILL_AUTHORING_PREFIX = 'meta:'

const SKILL_AUTHORING_CONTENT = [
  'SKILL AUTHORING DOCTRINE (distilled from anthropics/skills skill-creator, Apache-2.0):',
  'Write the card for its trigger: the name plus description must let a ranker know exactly when it applies — symptoms, artifacts, stages — with no overlap bleed into neighboring cards.',
  'Draft than prove: run representative prompts against the draft and judge the outcomes qualitatively (did it fire where wanted, stay silent elsewhere) and quantitatively (trigger accuracy over a prompt set) before keeping it.',
  'Optimize the description, not the bulk: when a card misfires, fix the trigger line first — most misses are routing failures, not content failures.',
  'Survival is gated elsewhere: whether a card change earns its place is decided by held-out evidence (see evolution:skill-evolution); this card governs how it is written.',
].join('\n')

export class SkillAuthoringAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${SKILL_AUTHORING_PREFIX}skill-authoring`,
        description:
          'Meta-discipline for writing knowledge cards: trigger-accurate descriptions, draft-then-prove with evals, fix routing first.',
        whenToUse:
          'when writing or fixing a factory knowledge card or skill description; meta work on triggering and routing',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${SKILL_AUTHORING_PREFIX}skill-authoring`) return undefined
    return {
      name: `${SKILL_AUTHORING_PREFIX}skill-authoring`,
      description: 'Skill authoring and trigger-accuracy discipline.',
      whenToUse: 'when writing factory knowledge cards',
      source: 'anthropics-distilled',
      provider: 'anthropics',
      content: SKILL_AUTHORING_CONTENT,
    }
  }
}

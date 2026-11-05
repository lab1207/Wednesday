/**
 * Skill-evolution doctrine — distilled Factory knowledge (2026-09-24).
 *
 * microsoft/SkillOpt (MIT) trains natural-language skill documents like
 * neural networks: rollout trajectories, reflect edit patches, rank and
 * clip them (learning rate = max edits per round), apply, then a
 * validation GATE decides accept or revert — over epochs, with a
 * meta-memory of what worked. Its Sleep workflow stages
 * session-derived updates for human adoption instead of auto-applying.
 * Our cards are static hand-authored text; this adds the missing
 * meta-loop: card edits are hypotheses that earn their place by proof.
 * The Python engine, benchmark splits, and model backends stay behind.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const SKILL_EVOLUTION_PREFIX = 'evolution:'

const SKILL_EVOLUTION_CONTENT = [
  'SKILL EVOLUTION DOCTRINE (distilled from microsoft/SkillOpt, MIT):',
  'Card edits are hypotheses: rollout (run real tasks) than reflect (propose bounded patches from trajectories) than gate (validate before keeping). Never promote an edit on the strength of the task it was tuned on.',
  'Bounded edits per round: rank candidate patches, keep the few best, clip the rest — small patches compound, rewrites regress. One round, one small diff, one verdict.',
  'Gate rule: accept only on held-out evidence (tasks the edit was not written against); revert on regression or no signal. No evidence, no promotion.',
  'Session-derived updates stage for human adoption, never auto-apply: a proposed card change from live runs waits for operator approval, like any product change.',
  'Meta-memory across rounds: record what worked, what regressed, and what was reverted, so the next round stops re-proposing failed edits.',
].join('\n')

export class SkillEvolutionAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${SKILL_EVOLUTION_PREFIX}skill-evolution`,
        description:
          'Gated card evolution: bounded patches from trajectories, held-out validation gate, staged human adoption, meta-memory — for improving factory knowledge itself.',
        whenToUse:
          'when proposing or judging a change to a factory knowledge card, prompt, or stage instruction; meta work on the factory itself',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${SKILL_EVOLUTION_PREFIX}skill-evolution`) return undefined
    return {
      name: `${SKILL_EVOLUTION_PREFIX}skill-evolution`,
      description: 'Gated evolution discipline for knowledge cards.',
      whenToUse: 'when changing factory knowledge',
      source: 'skillopt-distilled',
      provider: 'microsoft',
      content: SKILL_EVOLUTION_CONTENT,
    }
  }
}

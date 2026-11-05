/**
 * Durable product truth vs visual direction — distilled Factory knowledge
 * (2026-09-24).
 *
 * pbakaus/impeccable (Apache-2.0) is a design skill for AI harnesses that
 * starts where Anthropic's frontend-design stops: every project opens by
 * recording durable product truth (audience, purpose, operating context,
 * constraints, voice, evidence) in one place, and visual direction is
 * chosen per surface and recorded separately. Later work reads the
 * product truth instead of re-asking or confusing product facts with
 * surface styling. Our OpenDesign brief and krehel interface-review
 * judge the build; this adds the record-once structure before it.
 * The 24 commands, CLI, and detector rules stay behind.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const IMPECCABLE_PREFIX = 'impeccable:'

const DURABLE_CONTEXT_CONTENT = [
  'DURABLE CONTEXT DOCTRINE (distilled from pbakaus/impeccable, Apache-2.0):',
  'Record durable product truth once, up front: audience, purpose, operating context, constraints, voice, evidence. Later stages read it — never re-ask settled facts, never confuse product truth with surface styling.',
  'Visual direction is chosen per surface and recorded separately from product truth. Changing a look never rewrites what the product is; changing what the product is explicitly revisits every surface.',
  'Inspect what exists before shaping: document the incumbent system from the code, extract reusable tokens, then plan. Ask only for material gaps — everything derivable is derived.',
].join('\n')

export class ImpeccableAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${IMPECCABLE_PREFIX}durable-context`,
        description:
          'Record-once product truth vs per-surface visual direction: inspect first, ask only for gaps, never confuse facts with styling.',
        whenToUse:
          'when starting frontend work or judging whether a build matches the product; architect and reviewer stages on UI tasks',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${IMPECCABLE_PREFIX}durable-context`) return undefined
    return {
      name: `${IMPECCABLE_PREFIX}durable-context`,
      description: 'Durable product truth vs visual direction discipline.',
      whenToUse: 'when starting or judging frontend work',
      source: 'impeccable-distilled',
      provider: 'pbakaus',
      content: DURABLE_CONTEXT_CONTENT,
    }
  }
}

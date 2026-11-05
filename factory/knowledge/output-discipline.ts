/**
 * Output discipline — distilled Factory knowledge (2026-09-24).
 *
 * Small models bury verdicts in preamble, tangents, and recap — which
 * burns tokens AND degrades the machine-read stage handoffs
 * (previousOutputs feed the next role verbatim). ayghri/i-have-adhd
 * (MIT) is a 10-rule output discipline that fixes exactly this:
 * action first, numbered steps, one next step, capped lists.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const OUTPUT_DISCIPLINE_PREFIX = 'style:'

const OUTPUT_DISCIPLINE_CONTENT = [
  'OUTPUT DISCIPLINE (distilled from ayghri/i-have-adhd, MIT):',
  'Lead with the next action — never preamble, throat-clearing, or "hope this helps". Number multi-step tasks; end with exactly ONE concrete next step.',
  'Suppress tangents: one job per output. Restate state every turn (what is done, what is next) so the next reader — model or human — never reconstructs context.',
  'Cap lists at 5 items. Time estimates in minutes, never "a bit". Errors matter-of-fact: what failed, the exact line, the next command. Make wins visible in one line.',
  'No recap, no closers. The handoff after you is another worker, not an audience.',
].join('\n')

export class OutputDisciplineAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${OUTPUT_DISCIPLINE_PREFIX}output-discipline`,
        description:
          'Terse action-first outputs: lead with the action, numbered steps, one next step, capped lists, state restated — for machine-read handoffs.',
        whenToUse:
          'whenever a stage writes outputs another role or the operator reads; architect/planner summaries, repair records, reviewer verdicts, harness notes',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${OUTPUT_DISCIPLINE_PREFIX}output-discipline`) return undefined
    return {
      name: `${OUTPUT_DISCIPLINE_PREFIX}output-discipline`,
      description: 'Terse action-first output discipline.',
      whenToUse: 'when writing anything another role or the operator reads',
      source: 'adhd-distilled',
      provider: 'adhd',
      content: OUTPUT_DISCIPLINE_CONTENT,
    }
  }
}

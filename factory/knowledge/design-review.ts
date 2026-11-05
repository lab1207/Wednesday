/**
 * Interface review doctrine — distilled Factory knowledge (2026-09-24).
 *
 * jakubkrehel/skills better-interface (MIT) is a cross-discipline UI
 * review orchestrator: scope first, evidence over taste, escalation
 * triggers that are HIGH on sight, cheaper-fix ladder, consolidated
 * systemic findings. Our reviewer judges code correctness; this adds
 * the interface-verdict discipline our frontend work lacked (boraoztunc
 * merely vendors these same skills — upstream is the source used).
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const DESIGN_REVIEW_PREFIX = 'design:'

const INTERFACE_REVIEW_CONTENT = [
  'INTERFACE REVIEW DOCTRINE (distilled from jakubkrehel/skills better-interface, MIT):',
  'Scope first: state the boundary and what it excluded; cover empty, loading, error, and narrow-width states; cap 15 findings; never imply uninspected surfaces were reviewed.',
  'Evidence, not taste: every finding cites file:line plus the implementation; visual claims need runtime inspection or are marked NOT VERIFIED. Deliberate project choices are not findings.',
  'HIGH on sight (never averaged down): unnamed interactive control; keyboard-reachable control with no visible focus; pointer-only path; motion ignoring reduced-motion; clipping at 320px or 200% zoom; failing contrast pair; meaning carried by color alone; destructive action without confirm/undo; unreachable truncation; error naming no recovery.',
  'Cheaper fix first: 1 delete, 2 use the platform, 3 reuse project tokens, 4 correct the value, 5 add new. One root cause is one finding — consolidate locations, never pad.',
  'Read-only default: review inspects, implementation is a separate ask.',
].join('\n')

export class DesignReviewAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${DESIGN_REVIEW_PREFIX}interface-review`,
        description:
          'Cross-discipline UI verdicts: scoped, evidenced, trigger-escalated, cheapest-fix, consolidated — for interface review stages.',
        whenToUse:
          'when reviewing built UI against mockups, briefs, or accessibility expectations; reviewer and vote stages on frontend work',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${DESIGN_REVIEW_PREFIX}interface-review`) return undefined
    return {
      name: `${DESIGN_REVIEW_PREFIX}interface-review`,
      description: 'Cross-discipline UI verdict discipline.',
      whenToUse: 'when judging built interfaces',
      source: 'krehel-distilled',
      provider: 'krehel',
      content: INTERFACE_REVIEW_CONTENT,
    }
  }
}

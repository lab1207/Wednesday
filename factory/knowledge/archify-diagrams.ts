/**
 * Evidence-grounded diagrams — distilled Factory knowledge (2026-09-24).
 *
 * tt-a1i/archify (MIT) turns plain-language or Mermaid input into
 * validated, self-contained HTML diagrams from a small typed JSON
 * spec: artifact first, inspect-repo-evidence when the diagram must
 * reflect real code, validate after every edit and before handoff,
 * bounded reads and bounded nodes. Our architect plans in prose and
 * nothing governs diagrams — this adds the discipline so stage
 * diagrams depict the code as inspected, not as imagined. The schemas,
 * renderer, brand tooling, and export chain stay behind.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const ARCHIFY_PREFIX = 'archify:'

const EVIDENCE_DIAGRAMS_CONTENT = [
  'EVIDENCE DIAGRAMS DOCTRINE (distilled from tt-a1i/archify, MIT):',
  'Spec before pixels: choose the diagram type (architecture, workflow, sequence, dataflow, lifecycle) and write a small typed spec first — never plan coordinates in prose, never draw from imagination.',
  'Evidence grounding: when the diagram must reflect real code, inspect the repository and build from what it shows; examples give field shape, never facts. Fresh authorship — new IDs, domain wording, layout.',
  'Artifact first: the next action writes the candidate diagram, then iterates on it. Bounded by default: one clear main path, sparse labels, at most 12 primary nodes, automatic routes.',
  'Validate after every edit and immediately before handoff: the diagram must parse against its spec and depict inspected evidence, or it is reworked — never handed over unvalidated.',
  'Static output is the default; motion and decoration only on explicit request.',
].join('\n')

export class ArchifyAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${ARCHIFY_PREFIX}evidence-diagrams`,
        description:
          'Evidence-grounded architecture diagrams: typed spec, repo-inspected facts, artifact-first iteration, validate-before-handoff.',
        whenToUse:
          'when a stage must convey system structure, flows, sequences, or lifecycles visually; architect plans and handoffs that include diagrams',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${ARCHIFY_PREFIX}evidence-diagrams`) return undefined
    return {
      name: `${ARCHIFY_PREFIX}evidence-diagrams`,
      description: 'Evidence-grounded diagram discipline.',
      whenToUse: 'when stages convey structure visually',
      source: 'archify-distilled',
      provider: 'tt-a1i',
      content: EVIDENCE_DIAGRAMS_CONTENT,
    }
  }
}

/**
 * DOM-first UI verification — distilled Factory knowledge (2026-09-24).
 *
 * alibaba/page-agent (MIT) proves web UI can be driven and inspected
 * through DOM text/structure alone — no screenshots, no multimodal
 * model, no heavy browser. That is exactly our tester gap: UI checks
 * today mean either static code review or a VL screenshot that may
 * never exist. DOM-first verification runs on any small model.
 *
 * Same list/load shape — selector + builder + cap machinery unchanged.
 * Raw material + mechanical caps only (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const UI_VERIFY_PREFIX = 'ui:'

const DOM_VERIFY_CONTENT = [
  'DOM-FIRST UI VERIFICATION (distilled from alibaba/page-agent, MIT):',
  'Verify web UI through DOM text and structure, not pixels: assert labels, button states, error text, navigation outcomes, empty/loading/error renders. No screenshot and no vision model needed — any small model can do this.',
  'Drive flows as commands (open, click, fill, assert) and read back DOM after each step. Prefer Testing Library-style queries (by label, role, text) over CSS selectors — they assert what the user experiences.',
  'Pairs with screenshot critique: DOM first (cheap, always), pixels on demand (mockups, visual polish). A DOM assertion that fails IS the repair item with its selector and expected text.',
].join('\n')

export class UiVerifyAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: `${UI_VERIFY_PREFIX}dom-verification`,
        description:
          'DOM-first UI verification: drive flows, assert labels/states/text outcomes without screenshots or vision models.',
        whenToUse:
          'when verifying web UI behavior; tester stage on frontend tasks, before reaching for screenshots',
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    if (name !== `${UI_VERIFY_PREFIX}dom-verification`) return undefined
    return {
      name: `${UI_VERIFY_PREFIX}dom-verification`,
      description: 'DOM-first UI verification doctrine.',
      whenToUse: 'when verifying web UI without screenshots',
      source: 'pageagent-distilled',
      provider: 'pageagent',
      content: DOM_VERIFY_CONTENT,
    }
  }
}

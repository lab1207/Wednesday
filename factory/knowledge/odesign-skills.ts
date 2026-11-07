/**
 * OpenDesign design doctrine — distilled Factory knowledge (2026-09-24).
 *
 * Our recorded wall is frontend/design work ("website NOT built"):
 * the Factory has zero design sense — vague objectives ("make it
 * professional") sail straight into code with no decisions made first.
 * These two checklists close exactly that gap, distilled headless from
 * nexu-io/open-design skills (Apache-2.0; frontend-design adapted from
 * Anthropic's official skill): design-brief resolves dimensions BEFORE
 * planning; frontend-design governs building + self-review.
 *
 * Same list/load shape as the other adapters — selector + builder + cap
 * machinery picks these up with no changes. Raw material + mechanical
 * caps only; the model does all reasoning (thin-plugin law).
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const ODESIGN_SKILL_PREFIX = 'odesign:'

interface OdesignSkillDef {
  name: string
  description: string
  whenToUse: string
  content: string
}

const DESIGN_BRIEF_CONTENT = [
  'DESIGN BRIEF DOCTRINE (distilled from open-design/design-brief, Apache-2.0):',
  'Vague words ("professional", "clean", "modern") are NOT directions — resolve 8 dimensions BEFORE any pixel: palette / accent / body type / display type / layout / mood / density / constraints.',
  'Tokens (a palette to CHOOSE FROM, not a mandate -- take the ones the request implies, and go beyond them only when the request asks for something new): dark #09090B/#18181B/#FAFAFA, light #FFFFFF/#F8FAFC/#0F172A, navy #0F172A/#1E293B/#F8FAFC; accents coral #F97316, blue #3B82F6, emerald #10B981, sage #84A98C; body Inter 1rem/1.6; display clamp(2rem,5vw,3.5rem); spacing compact 48 / balanced 72 / spacious 96px; breakpoints 640/768/1024/1280.',
  'When the request does NOT say: resolve each dimension FROM THE SUBJECT -- a bakery, a crypto dashboard and a medical portal do not share a palette, a type voice or a layout -- and REPORT the choice you made. Falling back to the same palette, accent and single column for every request is a FAILED brief, not a safe default (operator report, 2026-11-07: "every website comes out the same").',
  'Rules: at most 2 typefaces; accent max 3 times per viewport; every interactive element gets :focus-visible; all text WCAG AA; closed vocabulary only — an unrecognized value is a clarification question, never a guess.',
].join('\n')

const FRONTEND_DESIGN_CONTENT = [
  'FRONTEND BUILD DOCTRINE (distilled from open-design/frontend-design, Apache-2.0, via Anthropic):',
  '1. BRIEF FIRST: audience, job, tone, constraints (framework, existing styles, responsive, export). Existing tokens/components/screenshots are the source of truth.',
  '2. ONE DIRECTION: commit to a specific aesthetic (minimal, editorial, brutalist, dense operational…) expressed through type, spacing, color, hierarchy — never generic AI defaults (purple-blue gradients, glass cards, interchangeable SaaS layouts, over-rounded cards, decorative blobs).',
  '3. REAL INTERFACE, not a poster: controls, empty/loading/error states, tables, filters, navigation, responsive behavior. Honest content — label unknown data sample/pending, never invent claims.',
  '4. PRODUCTION CODE: repo framework and conventions first; semantic markup, keyboard access, focus states, contrast; CSS variables for repeated tokens.',
  '5. SELF-REVIEW BEFORE DONE: works at mobile AND desktop widths; text fits containers without overlap; every interactive element has hover/focus/active/disabled states; no AI visual tropes; one memorable quality.',
  '6. THE REQUEST IS THE SPEC: build the sections, the order and the vocabulary the request names. A request for a price list is not a hero-plus-three-features landing page, and a request for one dense dashboard screen is not a marketing page. Never substitute a standard structure for the one that was asked for (operator report, 2026-11-07: "it never build like the way it should build").',
].join('\n')

const LOGIN_FLOW_CONTENT = [
  'AUTH UI DOCTRINE (distilled from open-design/login-flow, Apache-2.0):',
  'Labels above inputs — never placeholder-only. Password field gets a show/hide toggle. Social SSO buttons carry real SVG icons. Error states sit below fields, loading spinner lives in the primary CTA.',
  'Touch targets minimum 44px. Mobile viewport 375px with no horizontal scroll; safe-area insets on notched devices; right keyboards per field (tel, password, email).',
  'Clarify the auth method first (password, SMS code, SSO) — each has different states. Every state (default, loading, error, success) renders deliberately, never as an afterthought.',
].join('\n')

const MOCKUP_FIDELITY_CONTENT = [
  'MOCKUP FIDELITY DOCTRINE (distilled from open-design/image-to-code-skill, Apache-2.0; reference supplied by the user and read via vision — never generated here):',
  'ANALYZE FIRST, code second: extract exact text, type scale/weights, spacing rhythm, button shapes/hierarchy, palette roles, grid, section order. Unclear detail means re-reading the reference closer — never guessing forward.',
  'ANTI-DRIFT: follow the reference closely — same layout logic, spacing, order, type mood, component style. Never simplify into default templates, compress generous spacing, flatten strong type, or merge sections into repetitive patterns absent from the reference.',
  'ANTI-SLOP: no nested boxes-in-boxes; no giant rounded wrappers; no purple-blue gradients, blobs, or glass without reason; no fake pills/labels/jargon; hero stays cinematic and clean (1–3 line headline, one focal point, breathing room); vary section rhythm without losing coherence.',
  'Responsive in spirit: first screen readable on a small laptop — headline, subcopy, CTA, one focal point, nothing overfilled.',
].join('\n')

const SCREENSHOT_CRITIQUE_CONTENT = [
  'OUTPUT SELF-CRITIQUE (distilled from abi/screenshot-to-code render loop, MIT):',
  'After building UI, look at YOUR OWN output with fresh eyes before declaring done: screenshot the rendered page and inspect layout breaks, overlapping text, missing states, console errors, and mockup-vs-build drift.',
  'Critique against the reference (or brief when no reference exists): same hierarchy, spacing, states, wording. Every mismatch is a repair item with its location — never "looks fine".',
  'Full loop form (needs headless browser + vision, queued until Chromium is available): render → see → fix → re-render. Until then, critique operator-supplied screenshots the same way.',
].join('\n')

const ODESIGN_SKILLS: OdesignSkillDef[] = [
  {
    name: `${ODESIGN_SKILL_PREFIX}design-brief`,
    description:
      'Design decisions before pixels: resolve palette, accent, type, layout, mood, density, constraints into concrete tokens with reported defaults.',
    whenToUse:
      'when the objective asks for a website, page, dashboard, UI, or "professional/clean/modern" look; the planner stage, before any code',
    content: DESIGN_BRIEF_CONTENT,
  },
  {
    name: `${ODESIGN_SKILL_PREFIX}frontend-design`,
    description:
      'Frontend build discipline: one aesthetic direction, real interfaces with all states, production code, anti-AI-slop craft, self-review.',
    whenToUse:
      'when building or fixing HTML/CSS/JS, pages, dashboards, or components; the coder and reviewer stages on frontend work',
    content: FRONTEND_DESIGN_CONTENT,
  },
  {
    name: `${ODESIGN_SKILL_PREFIX}login-flow`,
    description:
      'Auth UI discipline: labeled inputs, show/hide toggle, SSO buttons, per-state rendering, 44px targets, mobile viewport rules.',
    whenToUse:
      'when the task includes login, signup, auth, session, or password screens; the coder stage on auth UI',
    content: LOGIN_FLOW_CONTENT,
  },
  {
    name: `${ODESIGN_SKILL_PREFIX}mockup-fidelity`,
    description:
      'Reference-faithful implementation: analyze the supplied mockup deeply first, then build without drifting — anti-slop, hero rules, rhythm.',
    whenToUse:
      'when a reference mockup, screenshot, or design image is supplied; vision reads it, coder implements it faithfully',
    content: MOCKUP_FIDELITY_CONTENT,
  },
  {
    name: `${ODESIGN_SKILL_PREFIX}screenshot-critique`,
    description:
      'Output self-critique: screenshot your own built page, inspect breaks/overlap/states/drift, repair every mismatch before done.',
    whenToUse:
      'after building any UI, when a rendered screenshot of the output exists; tester and reviewer stages on frontend work',
    content: SCREENSHOT_CRITIQUE_CONTENT,
  },
]

export class OdesignSkillAdapter {
  async list(): Promise<SelectableSkill[]> {
    return ODESIGN_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true },
    }))
  }

  async load(name: string): Promise<KnowledgeSkill | undefined> {
    const found = ODESIGN_SKILLS.find(skill => skill.name === name)
    if (!found) return undefined
    return {
      name: found.name,
      description: found.description,
      whenToUse: found.whenToUse,
      source: 'odesign-distilled',
      provider: 'odesign',
      content: found.content,
    }
  }
}

/**
 * Factory built-in skills — keyless capability recipes (2026-09-22).
 *
 * The worker has fetch-only web tools (`web` + `web-fetch-http`, search
 * disabled — every search backend needs its own key by design) and zero
 * keys. Small models cannot invent the keyless discovery loop themselves,
 * so the Factory teaches it as a static recipe: fetch the DDG lite page,
 * decode the `uddg` target, fetch the target. Raw material + mechanical
 * caps only — the model does all reasoning (thin-plugin law).
 *
 * Proven live 2026-09-21: DDG lite GET → 200 with 10 result links;
 * searx.be + DDG-html-GET captcha-blocked; DDG html POST unusable
 * (web_fetch is GET-only); DDG Instant API empty.
 *
 * Zero-dependency: served through the SAME list/load shape as the DSH
 * and ECC adapters, so the existing selector + builder + cap machinery
 * picks it up with no changes.
 */

import type {
  KnowledgeSkill,
  SelectableSkill,
} from './types'

export const DDG_SKILL_NAME = 'factory:ddg-search-recipe'

const DDG_LITE_BASE = 'https://lite.duckduckgo.com/lite/?q='

const DDG_RECIPE_CONTENT = [
  'KEYLESS WEB SEARCH RECIPE (DDG lite, fetch-only, zero keys):',
  'Use when you need docs, APIs, error messages, or any fact outside the workspace.',
  '',
  '1. FETCH the lite results page (GET only, URL-encode the query):',
  '   https://lite.duckduckgo.com/lite/?q=<encodeURIComponent(query)>',
  '2. COLLECT up to 10 result links: <a> hrefs containing `uddg=`.',
  '   The `uddg` param is the percent-encoded target URL (unescape `&amp;`',
  '   to `&` first, then decode).',
  '3. FETCH each decoded target with web_fetch (GET). Read raw markdown.',
  '   Truncate each page at 6000 chars — retrieve, never summarize in the tool.',
  '4. CAPS (mechanical, absolute): GET only, never POST; max 10 targets;',
  '   stop after 3 fetch failures; never send keys or workspace secrets in URLs.',
  '5. KNOWN DEAD ENDS (do not retry): searx.be + DDG html GET = captcha;',
  '   DDG html POST = unusable (GET-only fetch); DDG Instant API = empty.',
].join('\n')

const DDG_DESCRIPTION =
  'Keyless web discovery via DuckDuckGo lite: fetch the lite results page, ' +
  'decode uddg targets, fetch targets. Use for docs, APIs, errors, and ' +
  'external facts when no search key exists.'

const DDG_WHEN_TO_USE =
  'when the task needs web search, research, documentation, API references, ' +
  'error messages, or external facts; before fetching an unknown URL; ' +
  'the coder discovery step under fetch-only tools'

/** Build the lite results URL for a raw query (pure, unit-tested). */
export function buildDdgLiteUrl(query: string): string {
  return `${DDG_LITE_BASE}${encodeURIComponent(query)}`
}

/**
 * Extract decoded result targets from a DDG lite HTML page (pure).
 * Reads `<a href="...uddg=<encoded>...">`, unescapes `&amp;`, decodes
 * the param, keeps http(s) targets only, caps at `limit` (default 10).
 */
export function extractDdgTargets(
  html: string,
  limit = 10,
): string[] {
  const out: string[] = []
  const hrefs =
    html.match(/href="([^"]*?uddg=[^"]*)"/gi) ?? []
  for (const href of hrefs) {
    const raw =
      /href="([^"]*)"/i.exec(href)?.[1] ?? ''
    const unescaped =
      raw.replace(/&amp;/g, '&')
    let encoded: string | null = null
    try {
      const url = new URL(
        unescaped,
        'https://lite.duckduckgo.com',
      )
      encoded =
        url.searchParams.get('uddg')
    } catch {
      const match =
        /[?&]uddg=([^&"]+)/.exec(unescaped)
      encoded =
        match ? match[1] : null
    }
    if (!encoded) continue
    let decoded = ''
    try {
      decoded = decodeURIComponent(
        encoded.replace(/\+/g, ' '),
      )
    } catch {
      continue
    }
    if (
      /^https?:\/\//i.test(decoded) &&
      !out.includes(decoded)
    ) {
      out.push(decoded)
    }
    if (out.length >= Math.max(1, Math.floor(limit))) break
  }
  return out
}

export class BuiltinSkillAdapter {
  async list(): Promise<SelectableSkill[]> {
    return [
      {
        name: DDG_SKILL_NAME,
        description: DDG_DESCRIPTION,
        whenToUse: DDG_WHEN_TO_USE,
        invocation: { modelInvocable: true },
      },
    ]
  }

  async load(
    name: string,
  ): Promise<KnowledgeSkill | undefined> {
    if (name !== DDG_SKILL_NAME) return undefined
    return {
      name: DDG_SKILL_NAME,
      description: DDG_DESCRIPTION,
      whenToUse: DDG_WHEN_TO_USE,
      source: 'factory-builtin',
      provider: 'factory',
      content: DDG_RECIPE_CONTENT,
    }
  }
}

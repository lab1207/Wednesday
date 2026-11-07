/**
 * Page builds get a real spec and a real gate (2026-11-01).
 *
 * The operator's report was exact: "I asked for an html website and got a
 * hello-world page, and the run said PASS." Both halves were true and both were
 * the Factory's fault, not the model's:
 *
 *  - GATE: in a folder with no manifest the default verification is "the
 *    workspace is not empty". A 40-byte hello world satisfies that, so the run
 *    passed, the repair loop never fired, and the receipt called it a success.
 *    A gate that a placeholder passes is not a gate.
 *  - SPEC: the objective ("build html website") plus a constraint reading
 *    "Keep the change minimal." is the entire brief a 3B model received. Minimal
 *    output is then exactly compliant.
 *
 * So for page-shaped requests this module supplies what the Factory exists to
 * supply: a concrete, checkable target. It is deterministic and offline -- no
 * model call decides whether the request was a page, and nothing here contains
 * page CONTENT (copy, colours, branding). It names structure a page needs and a
 * command that verifies structure, which is the difference between a placeholder
 * and a page without dictating the design.
 *
 * REWRITTEN (2026-11-07, operator report: "it never build like the way it
 * should build, i think it goes locked by bad way"). The first version of this
 * module fixed the empty page by dictating a FIXED shape, and over-corrected:
 * every page request -- a bakery, a crypto dashboard, a single contact page --
 * received the same blueprint:
 *
 *     <header> with a nav, <main> with a hero, three <section> blocks
 *     (features / how it works / pricing), a footer.
 *
 * `pageBuildBrief(objective)` took the request as a parameter and never read
 * it. The result was a Factory that quietly overruled the operator's words and
 * produced the same page every time. The gate made it worse: it demanded three
 * structural blocks and failed any extra .html file, so a request-shaped page
 * (two sections, no nav) was REJECTED while the generic template PASSED.
 *
 * The rule now: the Factory states the guarantees (real content, real styles,
 * responsive, not a placeholder) and the REQUEST states the structure. The
 * gate checks the guarantees and never the template.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Does this request ask for a page/site rather than a program? */
export function isPageRequest(objective: string): boolean {
  const text = objective.toLowerCase()
  if (!/\b(html|web ?site|web ?page|landing|homepage|static site|portfolio|site)\b/.test(text)) return false
  // A page FILE named explicitly is unambiguous -- that is a request to produce
  // it, whatever else the sentence says.
  if (/\.html?\b/.test(text)) return true
  // An edit to an existing site is not a build: "make the site faster" arrives
  // with the same nouns and none of the work. Edit language disqualifies unless
  // the request also asks to build/create/rewrite the thing.
  const editing = /\b(fix|repair|bug|slow|faster|speed|broken|improve|refactor|tweak|adjust|review|test|deploy|host|audit)\b/.test(text)
  const building = /\b(build|create|make|scaffold|generate|design|write|recreate|rewrite)\b/.test(text)
  if (editing && !/\b(build|create|scaffold|generate|recreate|rewrite|from scratch)\b/.test(text)) return false
  return building
}

/** The file a page request must leave behind, when the operator named none. */
export const PAGE_ENTRY = 'index.html'

/** Minimum size of a page that is not a placeholder (~200 words of markup). */
export const PAGE_MIN_BYTES = 1500

/** The .html files a request names, in the order it names them. */
export function requestedHtmlFiles(objective: string): string[] {
  const found: string[] = []
  for (const match of objective.matchAll(/([\w./-]+\.html?)\b/gi)) {
    const name = (match[1] ?? '').replace(/^\.?\//, '')
    if (name && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * The entry file for this request.
 *
 * A request that names its own file ("build about.html") gets THAT file; a
 * request that names none gets the conventional index.html.
 */
export function pageEntryFile(objective: string): string {
  const files = requestedHtmlFiles(objective)
  if (files.includes(PAGE_ENTRY)) return PAGE_ENTRY
  if (files.length === 1) return files[0] as string
  return PAGE_ENTRY
}

/**
 * Does the request ask for MORE than one page?
 *
 * The old gate failed every extra .html file, so a request for a two-page site
 * could never pass. This reads the request instead of assuming.
 */
export function pageIsMultiFile(objective: string): boolean {
  if (requestedHtmlFiles(objective).length > 1) return true
  return /\b(multi[- ]?page|multiple pages|several pages|two pages|three pages|four pages|different pages|pages? for|pages? like|landing plus)\b/i.test(
    objective,
  )
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The structure a page must demonstrate. Not content: presence checks.
 * Each clause is verifiable from the file itself, so the run either passes on
 * evidence or fails and repairs.
 *
 * The criteria describe what the page must CONTAIN (a document, a heading,
 * real markup, styles, a responsive layout) -- never how many sections it
 * must have, because that number belongs to the request.
 */
export function pageAcceptanceCriteria(objective: string): string[] {
  const entry = pageEntryFile(objective)
  const multi = pageIsMultiFile(objective)
  return [
    `${entry} exists in the workspace root`,
    `${entry} is a complete HTML document (doctype, <html>, <head>, <body>)`,
    'the page has a heading (<h1>) and the content the request asked for',
    `the page is real markup, not a placeholder (at least ${PAGE_MIN_BYTES} bytes)`,
    'styles are included (inline <style> or a local stylesheet -- no missing assets)',
    'the page is responsive (a viewport meta tag and a narrow-screen layout)',
    ...(multi ? ['every page the request names exists and is a complete HTML document'] : []),
  ]
}

/**
 * The verification command for a page build.
 *
 * Node is guaranteed (Wednesday is a node app), so this runs anywhere without
 * installing a browser or a test framework. It checks the GUARANTEES only: a
 * wrong color scheme passes, a hello-world page does not.
 *
 * It deliberately does NOT check for a particular set of blocks: the old
 * three-block floor and the stray-file ban rejected request-shaped pages
 * while accepting the generic template, which is the opposite of what a gate
 * is for. The floor is now ONE semantic block, so the gate says "this is a
 * real document" and never "this is the wrong document" -- the byte floor,
 * the heading, the styles and the viewport are what make it non-trivial.
 */
export function pageCheckCommand(entry = PAGE_ENTRY, options: { allowExtraHtml?: boolean } = {}): string {
  const script = [
    "const fs=require('fs')",
    `const p='${entry}'`,
    "if(!fs.existsSync(p)){console.error('missing '+p);process.exit(1)}",
    "const s=fs.readFileSync(p,'utf8')",
    "const need=[['<!doctype',/<!doctype html/i],['<html',/<html[\\s>]/i],['<head',/<head[\\s>]/i],['<body',/<body[\\s>]/i],['<h1',/<h1[\\s>]/i]]",
    "for(const [n,r] of need){if(!r.test(s)){console.error('missing '+n);process.exit(1)}}",
    "const sections=(s.match(/<(section|main|header|footer|nav|article)\\b/gi)||[]).length",
    "if(sections<1){console.error('no semantic block (section/main/header/footer/nav/article) found');process.exit(1)}",
    `if(s.length<${PAGE_MIN_BYTES}){console.error('page is '+s.length+' bytes (placeholder), need ${PAGE_MIN_BYTES}+');process.exit(1)}`,
    "const styled=/<style[\\s>]/i.test(s)||/<link[^>]+stylesheet/i.test(s)",
    "if(!styled){console.error('no styles');process.exit(1)}",
    "if(!/<meta[^>]+name=[\"']viewport/i.test(s)){console.error('no viewport meta');process.exit(1)}",
    ...(options.allowExtraHtml
      ? []
      : [
          "const extras=fs.readdirSync('.').filter(f=>/\\.html?$/i.test(f)&&f!==p)",
          "if(extras.length){console.error('stray html files: '+extras.join(', '));process.exit(1)}",
        ]),
    "console.log('page ok: '+s.length+' bytes, '+sections+' structural blocks')",
  ].join(';')
  return `node -e "${script.replace(/"/g, '\\"')}"`
}

/**
 * The build brief that rides the coder prompt for a page request.
 *
 * Deliberately structural and short: a 13K-window model that is told what to
 * produce writes a page; one that is told "build a website" writes a hello
 * world. Copy, palette and brand are the operator's, never the harness's.
 *
 * And -- since 2026-11-07 -- so is the STRUCTURE. The brief states the
 * guarantees the Factory can verify and then tells the model to derive the
 * blocks from the request. It names the generic landing-page shape
 * explicitly as something NOT to fall back on, because that fallback is
 * exactly what the operator reported: "every website comes out the same".
 */
export function pageBuildBrief(objective: string): string[] {
  const entry = pageEntryFile(objective)
  const multi = pageIsMultiFile(objective)
  return [
    'PAGE BUILD BRIEF -- build the page the request asks for, completely (never a placeholder):',
    `- THE REQUEST (obey it literally): ${oneLine(objective)}`,
    `- Deliverable: ${entry}${multi ? ' plus every other page the request names' : ', a single self-contained file unless the request asks for more'}.`,
    '- STRUCTURE: derive the blocks from the request. Use the sections, pages and order the request',
    '  names; do not add sections it did not ask for.',
    '  A header/nav, hero, features/pricing trio and footer are NOT a default to fall back on --',
    '  build only what this request needs, and make it look like this request.',
    '- Style: semantic HTML, a <style> block with CSS custom properties, a responsive grid,',
    '  and one media query for narrow screens. No external CDN, no missing assets, no lorem ipsum.',
    '- Content: write real, specific copy for the thing requested -- headings, short paragraphs,',
    '  button labels. Placeholders ("hello world", "welcome to my site") are a failed deliverable.',
    '- Responsive: a viewport meta tag, fluid type, and a layout that stays readable at 360px.',
    `- Size expectation: a real page is at least ${PAGE_MIN_BYTES.toLocaleString('en-US')} bytes of markup.`,
    `- The run is verified by a structural check on ${entry}; read it before you finish so it passes.`,
  ]
}

/**
 * Is the workspace effectively empty (a fresh folder)?
 *
 * Used to pick the "build it fully" constraint instead of "keep the change
 * minimal": minimal is the right instruction for an edit and the wrong one for a
 * from-scratch build, but it was applied to both.
 */
export function isFreshWorkspace(workspace: string): boolean {
  if (!existsSync(workspace)) return true
  let entries: string[]
  try {
    entries = readdirSync(workspace)
  } catch {
    return true
  }
  const ignored = new Set(['.git', 'node_modules', '.wednesday', '.DS_Store', 'Thumbs.db'])
  for (const entry of entries) {
    if (ignored.has(entry)) continue
    try {
      const stat = statSync(join(workspace, entry))
      if (stat.isFile() && stat.size > 0) return false
      if (stat.isDirectory()) return false
    } catch {
      // An unreadable entry still counts as content.
      return false
    }
  }
  return true
}

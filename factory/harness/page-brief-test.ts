/**
 * Page briefs follow the REQUEST (2026-11-07).
 *
 * WHY THIS TEST EXISTS (operator report: "when I ask to build website ... he
 * build website like same way same structure? it never build like the way it
 * should build, i think it goes locked by bad way?").
 *
 * The first version of the page brief fixed the empty-page problem by
 * dictating a FIXED shape -- header/nav, hero, three sections, footer -- and
 * `pageBuildBrief(objective)` accepted the request as a parameter without
 * ever reading it. The gate then made it worse: it demanded three structural
 * blocks and failed any extra .html file, so a request-shaped page was
 * REJECTED while the generic template PASSED.
 *
 * The rule now: the Factory states the guarantees (real content, real
 * styles, responsive, not a placeholder) and the REQUEST states the
 * structure. These tests hold both halves in place.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point state home at a temp dir before importing the module.
const stateHome = mkdtempSync(join(tmpdir(), 'wed-page-state-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const {
  isPageRequest,
  pageAcceptanceCriteria,
  pageBuildBrief,
  pageCheckCommand,
  pageEntryFile,
  pageIsMultiFile,
  requestedHtmlFiles,
} = await import('./page-brief')

/** The script inside the `node -e "..."` command, unescaped. */
function scriptOf(command: string): string {
  const start = 'node -e "'
  assert.ok(command.startsWith(start), command.slice(0, 40))
  return command.slice(start.length, -1).replace(/\\"/g, '"')
}

/** A real, non-placeholder page with only ONE semantic block. */
function twoBlockPage(): string {
  const filler = 'Real content for the thing the operator asked for. '.repeat(40)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A dense price list</title>
<style>body{font-family:system-ui;margin:0;padding:2rem;max-width:60rem}@media (max-width:640px){body{padding:1rem}}</style>
</head>
<body>
<main>
<h1>Price list</h1>
<p>${filler}</p>
</main>
</body>
</html>
`
}

async function main(): Promise<void> {
  // 1. The brief does NOT dictate a template.
  const brief = pageBuildBrief('build a website for a bakery')
  const text = brief.join('\n')
  for (const banned of [
    'three or more <section>',
    'features / how it works / pricing',
    '<header> with a nav',
    '<main> with a hero',
  ]) {
    assert.ok(!text.includes(banned), `the brief must not dictate a structure: ${banned}`)
  }
  assert.match(text, /NOT a default to fall back on/, 'the brief names the trap explicitly')

  // 2. The request is IN the brief -- the objective parameter is load-bearing.
  assert.match(text, /bakery/, 'the request reaches the model through the brief')

  // 3. Two different requests do not produce the same brief.
  const other = pageBuildBrief('build a one-page price list for a crypto exchange').join('\n')
  assert.notEqual(text, other, 'two different requests must not share one brief')

  // 4. The acceptance criteria verify the GUARANTEES, not a section count.
  const criteria = pageAcceptanceCriteria('build a website for a bakery').join('\n')
  assert.ok(!/three sectioned blocks/.test(criteria), 'no section count is demanded')
  assert.match(criteria, /not a placeholder/i, 'the placeholder guarantee stays')

  // 5. The entry file and the multi-file reading come from the request.
  assert.equal(pageEntryFile('build a website for a bakery'), 'index.html')
  assert.equal(pageEntryFile('build about.html for the team'), 'about.html')
  assert.deepEqual(requestedHtmlFiles('build index.html and about.html'), ['index.html', 'about.html'])
  assert.equal(pageIsMultiFile('build a website for a bakery'), false)
  assert.equal(pageIsMultiFile('build a site with pages for products and contact'), true)
  assert.equal(pageIsMultiFile('build index.html and about.html'), true)

  // 6. THE GATE: a request-shaped page with ONE semantic block passes --
  //    the old gate demanded three and rejected it -- and a hello world
  //    still fails.
  const dir = mkdtempSync(join(tmpdir(), 'wed-page-gate-'))
  try {
    writeFileSync(join(dir, 'index.html'), twoBlockPage())
    const run = spawnSync(process.execPath, ['-e', scriptOf(pageCheckCommand())], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 0, `a request-shaped real page must pass: ${run.stderr}`)

    // The placeholder still fails -- the guarantee the gate was born for.
    writeFileSync(join(dir, 'index.html'), '<html><body><h1>hello world</h1></body></html>')
    const placeholder = spawnSync(process.execPath, ['-e', scriptOf(pageCheckCommand())], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(placeholder.status, 0, 'a hello-world page must still fail')

    // A page with no semantic block at all is not a real page either.
    const noBlocks = twoBlockPage().replace(/<main>/g, '<div>').replace(/<\/main>/g, '</div>')
    writeFileSync(join(dir, 'index.html'), noBlocks)
    const unstructured = spawnSync(process.execPath, ['-e', scriptOf(pageCheckCommand())], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(unstructured.status, 0, 'a page with no semantic block must fail')

    // 7. A request for several pages is not failed for having several pages.
    writeFileSync(join(dir, 'index.html'), twoBlockPage())
    writeFileSync(join(dir, 'about.html'), twoBlockPage())
    const single = spawnSync(process.execPath, ['-e', scriptOf(pageCheckCommand())], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(single.status, 0, 'a single-file request still rejects stray pages')
    const multi = spawnSync(
      process.execPath,
      ['-e', scriptOf(pageCheckCommand('index.html', { allowExtraHtml: true }))],
      { cwd: dir, encoding: 'utf8' },
    )
    assert.equal(multi.status, 0, `a multi-page request accepts extra pages: ${multi.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 8. The request classifier still routes page work to a page brief.
  assert.equal(isPageRequest('build me a website for a bakery'), true)
  assert.equal(isPageRequest('make the site faster'), false, 'an edit is not a page build')

  rmSync(stateHome, { recursive: true, force: true })
  console.log('PAGE BRIEF TEST: PASS (request-derived brief, no template, gate accepts request-shaped pages)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

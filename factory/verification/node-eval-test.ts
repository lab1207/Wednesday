/**
 * The gate command must be able to RUN (2026-11-07).
 *
 * The operator's "build me website" run was marked FAILED by the Factory's own
 * verification command while the coder had produced a correct 7,206-byte page.
 * The command was `node -e "...name=[\"']viewport/i.test(s)..."`; `cmd.exe` does
 * not honour backslash escapes, so it was mangled into "The network path was
 * not found." and exit code 1. The identical check in a file passed.
 *
 * These assertions are the regression: the gate must pass on a real page, and
 * the script must reach node with its nested quote and its regex escapes
 * intact.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pageCheckCommand } from './page-brief'
import { parseNodeEvalCommand, runNodeEval } from './node-eval'
import { VerificationEngine } from './verification-engine'

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sample</title>
<style>
:root{--bg:#ffffff;--fg:#111111;--accent:#3355ff;--muted:#667085;--radius:12px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;background:var(--bg);border-bottom:1px solid #e5e7eb}
nav a{margin-left:1.5rem;color:var(--fg);text-decoration:none;font-weight:500}
nav a:hover{color:var(--accent)}
main{max-width:1080px;margin:0 auto;padding:4rem 2rem}
.hero{display:grid;gap:1.5rem;grid-template-columns:1.2fr 1fr;align-items:center}
h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.1;margin:0 0 1rem;letter-spacing:-0.02em}
h2{font-size:1.5rem;margin:0 0 0.75rem}
p{color:var(--muted);margin:0 0 1rem;max-width:60ch}
.btn{display:inline-block;padding:0.75rem 1.5rem;border-radius:var(--radius);background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
.grid{display:grid;gap:1.5rem;grid-template-columns:repeat(3,1fr);margin-top:4rem}
.card{padding:1.5rem;border:1px solid #e5e7eb;border-radius:var(--radius);background:#fff}
.card h3{margin:0 0 0.5rem;font-size:1.1rem}
footer{padding:3rem 2rem;border-top:1px solid #e5e7eb;color:var(--muted);text-align:center}
@media (max-width:360px){header{flex-direction:column;align-items:flex-start;gap:0.5rem}nav a{margin:0 0.75rem 0 0}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}main{padding:2rem 1rem}}
</style>
</head>
<body>
<header>
<strong>Sample Co</strong>
<nav><a href="#features">Features</a><a href="#about">About</a><a href="#contact">Contact</a></nav>
</header>
<main>
<section class="hero">
<div>
<h1>Build the thing the request asked for</h1>
<p>This page exists to prove the structural gate runs on every platform. It carries real, specific copy, a viewport meta tag, custom properties, a responsive grid and one narrow-screen media query, so the gate has something honest to check.</p>
<a class="btn" href="#features">See what it does</a>
</div>
<div class="card">
<h3>Why this page</h3>
<p>A placeholder would pass a weak gate. This one is long enough, structured enough and specific enough that a strict gate accepts it without being told which sections to build.</p>
</div>
</section>
<section id="features" class="grid">
<div class="card"><h3>Real structure</h3><p>Semantic header, nav, main, section and footer elements, so the document reads correctly to a screen reader and to the checker.</p></div>
<div class="card"><h3>Real styles</h3><p>A single inline style block with CSS custom properties for colour, radius and spacing, and no external stylesheet to fetch.</p></div>
<div class="card"><h3>Real responsiveness</h3><p>Fluid type through clamp, a three column grid that collapses to one column, and layout that stays readable at 360 pixels wide.</p></div>
</section>
<section id="about">
<h2>About this page</h2>
<p>The gate that checks this file states guarantees, not a template. It never asks for a specific number of blocks, and it never demands a header, a hero and a pricing trio. The request decides the shape; the gate decides whether the result is real.</p>
</section>
<section id="contact">
<h2>Contact</h2>
<p>Questions about this build go to the person who asked for it. This page is a deliverable, not a contact form, so it carries no form and no network calls.</p>
</section>
</main>
<footer><p>Sample Co. A page built to pass a gate that actually runs.</p></footer>
</body>
</html>
`

async function main(): Promise<void> {
  const workspace =
    mkdtempSync(
      join(
        tmpdir(),
        'wednesday-node-eval-',
      ),
    )

  try {
    writeFileSync(
      join(workspace, 'index.html'),
      PAGE,
      'utf8',
    )

    // 1. The factory's own gate command is recognised.
    const command =
      pageCheckCommand()

    const parsed =
      parseNodeEvalCommand(
        command,
      )

    assert.ok(
      parsed !== null,
      'the page gate command must be recognised as a node -e command',
    )

    // 2. The nested double quote survives (this is what cmd.exe destroyed).
    assert.ok(
      parsed.script.includes(
        `name=["']viewport`,
      ),
      `the nested quote must survive, got: ${parsed.script}`,
    )

    // 3. Regex escapes survive untouched (only the quote is decoded).
    assert.ok(
      parsed.script.includes(
        '/<html[\\s>]/i',
      ),
      `regex escapes must survive, got: ${parsed.script}`,
    )
    assert.ok(
      parsed.script.includes(
        '/\\.html?$/i',
      ),
      `the dot escape must survive, got: ${parsed.script}`,
    )

    // 4. The script runs and passes, with no shell involved.
    const outcome =
      await runNodeEval(
        parsed.script,
        { cwd: workspace },
      )

    assert.equal(
      outcome.passed,
      true,
      `the gate script must pass against a real page, got: ${outcome.output}`,
    )
    assert.match(
      outcome.output,
      /page ok: \d+ bytes/,
      `the gate must report what it checked, got: ${outcome.output}`,
    )

    // 5. The same command through the ENGINE passes. This is the exact path
    // that failed on the operator's machine.
    const engine =
      new VerificationEngine()

    const verified =
      await engine.verify(
        workspace,
        [],
        [command],
      )

    assert.equal(
      verified.passed,
      true,
      `the engine must pass the page gate, got: ${JSON.stringify(verified)}`,
    )

    // 6. A genuinely broken page still fails. A gate that passes everything is
    //    not a gate.
    writeFileSync(
      join(workspace, 'index.html'),
      '<html><body><p>hello world</p></body></html>',
      'utf8',
    )

    const broken =
      await engine.verify(
        workspace,
        [],
        [command],
      )

    assert.equal(
      broken.passed,
      false,
      'a placeholder page must still fail the gate',
    )

    // 7. Other commands keep the shell path (they are not node -e).
    assert.equal(
      parseNodeEvalCommand(
        'npm test',
      ),
      null,
      'npm test must not be treated as node -e',
    )
    assert.equal(
      parseNodeEvalCommand(
        'python -m pytest -q',
      ),
      null,
      'pytest must not be treated as node -e',
    )
    assert.equal(
      parseNodeEvalCommand(
        'node build.js',
      ),
      null,
      'a script file is not node -e',
    )

    // 8. A plain node -e still parses.
    const plain =
      parseNodeEvalCommand(
        'node -e "process.exit(0)"',
      )

    assert.ok(
      plain !== null,
      'a plain node -e must parse',
    )
    assert.equal(
      plain.script,
      'process.exit(0)',
    )

    console.log('node-eval: PASS')
  } finally {
    rmSync(
      workspace,
      { recursive: true, force: true },
    )
  }
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)

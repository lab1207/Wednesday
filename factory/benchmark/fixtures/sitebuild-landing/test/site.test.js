import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let base
let port
let server

async function page(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, text: await res.text() }
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'sitebuild-test-'))
  process.env.SNIPPETBOX_STORE = join(base, 'data.json')
  const mod = await import('../server/app.js')
  port = await mod.start(0)
  server = mod.server
})

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  await rm(base, { recursive: true, force: true })
})

test('home returns 200 with the shop title', async () => {
  const { status, text } = await page('/')
  assert.equal(status, 200)
  assert.ok(text.includes('<title>PedalWorks</title>'))
})

test('hero section exists', async () => {
  const { text } = await page('/')
  assert.ok(text.includes('id="hero"'), 'missing #hero section')
})

test('features section has three cards', async () => {
  const { text } = await page('/')
  assert.ok(text.includes('id="features"'), 'missing #features section')
  const cards = text.match(/class="feature-card"/g) ?? []
  assert.equal(cards.length, 3, 'expected exactly 3 feature cards')
})

test('pricing section has three tiers', async () => {
  const { text } = await page('/')
  assert.equal((text.match(/id="pricing"/g) ?? []).length, 1)
  const tiers = text.match(/class="price-tier"/g) ?? []
  assert.equal(tiers.length, 3, 'expected exactly 3 pricing tiers')
})

test('contact section exists', async () => {
  const { text } = await page('/')
  assert.ok(text.includes('id="contact"'), 'missing #contact section')
})

test('stylesheet is linked and non-trivial', async () => {
  const { text } = await page('/')
  assert.ok(text.includes('styles.css'), 'stylesheet must be linked')
  const css = await page('/styles.css')
  assert.equal(css.status, 200)
  assert.ok(css.text.length > 200, 'stylesheet must have real rules')
})

test('script is included with nav behaviour', async () => {
  const { text } = await page('/')
  assert.ok(text.includes('app.js'), 'script must be included')
  const js = await page('/app.js')
  assert.equal(js.status, 200)
  assert.ok(js.text.includes('nav-toggle'), 'script must wire the nav toggle')
})

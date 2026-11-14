/**
 * Store logic test for the Ink surface.
 *
 * The Ink renderer is verified with `renderToString`; this test exercises the
 * store's input routing, overlays, and live rows without a TTY.
 */
import assert from 'node:assert/strict'
import { InkStore } from './store'

const store = new InkStore()

// Basic transcript
store.line('hello', 'plain')
store.note('world')
store.error('bad')
assert.equal(store.lines.length, 3)
assert.equal(store.lines[0]!.text, 'hello')
assert.equal(store.lines[1]!.text, 'world')
assert.equal(store.lines[2]!.text, 'bad')
assert.equal(store.lines[2]!.tone, 'red')

// Block
store.block([{ text: 'a', tone: 'dim' }, { text: 'b', tone: 'green' }])
assert.equal(store.lines.length, 5)
assert.equal(store.lines[3]!.tone, 'dim')
assert.equal(store.lines[4]!.tone, 'green')

// Live rows
store.liveRow('run-1', { text: 'working…', tone: 'cyan' })
store.liveRow('run-1', { text: 'done', tone: 'green' })
assert.equal(store.live.get('run-1')!.text, 'done')
assert.equal(store.live.get('run-1')!.tone, 'green')
store.clearLive('run-1')
assert.equal(store.live.has('run-1'), false)

// Header/status/side
store.setHeader({ model: 'qwen', workspace: 'C:\\wednesday', mode: 'PLAN' })
assert.equal(store.header.model, 'qwen')
store.setStatus({ working: true, context: 'ctx 100', sessionTitle: 'task' })
assert.equal(store.status.working, true)
store.setSide([{ text: 'roles & models', tone: 'bold' }])
assert.equal(store.side.length, 1)

// Composer input
store.onSubmit = (text) => { submitted = text }
let submitted = ''
store.handleInput('h', {})
store.handleInput('i', {})
assert.equal(store.input, 'hi')
store.handleInput('', { return: true })
assert.equal(store.input, '')
assert.equal(submitted, 'hi')

// Backspace
store.handleInput('a', {})
store.handleInput('b', {})
store.handleInput('', { backspace: true })
assert.equal(store.input, 'a')

// Select overlay
let picked: string | undefined = 'unset'
store.setOverlay({
  type: 'select',
  title: 'Pick a model',
  options: [
    { value: 'm1', label: 'Model One', description: 'first' },
    { value: 'm2', label: 'Model Two', description: 'second' },
  ],
  filter: '',
  index: 0,
  resolve: (value) => { picked = value },
})
assert.equal(store.overlay?.type, 'select')
store.handleInput('', { downArrow: true })
assert.equal((store.overlay as any).index, 1)
store.handleInput('2', {})
assert.equal((store.overlay as any).filter, '2')
assert.equal((store.overlay as any).index, 0)
store.handleInput('', { return: true })
assert.equal(picked, 'm2')
assert.equal(store.overlay, null)

// Confirm overlay
let confirmed: boolean | undefined
store.setOverlay({
  type: 'confirm',
  title: 'Clear session?',
  detail: 'This cannot be undone.',
  yesLabel: 'Yes, clear',
  index: 1,
  resolve: (value) => { confirmed = value },
})
store.handleInput('', { upArrow: true })
assert.equal((store.overlay as any).index, 0)
store.handleInput('', { return: true })
assert.equal(confirmed, true)

// Clarify overlay
let clarified: any
store.setOverlay({
  type: 'clarify',
  question: 'What do you want?',
  input: '',
  resolve: (value) => { clarified = value },
})
store.handleInput('a', {})
store.handleInput('b', {})
store.handleInput('', { return: true })
assert.deepEqual(clarified, { answer: 'ab' })

// Ask overlay
let asked: string | undefined
store.setOverlay({
  type: 'ask',
  prompt: 'Model id',
  input: '',
  resolve: (value) => { asked = value },
})
store.handleInput('x', {})
store.handleInput('', { return: true })
assert.equal(asked, 'x')

// Escape cancels
let cancelled: string | undefined = 'unset'
store.setOverlay({
  type: 'select',
  title: 'Pick',
  options: [{ value: 'a', label: 'A' }],
  filter: '',
  index: 0,
  resolve: (value) => { cancelled = value },
})
store.handleInput('', { escape: true })
assert.equal(cancelled, undefined)

// Page overlay
let paged = false
store.setOverlay({
  type: 'page',
  title: 'Answer',
  lines: ['one', 'two', 'three'],
  offset: 0,
  resolve: () => { paged = true },
})
store.handleInput('', { downArrow: true })
assert.equal((store.overlay as any).offset, 1)
store.handleInput('', { escape: true })
assert.equal(paged, true)

console.log('INK STORE TEST: PASS (transcript, live rows, header/status/side, composer input, select/confirm/clarify/ask/page overlays)')

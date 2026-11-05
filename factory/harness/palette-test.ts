import { stdin } from 'node:process'
import assert from 'node:assert/strict'
import { Screen, initialState, runSelect } from './screen.js'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

function fakeOut(width: number, height: number) {
  let captured = ''
  const out = { columns: width, rows: height, write: (c: string) => { captured += c; return true } } as unknown as NodeJS.WriteStream
  return { out, get: () => captured }
}

const OPTIONS = [
  { title: '/help', desc: 'this help', value: '/help' },
  { title: '/tasks', desc: 'list tasks', value: '/tasks' },
]

const settle = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms))
const within = async <T,>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> =>
  Promise.race([p, new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), ms))])

async function main(): Promise<void> {
  // A dismissed plate resolves undefined — the same value the REPL reads as
  // "the user left". These checks pin that the dismiss path never reaches the
  // exit branch, which is the reported "any key closes wednesday".
  for (const [label, close] of [
    ['escape', () => stdin.emit('data', '\x1b')],
    ['background click', () => stdin.emit('data', '\x1b[<0;5;5M')],
  ] as Array<[string, () => void]>) {
    const { out } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('W', 'live')
    scr.enter()
    const dismissed = runSelect(out, 80, 24, 'Commands', OPTIONS, () => scr.frame(st), '', scr)
    await settle()
    close()
    const result = await within(dismissed, 1000)
    assert.equal(result, undefined, `${label} resolves undefined (a dismiss, not a pick)`)
    // The session must still be usable afterwards: the keyboard is alive.
    const line = scr.readLine(st, [])
    await settle()
    stdin.emit('data', 'still here')
    await settle()
    stdin.emit('data', '\r')
    assert.equal(await within(line, 1000), 'still here', `${label} leaves the composer working`)
    scr.exit()
  }

  // Ctrl+C inside the plate dismisses it too — it must NOT end the session,
  // because the operator's next word is almost never "quit".
  {
    const { out } = fakeOut(80, 24)
    const scr = new Screen(out, 80, 24)
    const st = initialState('W', 'live')
    scr.enter()
    const plate = runSelect(out, 80, 24, 'Commands', OPTIONS, () => scr.frame(st), '', scr)
    await settle()
    stdin.emit('data', '\x03')
    assert.equal(await within(plate, 1000), undefined, 'Ctrl+C in the plate is a dismiss')
    assert.equal(scr.requestAbort, false, 'and it does not arm an abort for the next run')
    const line = scr.readLine(st, [])
    await settle()
    stdin.emit('data', 'abc')
    await settle()
    stdin.emit('data', '\r')
    assert.equal(await within(line, 1000), 'abc', 'the session survives a Ctrl+C in the plate')
    scr.exit()
  }

  console.log('PALETTE LIFECYCLE TEST: PASS (dismiss never exits, keyboard survives)')
}

void main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e); process.exit(1) })

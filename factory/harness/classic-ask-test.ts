/**
 * Classic prompt: recall and EOF, tested in-process.
 *
 * A piped child process puts readline in dumb mode — no line editor at all — so
 * pressing Up there proves nothing, which is exactly why "Up does nothing on the
 * classic path" survived every child-process test. Handing the streams in lets
 * the same code be driven with a real line editor.
 *
 *   npx tsx factory/harness/classic-ask-test.ts
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { createClassicAsk } from './classic-ask.js'

interface Harness {
  ask: ReturnType<typeof createClassicAsk>
  input: PassThrough & { isTTY: boolean }
  echo: () => string
}

function harness(historyLimit?: number): Harness {
  const input = new PassThrough() as PassThrough & { isTTY: boolean }
  const output = new PassThrough() as unknown as NodeJS.WriteStream & { isTTY: boolean }
  let echoed = ''
  output.on('data', chunk => { echoed += String(chunk) })
  // Both ends must claim to be a terminal or readline picks its dumb path and
  // the keypress plumbing this test is about is never installed.
  input.isTTY = true
  output.isTTY = true
  return {
    ask: createClassicAsk({ input, output, historyLimit }),
    input,
    echo: () => echoed,
  }
}

/** Press a key, then wait for readline to settle. */
async function press(h: Harness, keys: string, settle = 80): Promise<void> {
  h.input.write(keys)
  await new Promise(resolve => setTimeout(resolve, settle))
}

async function main(): Promise<void> {
  // 1. A plain line comes back verbatim, and the prompt is written first.
  {
    const h = harness()
    const pending = h.ask('wednesday> ')
    await press(h, '/health\n', 10)
    assert.equal(await pending, '/health', 'the line reaches the caller')
    assert.ok(h.echo().startsWith('wednesday> '), 'the prompt is written before the line is read')
    h.ask.close()
  }

  // 2. Up recalls the previous request, and Enter submits the RECALLED text.
  //    This is the regression: the classic path had no history array at all, so
  //    Up silently did nothing while the screen composer had recall for months.
  {
    const h = harness()
    const first = h.ask('wednesday> ')
    await press(h, 'fix the login leak\n', 10)
    assert.equal(await first, 'fix the login leak')

    const second = h.ask('wednesday> ')
    await press(h, '\x1b[A')
    assert.match(h.echo(), /fix the login leak/, 'Up paints the recalled request')
    await press(h, '\n', 10)
    assert.equal(await second, 'fix the login leak', 'Enter submits what Up recalled')
    h.ask.close()
  }

  // 3. Up walks BACK through history, newest first.
  {
    const h = harness()
    for (const line of ['first', 'second', 'third']) {
      const pending = h.ask('wednesday> ')
      await press(h, `${line}\n`, 10)
      await pending
    }
    const pending = h.ask('wednesday> ')
    await press(h, '\x1b[A')
    await press(h, '\x1b[A')
    await press(h, '\n', 10)
    assert.equal(await pending, 'second', 'two Ups land on the second-newest request')
    h.ask.close()
  }

  // 4. Repeats collapse: asking the same thing twice must not push the prompt
  //    the operator wanted off the top of the recall list.
  {
    const h = harness()
    for (const line of ['/health', '/health', '/tasks']) {
      const pending = h.ask('wednesday> ')
      await press(h, `${line}\n`, 10)
      await pending
    }
    assert.deepEqual(h.ask.history(), ['/health', '/tasks'], 'consecutive duplicates collapse')
    h.ask.close()
  }

  // 5. The list is capped, so a long session cannot grow it without bound.
  {
    const h = harness(3)
    for (const line of ['a', 'b', 'c', 'd', 'e']) {
      const pending = h.ask('> ')
      await press(h, `${line}\n`, 10)
      await pending
    }
    assert.deepEqual(h.ask.history(), ['c', 'd', 'e'], 'the oldest entries fall off the top')
    h.ask.close()
  }

  // 6. EOF (Ctrl+D, or a closed pipe) resolves undefined, which is the REPL's
  //    "leave" signal — it must not hang and must not resolve an empty line.
  {
    const h = harness()
    const pending = h.ask('wednesday> ')
    await press(h, '\x04', 10)
    assert.equal(await pending, undefined, 'EOF resolves undefined, so the REPL leaves')
    h.ask.close()
  }
  {
    const h = harness()
    const pending = h.ask('wednesday> ')
    h.input.end()
    assert.equal(await pending, undefined, 'a closed input stream also leaves')
  }

  // 7. Closing twice is safe (main() closes in a finally, and the screen path
  //    never opened a reader at all).
  {
    const h = harness()
    const pending = h.ask('> ')
    await press(h, 'x\n', 10)
    await pending
    h.ask.close()
    h.ask.close()
  }

  console.log('CLASSIC ASK TEST: PASS (line, Up recall, walk-back, dedupe, cap, EOF, idempotent close)')
}

void main().catch(error => {
  console.error(String(error))
  process.exitCode = 1
})

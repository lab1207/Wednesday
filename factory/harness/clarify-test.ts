import { stdin } from 'node:process'
import assert from 'node:assert/strict'
import { Screen, initialState } from './screen.js'

/**
 * THE QUESTION CHANNEL, ON THE SCREEN (2026-11-10).
 *
 *   "the stage architect and planner don't ask question they just go? ...
 *    they must ask relevant question related the task then next and so on"
 *
 * A question asked mid-run is a PROMPT, not a request, and the screen has to
 * behave like one:
 *
 *  - Esc CANCELS the question. It must NOT fall through to the
 *    "interrupt the live run" branch: that branch only breaks out of the
 *    switch and leaves the reader waiting, which would hang the run on a key
 *    press (and the operator would see a frozen screen with no way out).
 *  - Ctrl+C CANCELS the question too, and the caller is told WHICH key it
 *    was: "I am not answering this one" and "stop the run" are different
 *    answers and must not look the same.
 *  - The keyboard can be handed over for the question WITHOUT giving up the
 *    run's stop control: a paused run is still a run, and the mouse stop
 *    button must keep working while the operator thinks.
 */

function fakeOut(width: number, height: number): NodeJS.WriteStream {
  return {
    columns: width,
    rows: height,
    isTTY: true,
    write: () => true,
  } as unknown as NodeJS.WriteStream
}

async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | 'TIMEOUT'> {
  return Promise.race([
    promise,
    new Promise<'TIMEOUT'>(resolve =>
      setTimeout(() => resolve('TIMEOUT'), ms),
    ),
  ])
}

async function main(): Promise<void> {
  // 1. ESC CANCELS THE QUESTION, AND SAYS SO.
  {
    const scr = new Screen(fakeOut(80, 24), 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    st.busy = true

    let reason: string | undefined
    const line = scr.readLine(st, [], {
      ctrlC: 'cancel',
      escape: 'cancel',
      onCancel: value => { reason = value },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\x1b')

    const value = await within(line, 500)
    assert.equal(
      value,
      undefined,
      'Esc ends the question instead of hanging the reader',
    )
    assert.equal(
      reason,
      'escape',
      'the caller is told the question was skipped, not stopped',
    )
    scr.exit()
  }

  // 2. CTRL+C CANCELS THE QUESTION, AND SAYS *THAT*.
  {
    const scr = new Screen(fakeOut(80, 24), 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    st.busy = true

    let reason: string | undefined
    const line = scr.readLine(st, [], {
      ctrlC: 'cancel',
      escape: 'cancel',
      onCancel: value => { reason = value },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\x03')

    const value = await within(line, 500)
    assert.equal(value, undefined, 'Ctrl+C ends the question')
    assert.equal(
      reason,
      'ctrl-c',
      'Ctrl+C is the stop key everywhere else, and it must not be a soft no-op here',
    )
    scr.exit()
  }

  // 3. THE ANSWER COMES BACK AS ONE LINE.
  {
    const scr = new Screen(fakeOut(80, 24), 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()
    st.busy = true

    const line = scr.readLine(st, [], {
      ctrlC: 'cancel',
      escape: 'cancel',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', 'Postgres')
    stdin.emit('data', '\r')

    const value = await within(line, 500)
    assert.equal(value, 'Postgres', 'the answer is the line the operator typed')
    assert.equal(st.input, '', 'the draft is cleared for the next question')
    scr.exit()
  }

  // 4. THE KEYBOARD CAN CHANGE HANDS, AND THE STOP CONTROL SURVIVES.
  {
    const scr = new Screen(fakeOut(80, 24), 80, 24)
    const st = initialState('WEDNESDAY', 'mode live')
    scr.enter()

    const queued: string[] = []
    let interrupted = 0
    const stop = scr.watchRun(
      st,
      () => { interrupted += 1 },
      text => { queued.push(text) },
    )

    // The run is live: the composer owns the keyboard.
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', 'a')
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(
      queued,
      ['a'],
      'the live-run composer takes the typed line',
    )

    // The question takes the keyboard. The stop control must NOT go with it.
    scr.releaseRunKeyboard()
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.emit('data', 'b')
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(
      queued,
      ['a'],
      'the released composer does not take the question\'s keystrokes',
    )

    // The stop control is still live: a paused run is still a run.
    scr.requestAbort = false
    ;(scr as unknown as { onStop?: () => void }).onStop?.()
    assert.equal(
      interrupted,
      1,
      'the stop control still interrupts the run while a question is up',
    )

    stop()
    scr.exit()
  }

  console.log(
    'CLARIFY TEST: PASS (Esc cancels the question, Ctrl+C cancels and says so, the answer is one line, the keyboard changes hands and the stop control survives)',
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

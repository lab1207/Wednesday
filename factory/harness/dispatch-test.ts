/**
 * REPL dispatch on the SCREEN path — the coverage that let a crash ship.
 *
 * Every command the operator can type runs through `replLoop`, but the piped
 * (`--classic`) tests exercise a DIFFERENT `ui` than the TTY one. A screen-only
 * branch therefore had no coverage at all, and "state is not defined" shipped
 * that way: the crash sat behind `if (screen)`, every child-process test passed,
 * and every real request in a real terminal died on a one-line error.
 *
 * This drives `replLoop` in-process with a REAL `Screen` over a captured stream
 * and a recording `ui`, so the TTY path is exercised without a TTY. `approve`
 * always rejects, so nothing is submitted, no model is called and no spend
 * happens — the assertions are about the path, not about a run.
 *
 *   npx tsx factory/harness/dispatch-test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// THE OPERATOR'S LIVE STATE MUST NOT REACH THIS TEST (2026-11-10).
//
// This import comes FIRST on purpose: it sets the state home before
// `factory/paths.ts` is evaluated (ESM evaluates imports in source order),
// so the test reads its own temp state instead of the operator's real
// `~/.wednesday/state`. With a team selected on the machine, `/team` printed
// that team's policy instead of saying there is no team, and the suite failed
// for a reason that had nothing to do with the code under test.
//
// The same trap bit `chat-tui-test.ts`: the active crew overrode the route the
// test pinned, and the chat went to a hosted model that answered "not a valid
// model id" instead of the scripted local server.
//
// A test that reads the operator's real state is not a test.
import './test-state-home.js'

import { PersistentFactoryEventBus } from '../events/index.js'
import { Screen, initialState } from './screen.js'
import { parseFlags, replLoop, retryHint, screenStatusContext, PALETTE, HELP_COMMANDS, type ReplUi } from './harness.js'
import { configBlockerIn } from './config.js'
import type { DisplayMode } from './display-store.js'

interface Recorded {
  notes: string[]
  errors: string[]
  progress: string[]
  running: boolean[]
  approved: number
  painted: () => string
}

/**
 * One dispatch session over a temp workspace.
 *
 * `picks` feeds the agent/model plate: each entry is the value a `select` call
 * resolves to, in order (the same way `script` feeds `ask`). With no picks the
 * plate is cancelled — the path every command sweep expects.
 *
 * `approve` always rejects: the assertions are about the PATH a request takes,
 * not about a run, so this suite never submits a task, never calls a model and
 * never spends anything.
 */
async function drive(
  script: string[],
  picks: Array<string | undefined> = [],
  options: { approve?: boolean } = {},
): Promise<Recorded> {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-'))
  try {
    await mkdir(join(directory, 'workspace', 'src'), { recursive: true })
    await writeFile(join(directory, 'workspace', 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -v' } }))
    await writeFile(join(directory, 'workspace', 'src', 'index.ts'), 'export const x = 1\n')

    let captured = ''
    const out = {
      columns: 100, rows: 30, isTTY: true,
      write: (chunk: string) => { captured += chunk; return true },
    } as unknown as NodeJS.WriteStream
    const screen = new Screen(out, 100, 30)
    const state = initialState('WEDNESDAY', 'mode live')
    state.composerLabel = 'demo-model'
    screen.enter()

    const notes: string[] = []
    const errors: string[] = []
    const blocks: string[] = []
    const progress: string[] = []
    const running: boolean[] = []
    let approved = 0
    // The screen's density, held here the way screenRepl holds it: `/display`
    // reads and sets this, not the real store, so a test never changes the
    // developer's preference.
    let displayMode: DisplayMode = 'normal'
    const queue = [...script]
    const ui: ReplUi = {
      ask: async () => queue.shift(),
      // `approve` is the gate's answer: a rejection is what most cases want,
      // but the one case that proves an APPROVED run works passes true — that
      // branch is where a scope bug hid (see B100).
      approve: async () => { approved += 1; return options.approve ?? false },
      note: text => { notes.push(text); screen.push(state, { text, tone: 'plain' }) },
      error: text => { errors.push(text); screen.push(state, { text, tone: 'red' }) },
      // The real screen ui routes every inspection view (/health, /tasks,
      // /result) through `block`. A fake without it records nothing, which is
      // how this suite once "passed" while those commands were silent.
      block: lines => { for (const line of lines) { blocks.push(line.text); screen.push(state, line) } },
      progress: text => { progress.push(text); screen.notify(state, text) },
      running: active => { running.push(active); state.busy = active },
      // The REAL builder, not a stub: `/status` in a live session reads its
      // session facts through this function, and the first version of it
      // referenced a name that did not exist in scope. A stub here would keep
      // that class of crash invisible.
      statusContext: () => screenStatusContext(state, 'test-session', join(directory, 'workspace')),
      display: mode => { if (mode) displayMode = mode; return displayMode },
      select: async () => picks.shift(),
      help: async () => {},
      redraw: () => screen.render(state),
    }
    const bus = new PersistentFactoryEventBus({ filePath: join(directory, 'events.jsonl') })
    const defaults = parseFlags(['--workspace', join(directory, 'workspace'), '--test', 'node -v'])
    await replLoop(defaults, bus, ui, undefined, screen)
    screen.exit()
    return {
      notes,
      errors,
      blocks,
      progress,
      running,
      approved,
      painted: () => captured,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  // The gate added in 2026-10-05 reads the real environment, so every case
  // below runs inside a declared one. Before it existed these assertions passed
  // unconditionally; that was the defect, not the coverage — "the request
  // reaches the approval card" is only a statement about a READY route.
  const ready = { OPENROUTER_API_KEY: 'synthetic-dispatch-key', DSH_LLM_MODEL: 'example/model' }
  const original = { ...process.env }
  const withEnv = async (vars: NodeJS.ProcessEnv, body: () => Promise<void>): Promise<void> => {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try { await body() } finally {
      for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]
      Object.assign(process.env, original)
    }
  }

  await withEnv(ready, async () => {
  // 1. The regression itself: a bare request on the SCREEN path. It used to die
  //    with "state is not defined" before the approval card was ever built.
  {
    const rec = await drive(['fix the login leak'])
    assert.deepEqual(rec.errors, [], 'a request on the screen path raises nothing')
    assert.equal(rec.approved, 1, 'and it reaches the approval gate')
    assert.ok(rec.progress.includes('reading workspace…'), 'the workspace read announces itself')
    assert.ok(rec.running.includes(true), 'the scanner is lit while it works')
    assert.ok(rec.notes.some(n => /cancelled by operator/.test(n)), 'a rejection leaves a receipt')
  }

  // 1b. The OTHER half of the same regression (B100): an APPROVED run. A
  //     rejection never reaches the code that arms the live-run keyboard, so
  //     the branch that crashed with "state is not defined" sat uncovered
  //     while this file claimed the screen path was tested.
  //
  //     Driven as a SUBPROCESS, not in-process: the deterministic engine the
  //     approved path starts owns its own stdio, and inheriting this test's
  //     paused stdin is what made the in-process version block forever. The
  //     subprocess is also the shape a real operator gets. `--repl` runs the
  //     same screen path this file's `drive()` covers; the model never runs.
  if (process.env.DISPATCH_APPROVED_RUN === '1') {
    const directory = await mkdtemp(join(tmpdir(), 'dispatch-approved-'))
    try {
      // The app validates the workspace exists before it will run anything, so
      // the fixture has to be real (a package.json with a test script, so the
      // verification step is honest too).
      await mkdir(join(directory, 'workspace'), { recursive: true })
      await writeFile(join(directory, 'workspace', 'package.json'), JSON.stringify({ name: 'dispatch-approved', version: '1.0.0', scripts: { test: 'node -v' } }))
      const env = {
        ...process.env,
        HARNESS_WORKSPACE: join(directory, 'workspace'),
        HERMES_TASKS_PATH: join(directory, 'hermes-tasks.json'),
        FACTORY_EVENTS_PATH: join(directory, 'events.jsonl'),
        FACTORY_EXECUTION_MODE: 'deterministic',
        WEDNESDAY_NO_UPDATE_CHECK: '1',
        WEDNESDAY_NO_STARTUP_HEALTH: '1',
      }
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/wednesday.js', import.meta.url)), '--repl'],
        { encoding: 'utf8', input: 'fix the login leak\ny\n/tasks\n/exit\n', timeout: 120000, windowsHide: true, env })
      assert.equal(run.status, 0, run.stderr || run.stdout)
      assert.doesNotMatch(run.stderr ?? '', /state is not defined/, 'an approved screen run is not a scope crash')
      assert.match(run.stdout, /task/i, 'and the approved run actually ran')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  // 2. Every advertised command runs on the screen path without throwing. The
  //    classic suite covers these over a pipe; this is the same list through the
  //    TTY `ui`, which is where the untested branch lived.
  {
    const rec = await drive([
      '/help', '/agents', '/model', '/status', '/doctor', '/tasks', '/health',
      '/display', '/display verbose', '/display loud',
      '/result nope', '/events nope', '/run nope', '/frobnicate', '/exit',
    ])
    const fatal = rec.errors.filter(e => /is not defined|is not a function|undefined is not/.test(e))
    assert.deepEqual(fatal, [], 'no command reaches an undefined reference on the screen path')
    // Expected, handled errors are still errors — just not crashes.
    assert.ok(rec.errors.some(e => /Unknown command/.test(e)), 'an unknown command is reported')
    assert.ok(rec.errors.some(e => /Task not found/.test(e)), 'a missing task id is reported')
    // `/run <unknown>` fails on the same lookup, and `/help` printed something.
    if (process.env.DEBUG_DISPATCH) console.error(JSON.stringify({ notes: rec.notes, errors: rec.errors, blocks: rec.blocks }, null, 1))
    assert.ok(rec.notes.length + rec.errors.length + rec.blocks.length > 5, 'the commands produced output rather than silence')
    // /health is now a shaped view, so it must arrive as per-line toned rows
    // (not one blob) and must name the meter, not just not-crash.
    assert.ok(rec.blocks.some(line => /factory health:/.test(line)), 'the meter report reaches the output as rows')
    // /status and /doctor are the CLI's two commands that were not reachable
    // inside a session; both now answer here, with real rows.
    assert.ok(rec.blocks.some(line => /^Route:/.test(line)), '/status reports the live route')
    assert.ok(rec.blocks.some(line => /^Agent Running: No$/.test(line)), '/status reads the live session fact, not an out-of-scope name')
    assert.ok(rec.blocks.some(line => /read|git|node|workspace/i.test(line)), '/doctor reports readiness')
    assert.ok(rec.progress.some(text => /health: probing/.test(text)), 'the meter announces itself while it probes')
    // `/display` is a getter AND a setter: bare answers with the live density,
    // a mode changes it, and a word that is not a mode is refused by name.
    assert.ok(rec.notes.some(note => /^display: normal/.test(note)), '/display reads the live density')
    assert.ok(rec.notes.some(note => /^display set: verbose/.test(note)), '/display sets the density')
    assert.ok(rec.errors.some(error => /Unknown display mode/.test(error)), 'an unknown density is reported, not guessed')
  }

  // 3. `/exit` leaves; `/help` opens the plate without consuming the request.
  {
    const rec = await drive(['/help', '/exit'])
    assert.deepEqual(rec.errors, [], 'help then exit is clean')
  }

  // 3b. `/team` and `/templates` (2026-11-05): the team's POLICY and the
  //     saved requests. Both are new commands, so both must run on the screen
  //     path without throwing and must say something honest when there is
  //     nothing to show.
  {
    const rec = await drive([
      '/team', '/team shape duel', '/team repairs 2', '/team tokens 50000',
      '/team usd 0.25', '/team test "npm test"', '/team files src/a.ts,src/b.ts',
      '/team shape nonsense', '/team reset',
      '/templates', '/templates save demo', '/templates show demo',
      '/templates delete demo', '/templates',
    ])
    const fatal = rec.errors.filter(e => /is not defined|is not a function|undefined is not/.test(e))
    assert.deepEqual(fatal, [], 'the new commands reach no undefined reference')
    assert.ok(
      rec.notes.some(n => /No active team/.test(n)),
      'with no team, /team says so instead of printing a blank policy',
    )
    assert.ok(
      rec.notes.some(n => /No templates yet/.test(n)),
      'with no templates, /templates says so instead of printing nothing',
    )
  }

  // 4. Empty and whitespace lines are no-ops: no approval, no error, no note.
  //    (The `/` plate lives in the COMPOSER's ask loop, not in this dispatch
  //    layer — a bare `/` arriving here really is an unknown command, which is
  //    why the composer's own test covers the plate instead.)
  {
    const rec = await drive(['', '   ', '/exit'])
    assert.deepEqual(rec.errors, [], 'blank input is not an error')
    assert.equal(rec.approved, 0, 'blank input never reaches the gate')
    assert.deepEqual(rec.notes, [], 'and prints nothing')
  }

  // 5. The scanner is lit for the workspace read and off once the gate is
  //    answered — a spinner left running reads as a hung session.
  {
    const rec = await drive(['do the thing'])
    assert.equal(rec.approved, 1, 'exactly one approval was requested')
    assert.ok(!rec.running.slice(-1)[0], 'the scanner is off once the gate is answered')
    assert.ok(rec.painted().length > 0, 'the session painted something')
  }
  })

  // 6. A run that CANNOT start must never reach the approval card, and must not
  //    be reported as cancelled. This is the reported operator symptom: the
  //    NVIDIA route with no key showed a card, `y` ran a doomed task, and the
  //    retry card looked identical — so `y` appeared to do nothing. The screen
  //    path had no gate at all before 2026-10-05; only the classic path had one.
  //
  //    Note the OpenRouter key below is PRESENT. That is the exact rig that
  //    failed: the old gate checked OpenRouter, found it, and waved the doomed
  //    NVIDIA run through the approval card.
  //
  //    FACTORY_EXECUTION_MODE is cleared for this block (2026-11-10): the
  //    deterministic provider needs no API key, so in that mode the NVIDIA
  //    route is NOT impossible and the card IS correct -- the assertion
  //    below is about a route that cannot start, and the mode decides
  //    whether it can. The block sets its own world; it must own it whole.
  await withEnv({ FACTORY_LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: undefined, OPENROUTER_API_KEY: ready.OPENROUTER_API_KEY, DSH_LLM_MODEL: ready.DSH_LLM_MODEL, FACTORY_EXECUTION_MODE: undefined }, async () => {
    const rec = await drive(['fix the login leak'])
    assert.equal(rec.approved, 0, 'no approval card is offered for an impossible run')
    assert.ok(rec.errors.some(e => /NVIDIA key missing/.test(e)), 'the blocker names the real route')
    assert.ok(rec.notes.some(n => /NVIDIA_API_KEY/.test(n)), 'with the one action that clears it')
    assert.ok(!rec.errors.some(e => /OpenRouter key missing/.test(e)), 'and never asks for the wrong provider')
    assert.ok(!rec.notes.some(n => /cancelled by operator/.test(n)),
      'and it is NOT reported as an operator cancel — nobody cancelled anything')

    // The retry, which is what made `y` look broken: the gate must hold on the
    // second request too, or the operator just walks into the same wall again.
    // NOTE (2026-10-30, real chat loop): the second input here must stay a
    // BUILD request (4+ words) — a two-word reply is now a conversation turn
    // and path-checks the CHAT blocker instead of this approval gate.
    const again = await drive(['fix the login leak', 'fix the login leak again'])
    assert.equal(again.approved, 0, 'the gate holds across requests, not just the first')
  })

  // 7. The same gate on a route that IS ready must still approve: a gate that
  //    blocks everything is the same freeze wearing a different hat.
  await withEnv(ready, async () => {
    const rec = await drive(['fix the login leak', 'fix it again'])
    assert.equal(rec.approved, 2, 'a ready route still reaches the gate, every time')
  })

  // 7b. The chat gate (2026-10-30, real chat loop): a short conversational
  //     request is a TURN, not a build. It never shows an approval card, and
  //     when the route is dead the chat path names ITSELF as what answered —
  //     a two-word reply can never silently queue a build pipeline.
  await withEnv(
    { FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_LLM_MODEL: 'offline-chat-model' },
    async () => {
      const rec = await drive(['and again'])
      assert.equal(rec.approved, 0, 'chat never shows an approval card')
      assert.ok(
        rec.notes.concat(rec.errors).some(n => /Chat (failed|blocked)/.test(n)),
        'the chat loop is the path that answered, and it says so',
      )
    },
  )

  // 8. The closing hint of a failed run. Asserted directly because proving it
  //    any other way needs a live run, and this is the line that produced the
  //    loop: `/run <id>` on a missing credential is a promise that the identical
  //    doomed run will be offered again.
  {
    const blocker = configBlockerIn('architect failed: NVIDIA_API_KEY is not set', { FACTORY_LLM_PROVIDER: 'nvidia' })
    assert.ok(blocker, 'the reported diagnostics classify as a blocker')
    assert.ok(!/\/run /.test(retryHint('t1', blocker)), 'a blocker never offers a doomed retry')
    assert.match(retryHint('t1', blocker), /\/result t1 to inspect/)
    assert.match(retryHint('t1', null), /\/run t1 to retry/, 'a real failure still offers its retry')
    assert.match(retryHint('t1', null), /\/result t1 to inspect/)
  }

  // 9. The agent plate is the crew's control surface: a seat row picks the
  //    seat's model from the SAME model plate the /create flow uses (pickSeatModel
  //    — operator decision 2026-11-01: select models, make the team), and a
  //    profile pick reports the LIVE seats — the old receipt said `seats on
  //    <route>`, which was false as soon as one seat held an override (trio
  //    keeps overrides; only unset seats take the route).
  await withEnv({ ...ready, FACTORY_CREW_PLANNER_MODEL: undefined, FACTORY_CREW_CODER_MODEL: undefined, FACTORY_CREW_VISION_MODEL: undefined }, async () => {
    const rec = await drive(
      ['/agents', '/agents', '/model', '/exit'],
      ['seat:FACTORY_CREW_VISION_MODEL', 'route:acme/vision-small', 'trio', 'seat:FACTORY_CREW_CODER_MODEL', 'route:acme/coder-small'],
    )
    assert.deepEqual(rec.errors, [], 'seat and profile picks raise nothing')
    assert.equal(process.env.FACTORY_CREW_VISION_MODEL, 'acme/vision-small', 'the agent plate seat row writes its slot from a plate pick')
    assert.equal(process.env.FACTORY_CREW_CODER_MODEL, 'acme/coder-small', 'the model plate seat row writes its slot from a plate pick')
    assert.equal(process.env.FACTORY_CREW_PLANNER_MODEL, 'example/model', 'trio fills only the seat without an override')
    assert.ok(rec.notes.includes('vision seat = acme/vision-small'), 'a seat write leaves a named receipt')
    // 2026-11-05: the crew has SIX seats now (architect, planner, coder,
    // tester, reviewer, vision), so the receipt names the seats that DEVIATE
    // from the route and counts the ones that ride it - six names in a row
    // said the same thing six times.
    // 2026-11-07: the roster added THREE more seats (autocomplete,
    // bug-hunter, security-audit). An unstaffed seat rides the coder slot,
    // so all three ride the route and the count moves from five to eight.
    assert.ok(rec.notes.some(n => n === 'crew: trio · 8 on example/model · vision acme/vision-small'),
      'the trio receipt names the kept override, not the route it hoped for: ' + JSON.stringify(rec.notes))
    assert.ok(rec.progress.some(p => p === 'crew → trio'), 'a profile pick toasts on the screen path')
  })

  // 10. A profile pick with no route changes nothing and must not toast a
  //     change that did not happen.
  await withEnv({ DSH_LLM_MODEL: undefined, FACTORY_CREW_PLANNER_MODEL: undefined, FACTORY_CREW_CODER_MODEL: undefined, FACTORY_CREW_VISION_MODEL: undefined }, async () => {
    const rec = await drive(['/agents', '/exit'], ['trio'])
    assert.ok(rec.notes.some(n => /no DSH_LLM_MODEL set/.test(n)), 'the no-op names the missing route')
    assert.ok(!rec.progress.some(p => p.startsWith('crew →')), 'and raises no crew toast')
  })

  // 11. /uninstall is NOT a menu command (operator decision 2026-11-01): it
  //     appears in no palette or help listing, and typing it prints the CLI
  //     instructions instead of deleting anything from inside the session.
  {
    assert.ok(!PALETTE.some(entry => entry.value === '/uninstall'), 'the command plate has no /uninstall row')
    assert.ok(!HELP_COMMANDS.some(([name]) => name === '/uninstall'), 'the classic help has no /uninstall row')
    const rec = await drive(['/uninstall', '/exit'])
    assert.deepEqual(rec.errors, [], 'the uninstall verb raises no error')
    assert.ok(rec.notes.some(n => /wednesday uninstall/.test(n)),
      'typing /uninstall prints the exit-first CLI command')
    assert.ok(rec.notes.some(n => /never touched/.test(n)), 'and the data-safety note')
    assert.ok(!rec.notes.some(n => /\bdeleted\b/i.test(n)), 'and deletes nothing')
  }

  // 12. /model now lists the models of the configured connections and asks
  //     WHICH ROLE should use the pick (2026-11-01). The seats used to be
  //     filled by the factory with no way to say "this model is my coder".
  await withEnv({ ...ready, FACTORY_CREW_PLANNER_MODEL: undefined, FACTORY_CREW_CODER_MODEL: undefined, FACTORY_CREW_VISION_MODEL: undefined }, async () => {
    const all = await drive(['/model', '/exit'], ['assign:acme/all-model', 'all'])
    assert.deepEqual(all.errors, [], 'a connection model pick raises nothing')
    assert.equal(process.env.DSH_LLM_MODEL, 'acme/all-model', 'all-roles moves the session route')
    for (const env of ['FACTORY_CREW_PLANNER_MODEL', 'FACTORY_CREW_CODER_MODEL', 'FACTORY_CREW_VISION_MODEL']) {
      assert.equal(process.env[env], 'acme/all-model', `${env} follows an all-roles pick`)
    }
    assert.ok(all.notes.includes('all roles → acme/all-model'), 'the receipt names the roles')
    assert.ok(all.progress.some(p => p.includes('all-model')), 'the composer tag follows the pick')

    const one = await drive(['/model', '/exit'], ['assign:acme/vision-only', 'seat:FACTORY_CREW_VISION_MODEL'])
    assert.deepEqual(one.errors, [], 'a per-role pick raises nothing')
    assert.equal(process.env.FACTORY_CREW_VISION_MODEL, 'acme/vision-only', 'the chosen role takes the pick')
    assert.equal(process.env.FACTORY_CREW_CODER_MODEL, 'acme/all-model', 'the other seats are untouched')
    assert.ok(one.notes.includes('vision role → acme/vision-only'), 'a per-role receipt names the role')

    // A cancelled role pick changes nothing (the plate can be dismissed).
    const cancelled = await drive(['/model', '/exit'], ['assign:acme/never-applied', undefined])
    assert.deepEqual(cancelled.errors, [], 'a dismissed role pick raises nothing')
    assert.notEqual(process.env.FACTORY_CREW_VISION_MODEL, 'acme/never-applied', 'a dismissed pick applies nothing')
  })

  console.log('DISPATCH TEST: PASS (screen-path request, every advertised command, blank input, config gate blocks impossible runs, no doomed retry, no spend, seat model plate picks, /uninstall guidance-only, /model connection picks with role assignment)')
}

void main().catch(error => {
  console.error(String(error))
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Terminal harness REPL test — persistent prompt + task inspection.
 * Drives the real harness in --repl mode with piped input:
 * /tasks on empty store, new task via interactive verification prompt,
 * /tasks listing, /result inspection, /events, unknown command guard,
 * and /exit leaving the session cleanly.
 */

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-repl-'))
  try {
    await mkdir(join(directory, 'workspace', 'src'), { recursive: true })
    await writeFile(join(directory, 'workspace', 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await writeFile(join(directory, 'workspace', 'src', 'index.ts'), 'export const x = 1\n')

    const artifact = 'repl-proof.txt'
    const harnessPath = fileURLToPath(new URL('../../bin/wednesday.js', import.meta.url))
    const env = {
      ...process.env,
      HARNESS_WORKSPACE: join(directory, 'workspace'),
      HERMES_TASKS_PATH: join(directory, 'hermes-tasks.json'),
      FACTORY_EVENTS_PATH: join(directory, 'events.jsonl'),
      FACTORY_EXECUTION_MODE: 'deterministic',
      // Hermetic (2026-11-04): the harness loads `~/.wednesday/.env` and only
      // fills variables that are UNDEFINED, so the ambient profile used to
      // decide what `/status` printed — and this suite asserted on that line.
      // On a machine whose profile routed to another provider the assertion
      // failed for a reason that had nothing to do with the harness (the same
      // env scrub `yc-demo-test.ts` already used). The route is cosmetic here:
      // the run is deterministic and makes no model call.
      FACTORY_LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
      LOCAL_LLM_MODEL: 'demo-3b',
      LOCAL_LLM_API_KEY: 'demo',
      LOCAL_TOOL_PROXY_UPSTREAM: '',
      FACTORY_CREW_PLANNER_MODEL: '',
      FACTORY_CREW_PLANNER_BASE_URL: '',
      FACTORY_CREW_VISION_MODEL: '',
      FACTORY_CREW_VISION_BASE_URL: '',
      FACTORY_CREW_CODER_MODEL: '',
      FACTORY_CREW_CODER_BASE_URL: '',
    }

    // Session script: empty /tasks → create task (verification + required
    // file prompts, approval) → /tasks shows completed → /result → /events
    // → unknown command → /exit.
    const verify = `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('${artifact}', 'utf8').trim(), 'REPL_OK')"`
    // Zero-config (2026-10-03): the verification command and required
    // file are NOT prompted anymore — pass them as flags so the test
    // still asserts exact behaviour. Asserted below: prompting is gone.
    const input = [
      '/tasks',
      `Create ${artifact} containing exactly REPL_OK.`,
      'y',
      '/tasks',
      '/result no-such-id',
      '/events no-such-id',
      '/frobnicate',
      // Every command in the palette runs, and none of them crashes the loop.
      '/status',
      '/doctor',
      '/stats',
      '/debug',
      '/clear',
      '/new',
      '/review',
      '/review nope',
      '/review all',
      '/q',
    ].join('\n') + '\n'

    const child = spawnSync(process.execPath, [...process.execArgv, harnessPath, '--repl', '--test', verify, '--required-file', artifact], {
      encoding: 'utf8',
      input,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      env,
    })

    assert.equal(child.status, 0, child.stderr || child.stdout)
    const out = child.stdout
    assert.match(out, /interactive mode/)
    assert.match(out, /No tasks yet\./, 'an empty store says so in words, not silence')
    assert.match(out, /submitted: harness-/)
    assert.match(out, /task\.completed/)
    assert.match(out, /task completed/)
    assert.match(out, /test PASS/)
    assert.match(out, /acceptance PASS/)
    assert.equal((await readFile(join(directory, 'workspace', artifact), 'utf8')).trim(), 'REPL_OK')

    // /tasks after the run: the shaped table, not the old `id status objective`
    // one-liner. Status and objective are on the SAME row, which is the whole
    // point of the table (the long line used to wrap into three unaligned rows).
    const afterRun = out.slice(out.indexOf('task completed'))
    assert.match(afterRun, /status {5}id {20}objective/, 'the list has a header row')
    assert.match(afterRun, /completed {2}harness-\w{4}[\w-]*…? {2}Create repl-proof/, 'status, id and objective share one row')
    assert.match(afterRun, /1 task \(1 completed\)/, 'and the footer counts what is listed')
    // A long objective must wrap onto an indented continuation, never overflow.
    assert.ok(!/Create repl-proof\.txt containing exactly REPL_OK\.\n\S/.test(afterRun), 'no row overflows past the wrap width')

    assert.match(child.stderr, /Task not found: no-such-id/)
    assert.match(child.stderr, /Unknown command: \/frobnicate/)

    // No emoji-presentation glyph may reach the terminal: Windows Terminal
    // renders U+1F000+, U+26A1, U+23F1/2 and any VS-16 pair as a COLOURED
    // IMAGE, which breaks the violet-on-black rule (operator report,
    // 2026-11-04). The house vocabulary is text-presentation and stays.
    const EMOJI_IMAGE = /[\u{1F000}-\u{1FAFF}\u{26A1}\u{23F1}\u{23F2}\u{FE0F}]/u
    assert.equal(out.match(EMOJI_IMAGE), null, 'the classic output carries no emoji-presentation glyph')
    assert.equal(child.stderr.match(EMOJI_IMAGE), null, 'and neither does stderr')

    // The session/read-only commands added after the palette review. None of
    // them may kill the loop, and every one must print something: a command
    // that answers with silence is the "y does nothing" failure mode again.
    assert.match(out, /Route: (?:local|openrouter)/i, '/status names the live route')
    assert.match(out, /Crew seats:/i, '/debug names every crew seat')
    assert.match(out, /Session usage/i, '/stats reports token usage')
    assert.match(out, /session cleared/i, '/clear clears the session')
    // /review is honest outside git: a temp workspace that is not a repository
    // says so instead of printing an empty diff or crashing.
    assert.match(child.stderr, /is not a git repository/, '/review names why it cannot review')

    // /q leaves with the same contract as /exit.
    assert.equal(child.status, 0, 'the loop ends cleanly after /q')

    // Exactly one supervised Hermes record; nothing ran on the bad commands.
    const hermes = JSON.parse(
      await readFile(join(directory, 'hermes-tasks.json'), 'utf8'),
    ) as { tasks: Array<{ id: string; status: string; supervisor?: string }> }
    assert.equal(hermes.tasks.length, 1)
    assert.equal(hermes.tasks[0].status, 'completed')
    assert.equal(hermes.tasks[0].supervisor, 'terminal-harness')

    function session(input: string, extra?: NodeJS.ProcessEnv) {
      return spawnSync(process.execPath, [harnessPath, '--repl'], {
        encoding: 'utf8', input, timeout: 5 * 60 * 1000, windowsHide: true,
        env: extra ? { ...env, ...extra } : env,
      })
    }

    // A fresh process inspects actual persisted results/events, not just errors.
    // `/result` and `/events` are SHAPED by default now; `--raw` is the escape
    // hatch a pipe needs, so both are asserted — a shaped view that quietly
    // removed the machine-readable form would be its own regression.
    const id = hermes.tasks[0].id
    const inspected = session(`/result ${id}\n/events ${id}\n/result ${id} --raw\n/events ${id} --raw\n/run ${id}\n/help\n/exit\n`)
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout)
    // Shaped detail: the status is its own line, then labelled fields, then the
    // per-test verdicts as marks rather than JSON keys.
    assert.match(inspected.stdout, /objective {4}Create repl-proof/, 'the detail view labels its fields')
    assert.match(inspected.stdout, /verify with {2}node -e/, 'and names the verification command')
    assert.match(inspected.stdout, /✔ .*repl-proof/, 'test verdicts are marks, not JSON')
    assert.match(inspected.stdout, /--raw for the stored record/, 'the raw form is advertised, not hidden')
    assert.match(inspected.stdout, /✔? ?task\.completed|task\.completed/, 'the event trail names its events')
    assert.match(inspected.stdout, /events · newest last/, 'and says what it is showing')
    // Raw is still available and still the stored record.
    assert.match(inspected.stdout, /"supervisor": "terminal-harness"/, '--raw gives the stored record')
    assert.match(inspected.stdout, /"type": "task.completed"/, '--raw gives the stored events')
    // Help opens on the HUD plate, and stays plain text for a pipe.
    assert.match(inspected.stdout, /✦ AVAILABLE COMMANDS/)
    assert.doesNotMatch(inspected.stdout, /\x1b\[/, 'the classic path never emits colour')
    assert.match(inspected.stderr, /Cannot run task in status: completed/)

    // `/display` is a remembered setting, so its store is pointed at the temp
    // dir: a test must never change the developer's own density. Bare answers,
    // a mode is saved, and a word that is not a mode is refused by name.
    const display = session('/display\n/display verbose\n/display loud\n/exit\n', {
      WEDNESDAY_STATE_HOME: join(directory, 'state'),
    })
    assert.equal(display.status, 0, display.stderr || display.stdout)
    assert.match(display.stdout, /display: normal — tool runs fold · short diff/, 'the getter names the mode and what it means')
    assert.match(display.stdout, /display set: verbose — every tool call · full diff/, 'the setter says what the next session will look like')
    assert.match(display.stderr, /Unknown display mode: loud \(quiet, normal, verbose\)/, 'an unknown mode is refused by name')

    // Seed a queued task from the proven record: /run must preview and ask,
    // including when stdin ends before approval. No execution on rejection.
    const stored = JSON.parse(await readFile(env.HERMES_TASKS_PATH, 'utf8'))
    const queued = structuredClone(stored.tasks[0])
    queued.id = queued.engineeringTask.id = 'queued-resume'
    queued.status = 'queued'
    delete queued.result
    stored.tasks.push(queued)
    await writeFile(env.HERMES_TASKS_PATH, JSON.stringify(stored))
    const beforeEvents = await readFile(env.FACTORY_EVENTS_PATH, 'utf8')
    for (const input of ['/run queued-resume\nn\n/exit\n', '/run queued-resume\n']) {
      const rejectedRun = session(input)
      assert.equal(rejectedRun.status, 0, rejectedRun.stderr || rejectedRun.stdout)
      assert.match(rejectedRun.stdout, /Task preview/)
      assert.match(rejectedRun.stdout, /cancelled by operator/)
      assert.equal(JSON.parse(await readFile(env.HERMES_TASKS_PATH, 'utf8')).tasks[1].status, 'queued')
      assert.equal(await readFile(env.FACTORY_EVENTS_PATH, 'utf8'), beforeEvents)
    }
    // The operator's actual loop, end to end through the real binary.
    //
    // Their report was "NVIDIA_API_KEY is not set", then "y does nothing". The
    // shape of that loop: a failed run offers `/run <id> to retry`, the retry
    // asks for approval, `y` runs the identical doomed path, and the card that
    // comes back is byte-identical — so the gate looks frozen.
    //
    // The fix has to hold HERE, in the shipped binary, not only in dispatch-test:
    // `/run` must refuse before it ever builds a preview, and — the part that
    // actually stops the loop — it must not claim the operator cancelled
    // anything. They never got a card to cancel.
    //
    // `NVIDIA_API_KEY: ''` is deliberate and load-bearing: the real profile on
    // this machine now carries an NVIDIA key (that was B88), and `loadConfig`
    // only fills a variable that is `undefined`. An empty string survives the
    // load, so this reproduces "no key for this route" without touching the
    // operator's real credentials and without a single live call.
    {
      const blocked = session(
        '/run queued-resume\ny\n/run queued-resume\nn\n/tasks\n/exit\n',
        { FACTORY_EXECUTION_MODE: 'live', FACTORY_LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: '' },
      )
      assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout)
      // The preview IS the approval gate on the classic path. If it renders, a
      // doomed run was offered for approval.
      assert.doesNotMatch(blocked.stdout, /Task preview/, 'no approval is requested for a route with no key')
      assert.doesNotMatch(blocked.stdout, /cancelled by operator/, 'and it is not reported as a cancel — nothing was ever offered')
      // `ui.error` is stderr on the classic path; the remedy is a `ui.note`, so
      // stdout. Asserted separately because a blocker printed without its remedy
      // is the same dead end with better manners.
      assert.match(blocked.stderr, /blocked before approval: NVIDIA key missing/, 'the blocker names the route that is actually selected')
      assert.match(blocked.stdout, /NVIDIA_API_KEY=/, 'and gives the one action that clears it')
      assert.match(blocked.stdout, /restart the session/, 'including that keys load at startup, so an edit needs a restart')
      // Both `/run` AND the bare `y` are gated — `y` typed at the composer is a
      // new request, not an answer to anything, and it must not slip past either.
      assert.equal(blocked.stderr.match(/blocked before approval/g)?.length, 4, 'all four attempts were blocked, not just the two /run commands')
      // Neither `y` nor `n` may submit: the loop has to break on BOTH answers,
      // because the operator's next move after a failure is always `y`.
      assert.equal(JSON.parse(await readFile(env.HERMES_TASKS_PATH, 'utf8')).tasks[1].status, 'queued', 'the task is still queued — nothing ran')
      assert.equal(await readFile(env.FACTORY_EVENTS_PATH, 'utf8'), beforeEvents, 'and no events were emitted')
    }

    // The same command on a READY route must still work — a gate that refuses
    // everything is the same freeze wearing a different hat.
    const resumed = session('/run queued-resume\ny\n/tasks\n/exit\n')
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout)
    assert.match(resumed.stdout, /task completed/)
    const finalStore = JSON.parse(await readFile(env.HERMES_TASKS_PATH, 'utf8'))
    assert.equal(finalStore.tasks.length, 2, 'resuming must not submit another record')
    assert.equal(finalStore.tasks[1].status, 'completed')

    // ── Every command the frontend advertises, driven end to end ─────────────
    // The palette and the footer advertise /health, /model and inline flags, so
    // an advertised option that does nothing is a bug. They were the only
    // reachable options with no coverage at all.
    {
      const configured = session([
        '/model',
        '/model not a model id',
        '/model provider/some-model',
        '/model',
        '/health',
        '/exit',
      ].join('\n') + '\n')
      assert.equal(configured.status, 0, configured.stderr || configured.stdout)
      // `/model` with no picker (classic) explains how to set one instead of
      // printing nothing, and reflects whatever route is currently configured
      // (the profile may already set one, so the value itself is not asserted).
      assert.match(configured.stdout, /model: .*\(set with \/model provider\/model\)/, '/model with no picker explains itself')
      // Route-aware: a LOCAL route has no provider slash, so its rule says so.
      // The old message demanded "provider/model" on the one route where that
      // shape does not exist, which is what made `/model qwen2.5-coder-3b-instruct`
      // impossible to type on the very route the picker was showing.
      assert.match(configured.stderr, /Enter a model id \(letters, digits, \. _ : -; no spaces\)/, 'a malformed model id is rejected with the route rule')
      assert.match(configured.stdout, /route set: provider\/some-model/, 'a valid id is accepted')
      assert.match(configured.stdout, /model: provider\/some-model/, 'and the next /model reports it')
      // The meter runs on demand: the report, plus the trend once there is
      // history. Both are stream output, not console noise.
      assert.match(configured.stdout, /Event bus/, '/health prints the meter report')
    }

    // Inline flags are per-request and must reach the task, not the prose. The
    // temp workspace has a package.json with NO test script, so the guess is
    // `npm test` and the honest warning has to appear before approval.
    {
      const inline = session([
        `--test "node -e \\"process.exit(0)\\"" add a regression note`,
        'n',
        '--test "node -e \\"process.exit(0)\\""',
        '/exit',
      ].join('\n') + '\n')
      assert.equal(inline.status, 0, inline.stderr || inline.stdout)
      assert.match(inline.stdout, /node -e "process\.exit\(0\)"/, 'the inline --test command arrives intact')
      // `\s+`, not `{2}`: the card's label column is now uniform (B87), where it used
  // to be ragged - `Role ` was five wide and `Required files  ` was sixteen, so
  // nothing lined up. This assertion was pinning that inconsistency.
  assert.match(inline.stdout, /Objective\s+add a regression note/, 'and the objective is only the objective')
      assert.match(inline.stdout, /cancelled by operator/, 'rejecting an inline-flagged task runs nothing')
      assert.match(inline.stderr, /flags alone do not run anything/, 'flags with no objective are refused, not sent as a request')
    }

    // A bare request in a workspace with no test script: the guess is named AND
    // the fact that it cannot work is said out loud, before approval.
    {
      const guessed = session('write a note file\nn\n/tasks\n/exit\n')
      assert.equal(guessed.status, 0, guessed.stderr || guessed.stdout)
      assert.match(guessed.stdout, /npm test/, 'the zero-config guess is named')
      assert.match(guessed.stdout, /no "test" script/, 'and the warning says the guess cannot work')
      assert.match(guessed.stdout, /cancelled by operator/, 'nothing ran')
    }

    console.log('HARNESS REPL TEST: PASS (prompt loop, persisted inspection, approval/EOF guards, queued resume, config-blocked retry refuses without offering approval, every advertised command)')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Terminal harness test — first slice proof.
 * Reject gates execution; approve → supervised run → verified result.
 */

async function main(): Promise<void> {
  // Receipt shaping, asserted without a live run: the ACP envelope must never
  // reach the answer card (operator report, 2026-11-04: a full-screen box of
  // escaped JSON and `data: undefined`), and a blocker must suppress the
  // endpoint guess so one failure never prints two contradictory fixes.
  {
    const { chatFailureLine, chatFailureReceipt, diagnosticLine, failureEvidenceLines, leaveHomeCard, verificationLabel } = await import('./harness')
    // `/new` returns to the start page; the next request must LEAVE it, or the
    // echo and the streamed answer land on a page that never draws messages.
    const homeState = {
      home: true,
      messages: [{ text: '❯ hi', tone: 'plain' }],
      placeholder: '',
      side: null,
    } as unknown as Parameters<typeof leaveHomeCard>[0]
    leaveHomeCard(homeState, 13312)
    assert.equal(homeState.home, false, 'a request leaves the start page')
    assert.equal(homeState.messages.length, 0, 'and starts the transcript clean')
    assert.equal(homeState.side?.title, 'session', 'the session ledger takes the right edge')
    // The provider envelope never reaches the chat failure card: status and
    // message survive, the user id and braces do not.
    const failure = chatFailureLine('openrouter chat request failed: 400 — {"error":{"message":"openrouter/nvidia/x is not a valid model ID","code":400},"user_id":"user_3ID7F9f3Nye8h"}')
    assert.match(failure, /^openrouter chat request failed: 400 — openrouter\/nvidia\/x is not a valid model ID$/)
    assert.ok(!failure.includes('user_id') && !failure.includes('{'), 'no envelope fields on screen')
    assert.equal(chatFailureLine('plain network error'), 'plain network error')
    // The approval card names the verification's INTENT, never the generated
    // shell (a 1,000-char `node -e` script read as a fault, not a plan).
    assert.equal(verificationLabel([]), '(none — the run is not verified)')
    assert.equal(verificationLabel(['npm test']), 'npm test')
    assert.equal(
      verificationLabel([`node -e "const fs=require('fs');process.exit(fs.readdirSync('.').length===0?1:0)"`]),
      'workspace is not empty (auto)',
      'the non-empty probe is summarised',
    )
    assert.match(
      verificationLabel([`node -e "const fs=require('fs');if(!/<!doctype/i.test(fs.readFileSync('index.html','utf8')))process.exit(1)"`]),
      /^index\.html exists and is valid HTML/,
      'the page contract is summarised',
    )
    assert.ok(verificationLabel(['x'.repeat(300)]).length <= 56, 'an unknown command is clipped, not wrapped')
    assert.match(verificationLabel(['npm test', 'npm run lint']), /^2 checks · npm test · npm run lint$/)
    const envelope = JSON.stringify({
      stopReason: 'error',
      output: [],
      diagnostic: JSON.stringify({
        code: -32603,
        message: 'Internal error: turn failed: llm-pi-ai: no credential for provider route "local"; its profile resolves LOCAL_LLM_API_KEY, which is not set',
      }),
    })
    const line = diagnosticLine(envelope)
    assert.match(line!, /^no credential for provider route/, 'the envelope unwraps to its message')
    assert.ok(!/[{}]/.test(line!) && !line!.includes('stopReason'), 'no JSON reaches the card')
    assert.equal(diagnosticLine('plain text failure'), 'plain text failure', 'plain diagnostics pass through')
    assert.equal(diagnosticLine(undefined), null, 'nothing to say, no row')
    assert.ok(diagnosticLine('x'.repeat(400))!.length <= 120, 'a long diagnostic still fits one row')
    const blocked = failureEvidenceLines({ diagnostics: 'no credential for provider route local' }, undefined, 0, true)
    assert.ok(!blocked.some(row => row.text.startsWith('fix:')), 'a blocker supplies its own remedy')
    // A provider 404 is the operator's own build failure (2026-11-04:
    // "NVIDIA request failed: 404 — 404 page not found"). The card used to
    // carry the raw HTTP line and no next step; the fix is one command the
    // operator already knows.
    const notFound = failureEvidenceLines({ diagnostics: 'architect failed: NVIDIA request failed: 404 — 404 page not found' }, undefined, 0)
    const fix = notFound.find(row => row.text.startsWith('fix:'))
    assert.ok(fix, 'a 404 failure carries a fix line')
    assert.match(fix!.text, /\/model/, 'the fix names the command that repairs it')
    assert.match(fix!.text, /404/, 'and it says what the provider answered')
    // One dead endpoint is one fact. The first failure is a card (cause, what
    // did not happen, the one next action); the SAME failure again is ONE
    // counted line — three identical `Chat failed` cards in a row read as the
    // app breaking (operator report, 2026-11-04).
    const first = chatFailureReceipt('fetch failed', 'Ask for the build as a task.')
    assert.equal(first.repeat, false, 'the first failure is a card')
    assert.equal(first.count, 1)
    assert.equal(first.lines.length, 3, 'cause, what did not happen, and the next action')
    assert.match(first.text, /^Chat failed: fetch failed$/)
    const again = chatFailureReceipt('fetch failed', 'Ask for the build as a task.', { reason: 'fetch failed', count: 1 })
    assert.equal(again.repeat, true, 'the same failure again collapses')
    assert.equal(again.count, 2)
    assert.match(again.text, /same failure again \(×2\) — fetch failed/)
    assert.equal(again.lines.length, 1, 'a repeat is one line, not another card')
    const third = chatFailureReceipt('fetch failed', 'Ask for the build as a task.', { reason: 'fetch failed', count: 2 })
    assert.equal(third.count, 3)
    assert.match(third.text, /×3/, 'the count keeps climbing')
    const other = chatFailureReceipt('a different failure', 'Ask for the build as a task.', { reason: 'fetch failed', count: 2 })
    assert.equal(other.repeat, false, 'a DIFFERENT failure is a new card, not a repeat')
    assert.equal(other.count, 1, 'and the count starts over')

    // `/new` then a message must leave the splash (B171). The home page never
    // paints `state.messages`, so a turn that starts on the splash is
    // invisible — the operator typed `hi` and saw nothing happen ("it still
    // lags in home screen", 2026-11-04). Pinned at the FRAME level: the splash
    // shows no request, and after the transition the request IS on screen.
    {
      const { Screen, initialState } = await import('./screen')
      const out = {
        columns: 100, rows: 30, isTTY: true,
        write: (chunk: string) => true,
      } as unknown as NodeJS.WriteStream
      const scr = new Screen(out, 100, 30)
      const live = initialState('WEDNESDAY', 'live')
      live.home = true
      scr.enter()
      scr.render(live)
      live.messages.push({ text: '❯ hi', tone: 'bold' })
      scr.render(live)
      assert.ok(
        !scr.painted().join('\n').includes('❯ hi'),
        'a message pushed on the splash is invisible — that was the freeze',
      )
      leaveHomeCard(live, 13312)
      live.messages.push({ text: '❯ hi', tone: 'bold' })
      scr.render(live)
      const stream = scr.painted().join('\n')
      assert.ok(stream.includes('❯ hi'), 'after the transition the request is on screen')
      assert.ok(!stream.includes('Welcome to Wednesday!'), 'and the splash is gone')
    }
    // The WIRING is what actually broke: `/new` set the page without setting
    // the input loop's `onHome` flag, so the transition never ran and the
    // answer went to a page that was not on screen. Both halves are pinned:
    // the flag follows the page, and the request path leaves the page.
    {
      const source = await readFile(new URL('./harness.ts', import.meta.url), 'utf8')
      assert.match(source, /if \(onHome \|\| state\.home\) leaveHome\(\)/, 'the request path leaves the splash')
      assert.match(source, /onHome = fresh/, 'clearSession keeps the page and the flag in sync')
    }

    // A seat that FAILED still reports `agent.completed` — the orchestrator
    // has no `agent.failed` event. The row used to say `done` in green over a
    // seat that produced nothing, which is what made the operator ask whether
    // the whole run was invented (operator, 2026-11-04).
    {
      const { eventDetail } = await import('./harness')
      assert.deepEqual(
        eventDetail('agent.completed', { status: 'failed' }),
        { note: 'FAIL', status: 'failed' },
        'a failed seat is reported as failed',
      )
      assert.deepEqual(
        eventDetail('agent.completed', { status: 'aborted' }),
        { note: 'ABORT', status: 'aborted' },
        'an aborted seat is reported as aborted',
      )
      assert.equal(
        eventDetail('agent.completed', undefined),
        undefined,
        'a seat with no verdict reports nothing — the bus is authoritative',
      )
      assert.equal(
        eventDetail('agent.completed', { status: 'completed' }),
        undefined,
        'a healthy seat keeps the plain done row',
      )
    }

    // Live activity: the seat's reasoning, talk, commands and file writes,
    // parsed off the bus. The kind is checked against the known vocabulary,
    // so a malformed event cannot invent a row shape the renderer does not
    // know — and an unknown kind degrades to reasoning rather than throwing.
    {
      const { eventDetail } = await import('./harness')
      assert.deepEqual(
        eventDetail('agent.activity', { kind: 'reasoning', text: 'checking the repo' }),
        { activity: { kind: 'reasoning', text: 'checking the repo', tool: undefined, detail: undefined, status: undefined } },
        'a reasoning piece is carried as-is',
      )
      assert.deepEqual(
        eventDetail('agent.activity', { kind: 'tool', tool: 'bash', detail: 'npm test', status: 'completed' }),
        { activity: { kind: 'tool', text: undefined, tool: 'bash', detail: 'npm test', status: 'completed' } },
        'a tool call names the tool and what it touched',
      )
      assert.deepEqual(
        eventDetail('agent.activity', { kind: 'file', detail: 'src/index.ts', status: 'created' }),
        { activity: { kind: 'file', text: undefined, tool: undefined, detail: 'src/index.ts', status: 'created' } },
        'a file write names the path',
      )
      assert.equal(
        eventDetail('agent.activity', { kind: 'nonsense', text: 'x' })?.activity?.kind,
        'reasoning',
        'an unknown kind degrades to reasoning instead of throwing',
      )
      assert.equal(
        eventDetail('agent.activity', {})?.activity?.kind,
        'reasoning',
        'an activity event with no kind still renders a row',
      )
    }

    // The banner and the meter must name the SAME model. They used to read
    // different sources — the banner the env profile, the meter the stored
    // crew — so the home page said `crew: qwen2.5-coder-3b-instruct` while
    // the meter said `gemma-3-4b-it` (operator, 2026-11-04). One resolution,
    // and the ACTIVE crew wins over the env profile.
    {
      const { crewSeatModels, crewMeterLabel } = await import('./harness')
      const envBefore = {
        planner: process.env.FACTORY_CREW_PLANNER_MODEL,
        coder: process.env.FACTORY_CREW_CODER_MODEL,
        vision: process.env.FACTORY_CREW_VISION_MODEL,
      }
      try {
        process.env.FACTORY_CREW_PLANNER_MODEL = 'qwen2.5-coder-3b-instruct'
        process.env.FACTORY_CREW_CODER_MODEL = 'qwen2.5-coder-3b-instruct'
        process.env.FACTORY_CREW_VISION_MODEL = 'qwen2.5-coder-3b-instruct'
        const crew = {
          id: 'crew-1',
          name: 'junun',
          seats: [
            { role: 'planner', model: 'nvidia/google/gemma-3-4b-it' },
            { role: 'coder', model: 'nvidia/google/gemma-3-4b-it' },
            { role: 'vision', model: 'nvidia/google/gemma-3-4b-it' },
          ],
        }
        const seats = crewSeatModels(crew)
        assert.equal(seats[0]!.model, 'nvidia/google/gemma-3-4b-it', 'the active crew fills the planner seat')
        assert.equal(seats[1]!.model, 'nvidia/google/gemma-3-4b-it', 'the active crew fills the coder seat')
        assert.equal(crewMeterLabel(crew), 'gemma-3-4b-it', 'the meter names the crew model, not the env profile')
        // No crew: the env profile answers, and the meter says the same thing.
        const envSeats = crewSeatModels(null)
        assert.equal(envSeats[0]!.model, 'qwen2.5-coder-3b-instruct', 'without a crew the env profile fills the seat')
        assert.equal(crewMeterLabel(null), 'qwen2.5-coder-3b-instruct', 'and the meter names it')
      } finally {
        for (const [key, value] of Object.entries({
          FACTORY_CREW_PLANNER_MODEL: envBefore.planner,
          FACTORY_CREW_CODER_MODEL: envBefore.coder,
          FACTORY_CREW_VISION_MODEL: envBefore.vision,
        })) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }

    // The approval preview: what will run, what will prove it, where the
    // model comes from, and the seats doing the work. The screen dialog
    // drops fields FROM THE END when the terminal is small, so the field
    // order is part of the contract; and the route must follow the same
    // rules the worker and router follow (a bare hosted pick stays with the
    // route, a bare seat id with a local endpoint goes local).
    {
      const { buildRunPreview, estimateRunTime, filesLabel, previewFacts, routeLabel, runPreviewLines } = await import('./harness')
      const baseTask = {
        id: 'preview-1',
        objective: 'fix the login leak',
        workspace: 'C:\\src\\legacy',
        role: 'coder',
        stack: 'typescript, node',
        constraints: [],
        acceptanceCriteria: [],
        acceptance: { requiredFiles: ['src/auth.ts', 'src/session.ts', 'test/auth.test.ts', 'src/middleware.ts', 'src/guard.ts'] },
        verification: { testCommands: ['npm test'] },
      } as unknown as Parameters<typeof previewFacts>[0]
      const clean = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
        FACTORY_LLM_PROVIDER: 'openrouter',
        DSH_LLM_MODEL: 'nvidia/nemotron-3.5-lightning:free',
        LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
        FACTORY_CREW_PLANNER_MODEL: '',
        FACTORY_CREW_CODER_MODEL: '',
        FACTORY_CREW_VISION_MODEL: '',
        FACTORY_CREW_PLANNER_BASE_URL: '',
        FACTORY_CREW_CODER_BASE_URL: '',
        FACTORY_CREW_VISION_BASE_URL: '',
        ...over,
      } as unknown as NodeJS.ProcessEnv)
      // Hosted route wins even though the local endpoint is still set (the
      // profile keeps it for the tool proxy) — the 2026-11-05 class of
      // failure, now pinned at the preview boundary.
      assert.equal(routeLabel('coder', clean({})), 'openrouter · nvidia/nemotron-3.5-lightning:free')
      // Explicit local route shows the endpoint it will actually hit.
      assert.equal(
        routeLabel('coder', clean({ FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_MODEL: 'qwen2.5-coder-3b-instruct' })),
        'local · qwen2.5-coder-3b-instruct @ http://127.0.0.1:18090/v1',
      )
      // A bare seat id with its own local endpoint pins to local even when
      // the selected route is hosted — the preview must SAY so, not
      // silently claim the hosted route.
      assert.equal(
        routeLabel('coder', clean({ FACTORY_CREW_CODER_MODEL: 'qwen2.5-coder-3b-instruct', FACTORY_CREW_CODER_BASE_URL: 'http://127.0.0.1:18090/v1' })),
        'local · qwen2.5-coder-3b-instruct @ http://127.0.0.1:18090/v1 (crew coder pin)',
      )
      // A provider-prefixed seat pin beats the route, exactly as the
      // executor's per-call pin does.
      assert.equal(
        routeLabel('coder', clean({ FACTORY_LLM_PROVIDER: 'local', FACTORY_CREW_CODER_MODEL: 'nvidia/nemotron-3.5-lightning:free' })),
        'nvidia · nemotron-3.5-lightning:free (crew coder pin)',
      )
      // Null workspace/files still shape the card without throwing.
      const noFiles = { ...baseTask, acceptance: { requiredFiles: [] }, verification: undefined, id: 'preview-2' } as unknown as typeof baseTask
      const bare = previewFacts(noFiles, clean({}), null)
      assert.match(filesLabel(noFiles), /^\(none — the run chooses\)$/)
      assert.equal(bare.verify, '(none — the run is not verified)')
      assert.equal(bare.time, 'unknown — this run has no verification')
      // 5 files: first four shown, then the count of the rest.
      assert.equal(filesLabel(baseTask), 'src/auth.ts, src/session.ts, test/auth.test.ts, src/middleware.ts … +1 more')
      // The seven lines, in the ORDER the screen dialog drops from the end.
      const facts = previewFacts(baseTask, clean({}), null)
      assert.deepEqual(
        runPreviewLines(facts).map(line => line.replace(/: .*/, '')),
        ['Task', 'Verify', 'Route', 'Seats', 'Files', 'Where', 'Time'],
        'the screen dialog drops fields from the end, so the order is the contract',
      )
      // The estimate: unverified runs cannot be priced; verified ones scale
      // with the difficulty band and the number of checks.
      assert.equal(estimateRunTime({ level: 'low', maxAgents: 5 }, 0), 'unknown — this run has no verification')
      assert.equal(estimateRunTime({ level: 'low', maxAgents: 5 }, 1), '~2–5 min (est.)')
      assert.equal(estimateRunTime(null, 1), 'unknown — difficulty could not be scored')
      // buildRunPreview returns the whole package (lines in order) and never
      // blocks when the difficulty score cannot run.
      const preview = await buildRunPreview(baseTask, clean({}), null)
      assert.deepEqual(
        preview.lines.map(line => line.replace(/: .*/, '')),
        ['Task', 'Verify', 'Route', 'Seats', 'Files', 'Where', 'Time'],
        'the shared builder emits the same order',
      )
      assert.match(preview.lines[1]!, /^Verify:/)
      assert.match(preview.lines.find(l => l.startsWith('Time: ')) ?? '', /min|unknown/)
    }
  }

  const directory = await mkdtemp(join(tmpdir(), 'harness-'))
  try {
    await mkdir(join(directory, 'workspace', 'src'), { recursive: true })
    await writeFile(join(directory, 'workspace', 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await writeFile(join(directory, 'workspace', 'src', 'index.ts'), 'export const x = 1\n')

    const artifact = 'harness-proof.txt'
    const artifactPath = join(directory, 'workspace', artifact)
    const harnessPath = fileURLToPath(new URL('../../bin/wednesday.js', import.meta.url))

    const env = {
      ...process.env,
      HARNESS_WORKSPACE: join(directory, 'workspace'),
      HERMES_TASKS_PATH: join(directory, 'hermes-tasks.json'),
      FACTORY_EVENTS_PATH: join(directory, 'events.jsonl'),
      FACTORY_EXECUTION_MODE: 'deterministic',
    }

    const verifyCommand = `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('${artifact}', 'utf8').trim(), 'HARNESS_OK')"`
    function runHarness(input: string, command = verifyCommand) {
      return spawnSync(process.execPath, [harnessPath,
        `Create ${artifact} containing exactly HARNESS_OK.`,
        '--test', command,
        '--required-file', artifact,
      ], {
        encoding: 'utf8',
        input,
        timeout: 5 * 60 * 1000,
        windowsHide: true,
        env,
      })
    }

    const rejected = runHarness('n\n')
    assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout)
    assert.match(rejected.stdout, /Task preview/)
    assert.match(rejected.stdout, /Repository context:/)
    assert.match(rejected.stdout, /cancelled by operator\./)
    assert.equal(await exists(artifactPath), false, 'artifact must not exist after rejection')
    const hermesAfterReject = JSON.parse(
      await readFile(join(directory, 'hermes-tasks.json'), 'utf8').catch(() => '{"tasks":[]}'),
    ) as { tasks: unknown[] }
    assert.equal(hermesAfterReject.tasks.length, 0, 'no Hermes record on rejection')

    const approved = runHarness('y\n')
    assert.equal(approved.status, 0, approved.stderr || approved.stdout)
    // The classic/piped path still prints the startup advisories inline and in
    // order: they were moved off the critical path for the SCREEN path only, and
    // a script that greps stdout must not lose the line.
    assert.match(approved.stdout, /startup health: (OK|WARN|DOWN)/, 'the classic path still prints the startup health line')
    assert.match(approved.stdout, /submitted: harness-/)
    assert.match(approved.stdout, /task\.created/)
    assert.match(approved.stdout, /task\.completed/)
    // Result card headline carries the decode-key mark + counts, every run.
    assert.match(approved.stdout, /task completed/)
    assert.match(approved.stdout, /test PASS/)
    assert.match(approved.stdout, /acceptance PASS/)
    assert.equal((await readFile(artifactPath, 'utf8')).trim(), 'HARNESS_OK')

    const hermes = JSON.parse(
      await readFile(join(directory, 'hermes-tasks.json'), 'utf8'),
    ) as { tasks: Array<{ id: string; status: string; supervisor?: string }> }
    assert.equal(hermes.tasks.length, 1)
    assert.equal(hermes.tasks[0].status, 'completed')
    assert.equal(hermes.tasks[0].supervisor, 'terminal-harness')

    const eventTypes = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim().split('\n')
      .map(line => (JSON.parse(line) as { type: string }).type)
    assert.ok(eventTypes.includes('verification.completed'), eventTypes.join(', '))
    assert.ok(eventTypes.includes('task.completed'))

    const failed = runHarness('y\n', 'node -e "process.exit(1)"')
    assert.equal(failed.status, 1, failed.stderr || failed.stdout)
    assert.match(failed.stdout, /task failed/)
    // V1.6 lever: coder failure drives the repair loop (repair.started +
    // retry) and ends task.failed — terminal task.blocked is gone.
    assert.match(failed.stdout, /repair\.started/)
    assert.match(failed.stdout, /task\.failed/)
    const afterFailure = JSON.parse(await readFile(env.HERMES_TASKS_PATH, 'utf8'))
    assert.equal(afterFailure.tasks.length, 2)
    assert.equal(afterFailure.tasks[1].status, 'failed')

    console.log('TERMINAL HARNESS TEST: PASS (approval gate, exact artifact, persisted result/events, failure exit)')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path, 'utf8').then(() => true, () => false)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

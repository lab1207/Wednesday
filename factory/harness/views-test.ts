/**
 * The shaped views (`/tasks`, `/result`, `/events`).
 *
 * Reported as "when you run command /task then so big long response" and
 * "pgup and pgdown its so long and unstructured". These renderers are the fix,
 * so they are asserted directly: column alignment, wrap behaviour, tone per
 * status, and the rule that nothing may overflow the width it was given.
 *
 *   npx tsx factory/harness/views-test.ts
 */
import assert from 'node:assert/strict'

import { eventTrailLines, shortId, statusTone, streamLine, taskDetailLines, taskListLines, wrapText, type TaskRow } from './views.js'

const TASKS: TaskRow[] = [
  {
    id: 'harness-aaaa1111-2222-3333-4444-555566667777',
    status: 'completed',
    objective: 'fix the login leak on the token refresh path so an expired session stops refreshing forever',
    summary: 'Added an expiry guard.',
  },
  { id: 'harness-bbbb1111', status: 'failed', objective: 'add a regression test for the credit card parser', testsFailed: 1 },
  { id: 'harness-cccc1111', status: 'queued', objective: 'document the har seam' },
]

function plain(rows: Array<{ text: string }>): string[] {
  return rows.map(r => r.text)
}

function main(): void {
  // ── wrapText: the primitive everything else depends on ───────────────────
  assert.deepEqual(wrapText('a b c', 10), ['a b c'], 'short text is one row')
  assert.deepEqual(wrapText('aaa bbb ccc', 7), ['aaa bbb', 'ccc'], 'words wrap at the width')
  assert.deepEqual(wrapText('', 10), [''], 'empty text is one empty row, not zero rows')
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b'], 'newlines are respected')
  // A single unbreakable token (a path, an id) must be hard-split: overflowing
  // the frame is what the audit calls a width violation.
  const split = wrapText('C:/very/long/path/that/never/breaks/anywhere', 20)
  assert.ok(split.every(row => row.length <= 20), `hard-split rows: ${JSON.stringify(split)}`)
  assert.equal(split.join(''), 'C:/very/long/path/that/never/breaks/anywhere', 'and nothing is lost')

  // ── statusTone: the brand rule (blood only for failure) ─────────────────
  assert.equal(statusTone('completed'), 'green')
  assert.equal(statusTone('failed'), 'red')
  assert.equal(statusTone('queued'), 'yellow')
  assert.equal(statusTone('something-new'), 'dim', 'an unknown status is neutral, never a false alarm')

  // ── shortId: keeps identity, drops noise ────────────────────────────────
  assert.equal(shortId('short-id', 20), 'short-id', 'a short id is untouched')
  const shortened = shortId('harness-aaaa1111-2222-3333-4444-555566667777', 20)
  assert.equal(shortened.length, 20, 'a long id is cut to the budget')
  assert.ok(shortened.endsWith('…'), 'and says it was cut')
  assert.ok('harness-aaaa1111-2222-3333-4444-555566667777'.startsWith(shortened.slice(0, -1)), 'the visible part is a real prefix')

  // ── taskListLines: a table, not a wall ───────────────────────────────────
  {
    const rows = taskListLines(TASKS, 100)
    const text = plain(rows)
    assert.match(text[0]!, /status\s+id\s+objective/, 'there is a header row')
    // Status and objective share a row: the old one-liner-per-task is gone.
    const completed = rows.find(r => r.text.includes('fix the login leak'))!
    assert.match(completed.text, /^completed\s+harness-/, 'status, id and objective are on ONE row')
    assert.equal(completed.tone, 'green', 'and the row carries the status tone')
    assert.match(text.at(-1)!, /3 tasks \(1 completed · 1 failed · 1 queued\)/, 'the footer counts every status')
    assert.match(text.at(-1)!, /\/result <id>/, 'and points at the next command')
    // Newest first: the operator cares about the run they just started.
    assert.ok(text.findIndex(t => t.includes('har seam')) < text.findIndex(t => t.includes('login leak')), 'newest task is first')
    // The summary rides under its task, dimmed.
    const summary = rows.find(r => r.text.includes('expiry guard'))!
    assert.equal(summary.tone, 'dim', 'a summary line is dimmed')
    // NOTHING may exceed the width.
    for (const width of [40, 60, 80, 100, 132]) {
      for (const row of plain(taskListLines(TASKS, width))) {
        assert.ok(row.length <= width, `width ${width}: row of ${row.length} — ${row}`)
      }
    }
  }

  // 1. An empty store says so in words rather than printing nothing.
  assert.match(plain(taskListLines([], 80))[0]!, /No tasks yet/, 'an empty list still says something')

  // 2. A very long objective wraps onto indented continuations instead of one
  //    unreadable line.
  {
    const long = taskListLines([{ id: 'x', status: 'queued', objective: 'word '.repeat(60).trim() }], 60)
    const wrapped = long.filter(r => r.text.trim().startsWith('word'))
    assert.ok(wrapped.length > 1, 'a long objective occupies several rows')
    const indent = wrapped[0]!.text.length - wrapped[0]!.text.trimStart().length
    assert.ok(wrapped.slice(1).every(r => r.text.slice(0, indent).trim() === ''), 'continuations are indented to the column')
  }

  // ── taskDetailLines: four facts and a way onward, not 40 lines of JSON ───
  {
    const detail = taskDetailLines({
      id: 'harness-aaaa',
      status: 'completed',
      engineeringTask: {
        objective: 'fix the login leak',
        workspace: 'C:\\wednesday',
        role: 'backend',
        stack: 'TypeScript',
        verification: { testCommands: ['npm test'] },
        acceptance: { requiredFiles: ['server/auth.js'] },
      },
      result: {
        summary: 'Added an expiry guard.',
        filesChanged: ['server/auth.js', 'test/auth.test.js'],
        tests: [{ command: 'npm test', passed: true }],
        acceptanceChecks: [{ criterion: 'auth.js exists', passed: true }],
      },
    }, 80)
    const text = plain(detail)
    assert.equal(text[0], 'completed', 'the status is the first line, on its own')
    assert.match(text.join('\n'), /objective\s+fix the login leak/, 'the objective is labelled')
    assert.match(text.join('\n'), /must touch\s+server\/auth\.js/, 'required files are called out')
    assert.match(text.join('\n'), /verify with\s+npm test/, 'the verification command is named')
    assert.match(text.join('\n'), /✔ npm test/, 'test verdicts are marks')
    assert.match(text.join('\n'), /files\s+server\/auth\.js, test\/auth\.test\.js/, 'changed files are listed')
    assert.match(text.at(-1)!, /--raw/, 'the raw record is advertised')
    for (const width of [40, 60, 100]) {
      for (const row of plain(taskDetailLines({
        id: 'harness-aaaa', status: 'failed',
        engineeringTask: { objective: 'a '.repeat(80).trim(), workspace: 'C:\\wednesday' },
        result: { summary: 'b '.repeat(80).trim() },
      }, width))) {
        assert.ok(row.length <= width, `width ${width}: row of ${row.length} — ${row}`)
      }
    }
  }

  // A failed task points at /run, not at "run again".
  {
    const failed = plain(taskDetailLines({
      id: 'x', status: 'failed',
      engineeringTask: { objective: 'o', workspace: 'w' },
    }, 80))
    assert.match(failed.at(-2)!, /\/run <id> to preview and approve/, 'a failure offers approval, not a rerun')
  }

  // ── eventTrailLines: "what happened", one line per event ─────────────────
  {
    const trail = eventTrailLines([
      { type: 'task.created', payload: { objective: 'fix the login leak' } },
      { type: 'agent.started', role: 'coder' },
      { type: 'test.completed', payload: { command: 'npm test', passed: true } },
      { type: 'task.completed' },
    ], 80)
    const text = plain(trail)
    assert.equal(text.length, 5, 'one row per event plus a footer')
    assert.match(text[0]!, /task\.created/, 'events are named')
    assert.match(text[2]!, /✔ test\.completed/, 'a pass is marked')
    assert.match(text[2]!, /npm test/, 'with the command that ran')
    assert.match(text[3]!, /✔ task\.completed/, 'completion is marked')
    assert.match(text.at(-1)!, /4 events · newest last/, 'the footer counts them')
    for (const row of text) assert.ok(row.length <= 80, `row of ${row.length}: ${row}`)
  }
  {
    // A FAILED test is a red cross even though the event is named
    // "…completed". Marking from the event name alone is how a red run gets a
    // green tick in the trail.
    const failed = eventTrailLines([
      { type: 'test.completed', payload: { command: 'npm test', passed: false } },
    ], 80)
    assert.match(plain(failed)[0]!, /✘ test\.completed/, 'a failed test is crossed, not ticked')
    assert.equal(failed[0]!.tone, 'red', 'and toned as a failure')
    const redOne = eventTrailLines([{ type: 'task.failed' }], 80)
    assert.match(plain(redOne)[0]!, /✘ task\.failed/, 'a failed task is crossed')
    assert.equal(redOne[0]!.tone, 'red')
  }
  assert.match(plain(eventTrailLines([], 80))[0]!, /No events recorded/, 'an empty trail says so')
  {
    // An unknown event type is PRINTED, not dropped: hiding a type is how a bug
    // becomes invisible.
    const unknown = plain(eventTrailLines([{ type: 'weird.new.event' }], 80))
    assert.match(unknown[0]!, /weird\.new\.event/, 'an unknown event still shows')
  }

  // ── streamLine: an upstream's HTML page never owns the stream ────────────
  {
    // The reported screen: a free model's 502 answered with Cloudflare's
    // document, the error carried the whole body, and the stream filled with
    // markup over the one line that said what failed.
    const cloudflare = [
      '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head>',
      '<body>',
      '<p class="text-13">Ray ID: 8f2a1c</p>',
      '<p>Connection timed out</p>',
      '</body></html>',
    ].join('\n')
    const line = streamLine(cloudflare)
    assert.ok(!line.includes('\n'), 'an HTML body collapses to one line')
    assert.ok(!line.includes('<'), `no markup survives: ${line}`)
    assert.match(line, /an HTML page, not a model reply/, 'it says what the thing is')
    assert.match(line, /502 Bad Gateway/, 'it keeps the page title — the one useful fact')
    assert.match(line, /\/result/, 'and points at the raw text')
  }
  {
    // Plain multi-line text is NOT collapsed: a diagnostic with structure is
    // structure, not markup.
    const multi = streamLine('first issue\nsecond issue')
    assert.equal(multi, 'first issue\nsecond issue', 'a multi-line diagnostic keeps its rows')
  }
  {
    // A runaway single line is clipped so it cannot own the frame.
    const long = streamLine(`boom ${'x'.repeat(5000)}`)
    assert.ok(long.length <= 400, `clipped to the budget (got ${long.length})`)
    assert.ok(long.endsWith('…'), 'and says it was cut')
  }
  assert.equal(streamLine('  normal line  '), 'normal line', 'ordinary text is only trimmed')

  console.log('VIEWS TEST: PASS (wrap, status tone, id shortening, task table, task detail, event trail, stream line, width discipline)')
}

main()

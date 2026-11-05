/**
 * The CLASSIC output path — `tui.ts` — had no suite of its own.
 *
 * It is the path a piped run, a CI log and `wednesday --classic` all use, and it
 * is a completely separate renderer from the screen: stateless line-at-a-time
 * formatting, no cursor addressing, no diffing. Everything the screen path
 * learned this session — display columns (B83), wrapping (B84), a filled
 * surface (B85) — it learned alone, and the classic path got none of it.
 *
 * The concrete result: `taskCard` built every line by string concatenation and
 * measured nothing, so an 88-column workspace path became three terminal rows
 * whose continuation lines started at **column 0**. 4 of 13 rows overflowed an
 * 80-column terminal, the widest by 200 columns.
 *
 *   npx tsx factory/harness/tui-test.ts
 */
import assert from 'node:assert/strict'

import { taskCard, banner, rule, formatEvent, stageHeader } from './tui.js'
import { visibleWidth } from './screen.js'
import type { EngineeringTask } from '../contracts'

const LONG = 'Investigate the flaky integration test in the payments service, identify the race condition between the retry scheduler and the idempotency store, and fix it without changing the public API'

function task(over: Partial<EngineeringTask> = {}): EngineeringTask {
  return {
    objective: LONG,
    workspace: 'C:\\Users\\someone\\source\\repos\\payments-service\\packages\\core\\src\\integrations',
    role: 'coder',
    stack: 'typescript, node, postgres',
    constraints: [
      'Do not change the public API surface',
      'Keep the existing retry backoff semantics exactly as they are today',
    ],
    acceptanceCriteria: ['the race no longer reproduces under --repeat 50', 'the existing suite stays green'],
    acceptance: { requiredFiles: ['src/scheduler/retry.ts', 'src/store/idempotency.ts', 'test/retry-race.test.ts'] },
    verification: { testCommands: ['npm test', 'npm run test:race -- --repeat 50'] },
    ...over,
  } as EngineeringTask
}

/** Every row of the card, at one width. */
function rows(width: number, over: Partial<EngineeringTask> = {}): string[] {
  return taskCard(task(over), width).split('\n')
}

const widths = [40, 60, 80, 100, 120, 200]

// ── 1. Nothing is ever wider than the terminal ──────────────────────────────
// The bug: a terminal wraps an over-wide line, and the continuation starts at
// column 0, so the label column is destroyed.
for (const w of widths) {
  const over = rows(w).filter(r => visibleWidth(r) > w)
  assert.equal(over.length, 0, `at ${w} columns, ${over.length} row(s) overflow (widest ${Math.max(0, ...over.map(visibleWidth))})`)
}

// ── 2. A pathological value still fits ───────────────────────────────────────
{
  const nasty = rows(40, {
    objective: 'x'.repeat(5000),
    workspace: 'C:\\' + 'very\\'.repeat(400) + 'deep',
    acceptanceCriteria: ['y'.repeat(3000)],
    acceptance: { requiredFiles: Array.from({ length: 60 }, (_, i) => `src/module-${i}/index.ts`) },
  })
  assert.ok(nasty.every(r => visibleWidth(r) <= 40), 'a 5000-character objective still fits a 40-column card')
  assert.ok(nasty.length > 40, 'and it wrapped rather than being cut away')
  assert.ok(nasty.join('').includes('xxxx'), 'the content survives')
}

// ── 3. Wrapped values line up under the first one ───────────────────────────
// A hanging indent is the entire point of a card: the label column is what makes
// it scannable, and it only survives if every continuation row starts at the
// same column as the value above it.
{
  const card = rows(80)
  const valueColumn = (row: string): number => {
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '')
    return plain.search(/\S/)
  }
  // Group rows by their label and check each continuation shares the value column.
  const groups = new Map<string, number[]>()
  for (const row of card) {
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '')
    if (!plain.trim() || /^ {2}[·$]/.test(plain)) continue // section labels and bullets
    const label = plain.trim().split(/\s{2,}/)[0] ?? ''
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(valueColumn(row))
  }
  const ragged = [...groups.entries()].filter(([, cols]) => new Set(cols).size > 1)
  assert.equal(
    ragged.length, 0,
    `every label's wrapped rows share one value column; ragged: ${ragged.map(([l, c]) => `${l}=${[...new Set(c)].join('/')}`).join(', ')}`,
  )
}

// ── 4. Every label has a gutter before its value ────────────────────────────
// The measured-column version of a bug that printed `Required filessrc/...`.
{
  const card = rows(80).map(r => r.replace(/\x1b\[[0-9;]*m/g, ''))
  for (const row of card) {
    if (!row.trim() || /^ {2}[·$]/.test(row) || /^[A-Z]/.test(row)) continue
    assert.ok(/^ {2,}\S/.test(row), `no row glues a label to its value: ${JSON.stringify(row.slice(0, 40))}`)
  }
  const required = card.find(r => r.trimStart().startsWith('Required files'))
  assert.ok(required, 'the required-files row is present')
  assert.match(required!, /^Required files\s+\S/, 'and it has a gutter after the longest label')
}

// ── 5. The short, common case is untouched in substance ─────────────────────
{
  const card = rows(80, {
    objective: 'fix the login leak',
    workspace: 'C:\\wednesday',
    constraints: ['add a test'],
    acceptanceCriteria: ['login works'],
  }).map(r => r.replace(/\x1b\[[0-9;]*m/g, ''))
  assert.match(card.join('\n'), /fix the login leak/, 'the objective survives')
  assert.match(card.join('\n'), /C:\\wednesday/, 'the workspace survives')
  assert.match(card.join('\n'), /·\s*add a test/, 'constraints are still bulleted')
  assert.match(card.join('\n'), /\$ npm test/, 'verification still reads as a command')
  // A short value must not be padded out to the label column's worth of spaces
  // on its own line.
  assert.ok(!card.some(r => /^\s{10,}\S/.test(r) && r.trim().length < 12), 'short values are not stranded')
}

// ── 6. The other classic emitters are bounded ───────────────────────────────
{
  assert.ok(visibleWidth(banner()) <= 80, 'the banner fits')
  assert.ok(visibleWidth(rule()) <= 80, 'the rule fits')
  for (const type of ['task.created', 'agent.completed', 'task.failed', 'tool.called', 'unknown.event']) {
    assert.ok(visibleWidth(formatEvent(type, 'architect')) <= 80, `${type} fits`)
  }
  assert.ok(visibleWidth(stageHeader('architect')) <= 80, 'a stage header fits')
}

console.log(`TUI TEST: PASS (the classic card respects ${widths.join('/')} columns, wrapped values align, pathological input still fits)`)

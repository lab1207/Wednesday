/**
 * Public scoreboard page generator (offline, no model).
 *
 * Reads every public-board batch under the benchmarks home
 * (~/.wednesday/benchmarks/public/<board>/<batch>/{summary.json,records.jsonl}),
 * combines each board's latest Wednesday score with the published anchors
 * (official 3B, repro, market, ceilings), and writes a single-file
 * zero-build page: `site/scoreboard.html` (linked from the site index;
 * deploying stays the user's action).
 *
 * Run: npx tsx factory/benchmark/public/scoreboard.ts [--home <dir>] [--out <file>]
 * Re-generate after every live round so the page never goes stale.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import {
  CEILING_ANCHORS,
  MARKET_ANCHORS,
  QWEN_3B_OFFICIAL,
  QWEN_3B_REPRO,
  type PublicBoardId,
} from './anchors'
import type { BoardSummary } from './board-runner'

const BOARDS: PublicBoardId[] = ['humaneval', 'aider', 'livecodebench', 'swebench', 'evalplus', 'swebench-verified', 'swebench-live', 'multi-swe']

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

interface BatchInfo {
  board: PublicBoardId
  batchId: string
  summary: BoardSummary
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function loadBatches(home: string): Promise<BatchInfo[]> {
  const out: BatchInfo[] = []
  for (const board of BOARDS) {
    let batches: string[] = []
    try {
      batches = await readdir(join(home, board))
    } catch {
      continue
    }
    for (const batchId of batches.sort()) {
      const summary = (await readJson(join(home, board, batchId, 'summary.json'))) as BoardSummary | undefined
      if (!summary || summary.board !== board) continue
      // Pre-model-label batches (public-v1.0.0) ran only the local 3B route:
      // old winners carry no model field, so backfill the single known
      // live model instead of dropping them into 'unknown'. Deterministic
      // batches keep their own label; true unknowns stay 'unknown'.
      if (!summary.model) {
        summary.model = summary.mode === 'live' ? 'qwen2.5-coder-3b-instruct' : summary.mode === 'deterministic' ? 'deterministic' : 'unknown'
      }
      out.push({ board, batchId, summary })
    }
  }
  return out
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface ModelColumn {
  readonly id: string
  readonly label: string
  readonly sub: string
  readonly highlight?: boolean
  value(board: PublicBoardId): number | null
}

function anchorScore(rows: { board: PublicBoardId; metric: string; score: number }[], board: PublicBoardId, metric: string): number | null {
  return rows.find(r => r.board === board && r.metric === metric)?.score ?? null
}

const MODEL_COLUMNS: ModelColumn[] = [
  { id: 'factory', label: 'Wednesday', sub: 'live runs · qwen2.5-coder-3b', highlight: true, value: () => null },
  { id: 'official', label: '3B as-is', sub: 'maker published', value: b => anchorScore(QWEN_3B_OFFICIAL, b, primaryMetric(b)) },
  { id: 'repro', label: '3B as-is', sub: 'independent test', value: b => anchorScore(QWEN_3B_REPRO, b, 'HumanEval pass@1') },
  { id: 'qwen7b', label: 'Qwen 7B', sub: 'published', value: b => anchorScore(MARKET_ANCHORS.filter(r => r.model.includes('qwen2.5-coder-7b')), b, primaryMetric(b)) },
  { id: 'qwen32b', label: 'Qwen 32B', sub: 'published', value: b => anchorScore(CEILING_ANCHORS.filter(r => r.model.includes('32b')), b, primaryMetric(b)) },
  { id: 'gpt4o', label: 'GPT-4o', sub: 'published', value: b => anchorScore(CEILING_ANCHORS.filter(r => r.model.includes('gpt-4o')), b, primaryMetric(b)) },
]

function primaryMetric(board: PublicBoardId): string {
  if (board === 'humaneval') return 'HumanEval HE pass@1'
  if (board === 'aider') return 'Aider Pass@1'
  if (board === 'evalplus') return 'EvalPlus HE+ pass@1'
  if (board === 'swebench-verified') return 'SWE-bench Verified %'
  if (board === 'swebench-live') return 'SWE-bench-Live %'
  if (board === 'multi-swe') return 'Multi-SWE-bench %'
  return 'LiveCodeBench Pass@1'
}

interface BoardRow {
  readonly board: PublicBoardId
  readonly section: string
  readonly plain: string
  readonly sub: string
  readonly tests: string
}

const BOARD_ROWS: BoardRow[] = [
  { board: 'humaneval', section: 'Writing code', plain: 'Python function writing', sub: 'HumanEval · % tasks solved', tests: 'writing Python functions from a docstring' },
  { board: 'aider', section: 'Editing code', plain: 'Fixing existing code', sub: 'Aider polyglot · % exercises solved', tests: 'editing existing code across languages' },
  { board: 'livecodebench', section: 'Contest coding', plain: 'Competition problems', sub: 'LiveCodeBench · % solved', tests: 'solving competition problems' },
  { board: 'swebench', section: 'Real-world issues', plain: 'GitHub issue fixes', sub: 'SWE-bench Lite · % resolved', tests: 'resolving real GitHub issues' },
  { board: 'evalplus', section: 'Writing code', plain: 'Hardened function writing', sub: 'EvalPlus HE+ · % tasks solved', tests: 'writing Python functions against strengthened suites' },
  { board: 'swebench-verified', section: 'Real-world issues', plain: 'Verified issue fixes', sub: 'SWE-bench Verified · % resolved', tests: 'resolving human-verified GitHub issues' },
  { board: 'swebench-live', section: 'Real-world issues', plain: 'Fresh issue fixes', sub: 'SWE-bench-Live · % resolved', tests: 'resolving continuously refreshed GitHub issues' },
  { board: 'multi-swe', section: 'Real-world issues', plain: 'Multilingual fixes', sub: 'Multi-SWE-bench · % resolved', tests: 'resolving issues across languages' },
]

function matrixTable(latestByBoard: Map<PublicBoardId, BatchInfo[]>): string {
  const head = [
    '<tr><th></th>',
    ...MODEL_COLUMNS.map(col =>
      `<th${col.highlight === true ? ' class="ours"' : ''}>${esc(col.label)}<span class="colsub">${esc(col.sub)}</span></th>`,
    ),
    '</tr>',
  ].join('\n')

  const body: string[] = []
  let lastSection = ''
  for (const row of BOARD_ROWS) {
    if (row.section !== lastSection) {
      lastSection = row.section
      body.push(`<tr class="section"><td colspan="${MODEL_COLUMNS.length + 1}">${esc(row.section)}</td></tr>`)
    }
    const live = (latestByBoard.get(row.board) ?? [])
      .filter(b => b.summary.mode === 'live')
      .sort((a, b) => a.batchId.localeCompare(b.batchId))
    const latest = live.at(-1)
    const factory = latest ? latest.summary.passed / Math.max(1, latest.summary.total) : null
    const factoryNote = latest ? `our live run, n=${latest.summary.total}` : 'not run live yet'
    const cells = MODEL_COLUMNS.map(col => ({
      col,
      value: col.id === 'factory' ? factory : col.value(row.board),
    }))
    const best = Math.max(...cells.map(cell => cell.value ?? -1))
    const tds = cells.map(cell => {
      const text = cell.value === null ? '—' : (cell.value * 100).toFixed(1)
      const classes = [
        cell.col.highlight === true ? 'ours' : '',
        cell.value !== null && cell.value === best && best >= 0 ? 'best' : '',
      ].filter(Boolean).join(' ')
      const title = cell.col.id === 'factory' ? factoryNote : 'published number — never re-run'
      return `<td><span${classes ? ` class="${classes}"` : ''} title="${esc(title)}">${text}</span></td>`
    })
    const smoke = latest !== undefined && latest.summary.total <= 5 && row.board !== 'humaneval'
      ? ' · smoke sample'
      : latest !== undefined && latest.summary.total <= 5
        ? ' · smoke sample'
        : ''
    body.push(
      `<tr><td class="rowname">${esc(row.plain)}<span class="colsub">${esc(row.sub)}${smoke}</span></td>${tds.join('')}</tr>`,
    )
  }
  return `<div class="table-wrap"><table>\n${head}\n${body.join('\n')}\n</table></div>`
}

function latestLive(latestByBoard: Map<PublicBoardId, BatchInfo[]>, board: PublicBoardId): BatchInfo | undefined {
  return (latestByBoard.get(board) ?? [])
    .filter(b => b.summary.mode === 'live')
    .sort((a, b) => a.batchId.localeCompare(b.batchId))
    .at(-1)
}

/** One honest sentence per board: what it tests plus the latest live number. */
function boardNarrative(row: BoardRow, latest: BatchInfo | undefined): string {
  const open = '<p class="text-dim" style="font-size: 0.88rem; margin-bottom: 16px;">'
  if (!latest) {
    return `${open}Tests ${esc(row.tests)}. No live run yet — the gray columns are published single-model numbers.</p>`
  }
  const rate = latest.summary.passed / Math.max(1, latest.summary.total)
  const pct = (rate * 100).toFixed(1)
  const cls = rate >= 1 ? 'text-ok' : 'text-bad'
  const smoke = latest.summary.total <= 5 ? ' (smoke sample: proves the pipeline, not a citable score)' : ''
  return `${open}Tests ${esc(row.tests)}. Latest live run: <strong class="${cls}">${latest.summary.passed}/${latest.summary.total} (${pct}%)</strong> — ${esc(formatBatchDate(latest.batchId))}${esc(smoke)}.</p>`
}

function chartBars(board: PublicBoardId, pairs: Array<{ label: string; sub: string; value: number | null; ours?: boolean }>): string {
  const present = pairs.filter(pair => pair.value !== null) as Array<{ label: string; sub: string; value: number; ours?: boolean }>
  if (present.length === 0) return ''
  const labelW = 190
  const barMax = 520
  const rowH = 30
  const height = present.length * rowH + 8
  const rows = present.map((pair, index) => {
    const y = index * rowH + 4
    const width = Math.max(2, Math.round((pair.value / 100) * barMax))
    const fill = pair.ours === true ? '#f0b429' : '#a3a3a3'
    const textFill = '#0a0a0a'
    return [
      `<text x="0" y="${y + 13}" class="blabel" fill="${textFill}">${esc(pair.label)}</text>`,
      `<text x="0" y="${y + 24}" class="bsub" fill="#525252">${esc(pair.sub)}</text>`,
      `<rect x="${labelW}" y="${y}" width="${width}" height="20" rx="4" fill="${fill}"/>`,
      `<text x="${labelW + width + 8}" y="${y + 15}" class="bval" fill="${textFill}">${(pair.value * 100).toFixed(1)}</text>`,
    ].join('')
  })
  return `<svg viewBox="0 0 760 ${height}" role="img" aria-label="${esc(board)} scores chart" style="width: 100%; height: auto;">${rows.join('')}</svg>`
}

function boardSection(row: BoardRow, latest: BatchInfo | undefined): string {
  const factory = latest ? latest.summary.passed / Math.max(1, latest.summary.total) : null
  const chart = chartBars(row.board, [
    { label: 'Wednesday', sub: 'live runs · qwen2.5-coder-3b', value: factory, ours: true },
    { label: '3B as-is', sub: 'maker published', value: anchorScore(QWEN_3B_OFFICIAL, row.board, primaryMetric(row.board)) },
    { label: '3B as-is', sub: 'independent test', value: row.board === 'humaneval' ? anchorScore(QWEN_3B_REPRO, row.board, 'HumanEval pass@1') : null },
    { label: 'Qwen 7B', sub: 'published', value: anchorScore(MARKET_ANCHORS.filter(r => r.model.includes('qwen2.5-coder-7b')), row.board, primaryMetric(row.board)) },
    { label: 'Qwen 32B', sub: 'published', value: anchorScore(CEILING_ANCHORS.filter(r => r.model.includes('32b')), row.board, primaryMetric(row.board)) },
    { label: 'GPT-4o', sub: 'published', value: anchorScore(CEILING_ANCHORS.filter(r => r.model.includes('gpt-4o')), row.board, primaryMetric(row.board)) },
  ])
  return [
    `<h3 style="font-size: 1rem; font-weight: 600; margin: 32px 0 8px;">${esc(row.plain)}</h3>`,
    boardNarrative(row, latest),
    chart ? `<div class="card" style="padding: 20px;">${chart}</div>` : '',
  ].join('\n')
}

function formatBatchDate(batchId: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(batchId)
  if (!match) return batchId.slice(0, 16)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[Number(match[2]) - 1] ?? match[2]} ${match[3]}, ${match[4]}:${match[5]}`
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function historyTable(batches: BatchInfo[]): string {
  const rows = batches
    .slice()
    .sort((a, b) => b.batchId.localeCompare(a.batchId))
    .slice(0, 10)
    .map(b => `<tr><td class="rowname">${esc(b.board)}</td><td>${esc(formatBatchDate(b.batchId))}</td><td>${esc(b.summary.mode)}</td><td>${b.summary.passed}/${b.summary.total}</td><td>${b.summary.totalTokens.toLocaleString()} tok</td><td>${esc(formatDuration(b.summary.durationMs))}</td></tr>`)
    .join('\n')
  return `<div class="table-wrap"><table><tr><th>Board</th><th>Run</th><th>Mode</th><th>Pass</th><th>Tokens</th><th>Time</th></tr>${rows}</table></div>`
}

interface LanguageScore {
  readonly language: string
  readonly passed: number
  readonly total: number
}

async function aiderLanguageScores(home: string): Promise<LanguageScore[]> {
  const byLang = new Map<string, { passed: number; total: number }>()
  let batches: string[] = []
  try {
    batches = await readdir(join(home, 'aider'))
  } catch {
    return []
  }
  const batchDirs = batches.sort()
  // Newest batch WITH records (a running batch has a dir but no records yet).
  for (const latest of batchDirs.reverse()) {
    const raw = await readFile(join(home, 'aider', latest, 'records.jsonl'), 'utf8').catch(() => '')
    if (!raw.trim()) continue
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed) as { problemId?: string; boardGrade?: { passed?: boolean } }
        const lang = String(record.problemId ?? '').split('/')[1] || 'unknown'
        const entry = byLang.get(lang) ?? { passed: 0, total: 0 }
        entry.total += 1
        if (record.boardGrade?.passed === true) entry.passed += 1
        byLang.set(lang, entry)
      } catch {
        continue
      }
    }
    break
  }
  return [...byLang.entries()]
    .map(([language, score]) => ({ language, passed: score.passed, total: score.total }))
    .sort((a, b) => a.language.localeCompare(b.language))
}

function languageChart(title: string, scores: LanguageScore[]): string {
  if (scores.length === 0) return ''
  const labelW = 120
  const barMax = 480
  const rowH = 34
  const height = scores.length * rowH + 8
  const rows = scores.map((score, index) => {
    const rate = score.total > 0 ? score.passed / score.total : 0
    const y = index * rowH + 4
    const width = Math.max(2, Math.round(rate * barMax))
    const label = score.language.charAt(0).toUpperCase() + score.language.slice(1)
    return [
      `<text x="0" y="${y + 14}" class="blabel" fill="#0a0a0a">${esc(label)}</text>`,
      `<text x="0" y="${y + 26}" class="bsub" fill="#525252">n=${score.total}</text>`,
      `<rect x="${labelW}" y="${y}" width="${width}" height="20" rx="4" fill="#f0b429"/>`,
      `<text x="${labelW + width + 8}" y="${y + 15}" class="bval" fill="#0a0a0a">${score.passed}/${score.total}</text>`,
    ].join('')
  })
  return `<h3 style="font-size: 1rem; font-weight: 600; margin: 32px 0 8px;">${esc(title)}</h3><div class="card" style="padding: 20px;"><svg viewBox="0 0 760 ${height}" role="img" aria-label="${esc(title)}" style="width: 100%; height: auto;">${rows.join('')}</svg></div>`
}

export function modelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-model'
}

/**
 * Crew catalog — the scored unit is the SYSTEM, never a lone model.
 * Crew 1 (trio roles 2 of 3 live-proven 2026-09-27, first crew board
 * runs pending): R1-7B plans, Coder-3B types, VL-7B sees; stage-pinned,
 * Q4, one Colab T4 via the swapper. Crew pages show roster + roles +
 * config ONLY — per-member scores do not exist (members are never
 * measured separately) and are never fabricated; numbers stay system
 * rows on the scoreboard.
 */
export interface CrewMember {
  readonly model: string
  readonly role: string
  readonly quant: string
  readonly host: string
}

export interface Crew {
  readonly slug: string
  readonly name: string
  readonly status: string
  readonly members: CrewMember[]
}

export const CREWS: Crew[] = [
  {
    slug: 'crew-1',
    name: 'Crew 1',
    status: 'Trio roles 2 of 3 live-proven — first crew board runs pending',
    members: [
      {
        model: 'DeepSeek-R1-Distill-Qwen-7B',
        role: 'Planner — architect + planner stages, strategy-change repairs',
        quant: 'Q4',
        host: 'Colab T4 (swapper)',
      },
      {
        model: 'Qwen2.5-Coder-3B-Instruct',
        role: 'Coder — coder + tester + reviewer stages, all repair retries',
        quant: 'Q4',
        host: 'Colab T4 (swapper)',
      },
      {
        model: 'Qwen2.5-VL-7B-Instruct',
        role: 'Vision — screenshots + spec docs, on demand only',
        quant: 'Q4 + mmproj',
        host: 'Colab T4 (swapper)',
      },
    ],
  },
]

export function renderCrewPage(crew: Crew, generatedAt: string): string {
  const rows = crew.members
    .map(member => `<tr><td class="rowname">${esc(member.model)}</td><td>${esc(member.role)}</td><td>${esc(member.quant)}</td><td>${esc(member.host)}</td></tr>`)
    .join('\n')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...pageHead(
      `Wednesday — ${crew.name} (small-model crew)`,
      `${crew.name}: ${crew.members.map(m => m.model).join(', ')} — roster, roles, and serving config.`,
      '../style.css',
    ),
    '</head>',
    '<body>',
    '<div class="wrap narrow">',
    '<section class="hero" style="padding: 80px 0 40px;">',
    `  <div class="hero-label">${esc(crew.name)}</div>`,
    '  <h1>Small-model crew</h1>',
    `  <p class="lede">${esc(crew.status)}. Generated ${esc(generatedAt)}.</p>`,
    '  <p style="margin-top: 20px;"><a href="./index.html" class="text-dim" style="font-size: 0.88rem;">← Library</a> · <a href="../scoreboard.html" class="text-dim" style="font-size: 0.88rem;">Scoreboard</a></p>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="section-label">Roster</div>',
    '  <h2>Members & roles</h2>',
    '  <div class="table-wrap" style="margin-top: 16px;">',
    '    <table>',
    '      <tr><th>Member</th><th>Crew role</th><th>Quant</th><th>Host</th></tr>',
    rows,
    '    </table>',
    '  </div>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="section-label">Notes</div>',
    '  <h2>Why no per-member scores</h2>',
    '  <div class="prose" style="margin-top: 16px;">',
    '    <ul>',
    '<li>One model alone loses to a frontier model — the crew (planned, typed, seen, verified, repaired) is what beats it. Same boards, same rules.</li>',
    '<li>No per-member scores exist and none are shown: members are never measured separately, so member bars would be fabricated. Numbers stay system rows on the scoreboard.</li>',
    `<li>First crew runs land on the <a href="../scoreboard.html">scoreboard</a> with this crew in the config label — this page then links them.</li>`,
    '    </ul>',
    '  </div>',
    '</section>',
    '<footer style="padding: 40px 0; text-align: center; color: var(--txt-mute); font-size: 0.82rem; border-top: 1px solid var(--line);">',
    '  <div class="wrap">',
    '    <p>Wednesday © 2026 Vaibhav Hajare (lab1207). A team of small models that out-builds single frontier ones.</p>',
    '  </div>',
    '</footer>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export interface LibraryEntry {
  readonly slug: string
  readonly model: string
  readonly boards: number
  readonly passed: number
  readonly total: number
  readonly generatedAt: string
}

export function libraryMetadata(model: string, batches: BatchInfo[], generatedAt: string): LibraryEntry {
  const slug = modelSlug(model)
  const boards = new Set(batches.map(b => b.board)).size
  return {
    slug,
    model,
    boards,
    passed: batches.reduce((s, b) => s + b.summary.passed, 0),
    total: batches.reduce((s, b) => s + b.summary.total, 0),
    generatedAt,
  }
}

function modelCardRow(titleModel: string): string {
  if (titleModel === 'qwen2.5-coder-3b-instruct') {
    return '<tr><td>qwen2.5-coder-3b-instruct</td><td>3.09B</td><td>36</td><td>32K</td><td>Qwen Research</td></tr>'
  }
  return `<tr><td>${esc(titleModel)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`
}

/** Single shared stylesheet for all generated pages (no pasted copies). */
const SHARED_STYLE = [
  "/* ============================================",
  "   Wednesday — OpenAI Astra-tier Design",
  "   Light, editorial, typography-first",
  "   ============================================ */",
  "",
  "@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap');",
  "",
  ":root {",
  "  --bg: #fafafa;",
  "  --bg-elev: #ffffff;",
  "  --bg-subtle: #f5f5f5;",
  "  --line: #e5e5e5;",
  "  --line-bright: #d4d4d4;",
  "  --txt: #0a0a0a;",
  "  --txt-dim: #525252;",
  "  --txt-mute: #a3a3a3;",
  "  --acc: #f0b429;",
  "  --acc-dark: #b45309;",
  "  --acc-soft: rgba(240, 180, 41, 0.08);",
  "  --ok: #059669;",
  "  --ok-soft: rgba(5, 150, 105, 0.06);",
  "  --bad: #dc2626;",
  "  --info: #2563eb;",
  "  --info-soft: rgba(37, 99, 235, 0.06);",
  "  --radius: 8px;",
  "  --radius-sm: 6px;",
  "  --font: 'Inter', system-ui, -apple-system, sans-serif;",
  "  --serif: 'Newsreader', Georgia, serif;",
  "  --mono: 'SF Mono', ui-monospace, 'Cascadia Code', monospace;",
  "  --ease: cubic-bezier(0.16, 1, 0.3, 1);",
  "  --maxw: 680px;",
  "}",
  "",
  "* { box-sizing: border-box; margin: 0; padding: 0; }",
  "",
  "html {",
  "  scroll-behavior: smooth;",
  "  -webkit-font-smoothing: antialiased;",
  "  -moz-osx-font-smoothing: grayscale;",
  "}",
  "",
  "body {",
  "  background: var(--bg);",
  "  color: var(--txt);",
  "  font-family: var(--font);",
  "  font-size: 16px;",
  "  line-height: 1.65;",
  "}",
  "",
  "/* ---------- Layout ---------- */",
  ".wrap {",
  "  max-width: var(--maxw);",
  "  margin: 0 auto;",
  "  padding: 0 24px;",
  "}",
  "",
  "/* ---------- Hero ---------- */",
  ".hero {",
  "  padding: 120px 0 80px;",
  "  text-align: center;",
  "}",
  "",
  ".hero-label {",
  "  display: inline-block;",
  "  font-size: 0.72rem;",
  "  font-weight: 600;",
  "  letter-spacing: 0.12em;",
  "  text-transform: uppercase;",
  "  color: var(--acc-dark);",
  "  margin-bottom: 20px;",
  "  padding: 4px 12px;",
  "  background: var(--acc-soft);",
  "  border-radius: 100px;",
  "}",
  "",
  ".hero h1 {",
  "  font-family: var(--serif);",
  "  font-size: clamp(2.5rem, 5vw, 3.8rem);",
  "  font-weight: 500;",
  "  line-height: 1.1;",
  "  letter-spacing: -0.02em;",
  "  margin-bottom: 24px;",
  "  color: var(--txt);",
  "}",
  "",
  ".lede {",
  "  font-size: 1.15rem;",
  "  line-height: 1.7;",
  "  color: var(--txt-dim);",
  "  max-width: 540px;",
  "  margin: 0 auto 36px;",
  "}",
  "",
  ".hero-cta {",
  "  display: flex;",
  "  gap: 12px;",
  "  justify-content: center;",
  "  flex-wrap: wrap;",
  "}",
  "",
  "/* ---------- Buttons ---------- */",
  ".btn {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: 8px;",
  "  padding: 12px 24px;",
  "  border-radius: var(--radius-sm);",
  "  font-weight: 500;",
  "  font-size: 0.9rem;",
  "  text-decoration: none;",
  "  transition: all 0.2s var(--ease);",
  "  cursor: pointer;",
  "  border: none;",
  "  font-family: var(--font);",
  "}",
  "",
  ".btn-primary {",
  "  background: var(--txt);",
  "  color: var(--bg);",
  "}",
  "",
  ".btn-primary:hover {",
  "  background: #333;",
  "  transform: translateY(-1px);",
  "}",
  "",
  ".btn-ghost {",
  "  background: transparent;",
  "  color: var(--txt);",
  "  border: 1px solid var(--line-bright);",
  "}",
  "",
  ".btn-ghost:hover {",
  "  border-color: var(--txt-mute);",
  "  background: var(--bg-elev);",
  "}",
  "",
  "/* ---------- Sections ---------- */",
  ".section {",
  "  padding: 64px 0;",
  "  border-top: 1px solid var(--line);",
  "}",
  "",
  ".section:first-of-type { border-top: none; }",
  "",
  ".section-label {",
  "  font-size: 0.72rem;",
  "  font-weight: 600;",
  "  letter-spacing: 0.12em;",
  "  text-transform: uppercase;",
  "  color: var(--acc-dark);",
  "  margin-bottom: 12px;",
  "}",
  "",
  ".section h2 {",
  "  font-family: var(--serif);",
  "  font-size: 1.8rem;",
  "  font-weight: 500;",
  "  letter-spacing: -0.01em;",
  "  margin-bottom: 16px;",
  "  line-height: 1.25;",
  "}",
  "",
  ".section .sub {",
  "  color: var(--txt-dim);",
  "  font-size: 1rem;",
  "  max-width: 480px;",
  "  margin-bottom: 28px;",
  "}",
  "",
  "/* ---------- Prose ---------- */",
  ".prose p {",
  "  margin-bottom: 16px;",
  "  color: var(--txt-dim);",
  "  font-size: 0.98rem;",
  "  line-height: 1.75;",
  "}",
  "",
  ".prose p strong { color: var(--txt); font-weight: 600; }",
  ".prose p em { font-style: italic; }",
  "",
  ".prose ul {",
  "  padding-left: 20px;",
  "  margin: 16px 0;",
  "}",
  "",
  ".prose li {",
  "  margin: 8px 0;",
  "  color: var(--txt-dim);",
  "  font-size: 0.95rem;",
  "}",
  "",
  ".prose li strong { color: var(--txt); font-weight: 600; }",
  "",
  "/* ---------- Pull Quote ---------- */",
  ".pullquote {",
  "  margin: 40px 0;",
  "  padding: 24px 28px;",
  "  background: var(--bg-elev);",
  "  border: 1px solid var(--line);",
  "  border-radius: var(--radius);",
  "  position: relative;",
  "}",
  "",
  ".pullquote p {",
  "  font-family: var(--serif);",
  "  font-size: 1.15rem;",
  "  font-style: italic;",
  "  line-height: 1.6;",
  "  color: var(--txt);",
  "  margin-bottom: 12px;",
  "}",
  "",
  ".pullquote cite {",
  "  font-size: 0.82rem;",
  "  font-style: normal;",
  "  font-weight: 500;",
  "  color: var(--txt-mute);",
  "}",
  "",
  "/* ---------- Terminal ---------- */",
  ".terminal {",
  "  background: #0a0a0a;",
  "  border-radius: var(--radius);",
  "  overflow: hidden;",
  "  font-family: var(--mono);",
  "  font-size: 0.82rem;",
  "  line-height: 1.8;",
  "  margin: 24px 0;",
  "}",
  "",
  ".terminal-bar {",
  "  display: flex;",
  "  align-items: center;",
  "  gap: 6px;",
  "  padding: 10px 14px;",
  "  background: #1a1a1a;",
  "  border-bottom: 1px solid #2a2a2a;",
  "}",
  "",
  ".terminal-dot {",
  "  width: 10px;",
  "  height: 10px;",
  "  border-radius: 50%;",
  "}",
  "",
  ".terminal-dot:nth-child(1) { background: #ff5f57; }",
  ".terminal-dot:nth-child(2) { background: #febc2e; }",
  ".terminal-dot:nth-child(3) { background: #28c840; }",
  "",
  ".terminal-body {",
  "  padding: 20px 24px;",
  "  overflow-x: auto;",
  "  white-space: pre;",
  "  color: #d4d4d4;",
  "}",
  "",
  ".terminal-body .prompt { color: var(--acc); }",
  ".terminal-body .ok { color: #4ade80; }",
  ".terminal-body .dim { color: #737373; }",
  ".terminal-body .cmd { color: #60a5fa; }",
  "",
  "/* ---------- Tables ---------- */",
  ".table-wrap {",
  "  background: var(--bg-elev);",
  "  border: 1px solid var(--line);",
  "  border-radius: var(--radius);",
  "  overflow: hidden;",
  "  margin: 24px 0;",
  "  overflow-x: auto;",
  "}",
  "",
  "table {",
  "  width: 100%;",
  "  border-collapse: collapse;",
  "  font-size: 0.85rem;",
  "}",
  "",
  "th, td {",
  "  text-align: left;",
  "  padding: 10px 14px;",
  "  border-bottom: 1px solid var(--line);",
  "  white-space: nowrap;",
  "}",
  "",
  "th {",
  "  color: var(--txt-mute);",
  "  font-weight: 500;",
  "  font-size: 0.72rem;",
  "  text-transform: uppercase;",
  "  letter-spacing: 0.06em;",
  "  background: var(--bg-subtle);",
  "}",
  "",
  "th.ours, td .ours {",
  "  background: var(--acc-soft);",
  "}",
  "",
  "td.rowname { font-weight: 500; }",
  "",
  "tr.section td {",
  "  background: var(--bg-subtle);",
  "  color: var(--txt-dim);",
  "  font-weight: 600;",
  "  font-size: 0.72rem;",
  "  text-transform: uppercase;",
  "  letter-spacing: 0.08em;",
  "}",
  "",
  "td .best { font-weight: 700; color: var(--acc-dark); }",
  "td .cell { display: inline-block; min-width: 40px; }",
  "th .colsub, td .colsub { display: block; font-weight: 400; font-size: 0.75rem; color: var(--txt-mute); text-transform: none; letter-spacing: 0; }",
  "",
  "/* Chart labels (SVG) */",
  ".blabel { font-size: 13px; font-weight: 600; }",
  ".bsub { font-size: 11px; }",
  ".bval { font-size: 13px; font-weight: 700; }",
  "",
  "/* ---------- Cards (minimal) ---------- */",
  ".card {",
  "  background: var(--bg-elev);",
  "  border: 1px solid var(--line);",
  "  border-radius: var(--radius);",
  "  padding: 24px;",
  "  transition: border-color 0.2s;",
  "}",
  "",
  ".card:hover { border-color: var(--line-bright); }",
  "",
  ".card h3 {",
  "  font-size: 0.95rem;",
  "  font-weight: 600;",
  "  margin-bottom: 8px;",
  "}",
  "",
  ".card p {",
  "  color: var(--txt-dim);",
  "  font-size: 0.88rem;",
  "  line-height: 1.6;",
  "}",
  "",
  "/* ---------- Details ---------- */",
  "details {",
  "  background: var(--bg-elev);",
  "  border: 1px solid var(--line);",
  "  border-radius: var(--radius);",
  "  margin: 12px 0;",
  "  overflow: hidden;",
  "  transition: border-color 0.2s;",
  "}",
  "",
  "details:hover { border-color: var(--line-bright); }",
  "",
  "summary {",
  "  cursor: pointer;",
  "  font-weight: 500;",
  "  font-size: 0.92rem;",
  "  padding: 16px 20px;",
  "  list-style: none;",
  "  display: flex;",
  "  align-items: center;",
  "  gap: 10px;",
  "  user-select: none;",
  "}",
  "",
  "summary::before {",
  "  content: '›';",
  "  color: var(--acc-dark);",
  "  font-weight: 600;",
  "  transition: transform 0.2s var(--ease);",
  "  font-size: 1rem;",
  "  line-height: 1;",
  "}",
  "",
  "details[open] summary::before { transform: rotate(90deg); }",
  "",
  "summary::-webkit-details-marker { display: none; }",
  "",
  "details .detail-body {",
  "  padding: 0 20px 18px;",
  "  color: var(--txt-dim);",
  "  font-size: 0.88rem;",
  "  line-height: 1.7;",
  "}",
  "",
  "details .detail-body p { margin: 8px 0; }",
  "details .detail-body ul { padding-left: 18px; margin: 8px 0; }",
  "",
  "/* ---------- Tags ---------- */",
  ".tag {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: 4px;",
  "  padding: 2px 10px;",
  "  border-radius: 100px;",
  "  font-size: 0.72rem;",
  "  font-weight: 500;",
  "  border: 1px solid var(--line);",
  "  color: var(--txt-dim);",
  "  background: var(--bg-subtle);",
  "}",
  "",
  ".tag-acc { color: var(--acc-dark); border-color: rgba(240,180,41,0.3); background: var(--acc-soft); }",
  ".tag-ok { color: var(--ok); border-color: rgba(5,150,105,0.3); background: var(--ok-soft); }",
  "",
  "code.inline {",
  "  background: var(--bg-subtle);",
  "  border: 1px solid var(--line);",
  "  border-radius: 4px;",
  "  padding: 1px 6px;",
  "  font-family: var(--mono);",
  "  font-size: 0.82em;",
  "  color: var(--acc-dark);",
  "}",
  "",
  "/* ---------- Links ---------- */",
  "a { color: var(--info); text-decoration: none; }",
  "a:hover { text-decoration: underline; }",
  "",
  "/* ---------- Utility ---------- */",
  ".text-acc { color: var(--acc-dark); }",
  ".text-ok { color: var(--ok); }",
  ".text-dim { color: var(--txt-dim); }",
  ".text-mute { color: var(--txt-mute); }",
  ".text-bad { color: var(--bad); }",
  "",
  ".mt-0 { margin-top: 0; }",
  ".mt-1 { margin-top: 8px; }",
  ".mt-2 { margin-top: 16px; }",
  ".mt-3 { margin-top: 24px; }",
  ".mt-4 { margin-top: 32px; }",
  ".mb-0 { margin-bottom: 0; }",
  ".mb-1 { margin-bottom: 8px; }",
  ".mb-2 { margin-bottom: 16px; }",
  ".mb-3 { margin-bottom: 24px; }",
  ".mb-4 { margin-bottom: 32px; }",
  "",
  "/* ---------- Animations ---------- */",
  "@keyframes fadeIn {",
  "  from { opacity: 0; transform: translateY(12px); }",
  "  to { opacity: 1; transform: translateY(0); }",
  "}",
  "",
  ".reveal {",
  "  opacity: 0;",
  "  transform: translateY(16px);",
  "  transition: all 0.7s var(--ease);",
  "}",
  "",
  ".reveal.visible {",
  "  opacity: 1;",
  "  transform: translateY(0);",
  "}",
  "",
  "/* ---------- Responsive ---------- */",
  "@media (max-width: 640px) {",
  "  .hero { padding: 80px 0 60px; }",
  "  .hero h1 { font-size: 2.2rem; }",
  "  .lede { font-size: 1.05rem; }",
  "  .section { padding: 48px 0; }",
  "  .section h2 { font-size: 1.4rem; }",
  "  .terminal-body { padding: 16px 18px; font-size: 0.78rem; }",
  "}",
].join('\n')

/** Shared stylesheet source for generated pages (single copy). */
export function sharedStyleCss(): string {
  return `${SHARED_STYLE}\n`
}

function pageHead(title: string, description: string, cssPath: string): string[] {
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="stylesheet" href="${cssPath}">`,
  ]
}

export function renderLibraryIndex(entries: LibraryEntry[]): string {
  const crewCards = CREWS
    .map(crew => [
      `<h2>${esc(crew.name)} — small-model crew</h2>`,
      '<div class="card" style="margin-top: 16px;">',
      `  <p style="color: var(--txt-dim); font-size: 0.92rem; margin-bottom: 12px;">${crew.members.map(m => esc(m.model)).join(' · ')} — ${esc(crew.status)}.</p>`,
      `  <a href="./${esc(crew.slug)}.html" class="btn btn-ghost" style="padding: 8px 16px; font-size: 0.85rem;">View crew</a>`,
      '</div>',
    ].join('\n'))
    .join('\n')
  const cards = entries
    .slice()
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .map(entry => [
      `<h2>${esc(entry.model)}</h2>`,
      '<div class="card" style="margin-top: 16px;">',
      `  <p style="color: var(--txt-dim); font-size: 0.92rem; margin-bottom: 12px;">${entry.boards} boards · ${entry.passed}/${entry.total} solved · updated ${esc(entry.generatedAt.slice(0, 10))}</p>`,
      `  <a href="./${esc(entry.slug)}.html" class="btn btn-ghost" style="padding: 8px 16px; font-size: 0.85rem;">View scoreboard</a>`,
      '</div>',
    ].join('\n'))
    .join('\n')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...pageHead(
      'Wednesday — tested models library',
      'Every model Wednesday has run, each with its own scoreboard page.',
      '../style.css',
    ),
    '</head>',
    '<body>',
    '<div class="wrap narrow">',
    '<section class="hero" style="padding: 80px 0 40px;">',
    '  <div class="hero-label">Model Library</div>',
    '  <h1>Tested models</h1>',
    '  <p class="lede">Crews first — the scored unit is the system. Then every lone model Wednesday has run, each with its own scoreboard page.</p>',
    '  <p style="margin-top: 20px;"><a href="../index.html" class="text-dim" style="font-size: 0.88rem;">← Wednesday</a></p>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="section-label">Crews</div>',
    crewCards || '  <p class="text-dim">No crews yet.</p>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="section-label">Models</div>',
    cards || '  <p class="text-dim">No models scored yet.</p>',
    '</section>',
    '<footer style="padding: 40px 0; text-align: center; color: var(--txt-mute); font-size: 0.82rem; border-top: 1px solid var(--line);">',
    '  <div class="wrap">',
    '    <p>Wednesday © 2026 Vaibhav Hajare (lab1207).</p>',
    '  </div>',
    '</footer>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export async function renderScoreboard(
  home: string,
  generatedAt: string,
  model?: string,
  cssPath = './style.css',
): Promise<string> {
  const all = await loadBatches(home)
  const batches = model ? all.filter(b => b.summary.model === model) : all
  const titleModel = model ?? 'all models'
  const byBoard = new Map<PublicBoardId, BatchInfo[]>()
  for (const batch of batches) {
    const list = byBoard.get(batch.board) ?? []
    list.push(batch)
    byBoard.set(batch.board, list)
  }
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...pageHead(
      'Wednesday — public benchmark scoreboard',
      'Small model + Wednesday structure, measured in public units: official baselines vs Wednesday runs vs market ceilings.',
      cssPath,
    ),
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<section class="hero" style="padding: 80px 0 40px;">',
    '  <div class="hero-label">Public Benchmark · Small-Model Crew</div>',
    `  <h1>Wednesday × ${esc(titleModel)}</h1>`,
    '  <p class="lede">One small model alone loses to a frontier model — honestly shown in gray. <span class="text-acc">Amber is the Wednesday crew</span> (planner + coder + vision, verified and repaired) running the same public boards under the same rules.</p>',
    `  <p class="text-mute" style="font-size: 0.82rem; margin-top: 16px;">Live config today: qwen2.5-coder-3b solo pipeline — Crew 1 trio rows land with the trio. Every gray bar is a published single-model number we never re-run. Generated ${esc(generatedAt)} — re-generated after every live round.</p>`,
    '  <p style="margin-top: 20px;"><a href="./index.html" class="text-dim" style="font-size: 0.88rem;">← Wednesday</a> · <a href="./models/index.html" class="text-dim" style="font-size: 0.88rem;">Model library</a></p>',
    '</section>',
    `<!--wednesday-library ${JSON.stringify(libraryMetadata(model ?? 'all models', batches, generatedAt))} -->`,
    '<section class="section" style="padding-top: 0;">',
    '  <div class="wrap">',
    '    <div class="table-wrap">',
    '      <table>',
    '        <tr><th>Model under test</th><th>Params</th><th>Layers</th><th>Context</th><th>License</th></tr>',
    `        ${modelCardRow(titleModel)}`,
    '      </table>',
    '    </div>',
    '    <p class="text-mute" style="font-size: 0.82rem; margin-top: 12px;">The small model inside every Wednesday run on this page. Qwen specs: Qwen2.5-Coder tech report.</p>',
    '  </div>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="wrap">',
    '    <div class="section-label">Results</div>',
    '    <h2>Head to head</h2>',
    matrixTable(byBoard),
    '  </div>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="wrap">',
    '    <div class="section-label">Charts</div>',
    '    <h2>By board</h2>',
    ...BOARD_ROWS.flatMap(row => [boardSection(row, latestLive(byBoard, row.board))]),
    languageChart('Aider by language (latest live batch)', await aiderLanguageScores(home)),
    '  </div>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="wrap">',
    '    <div class="section-label">History</div>',
    '    <h2>Recent runs</h2>',
    historyTable(batches),
    '  </div>',
    '</section>',
    '<section class="section" style="padding-top: 0;">',
    '  <div class="wrap">',
    '    <div class="section-label">Guide</div>',
    '    <h2>How to read this</h2>',
    '    <div class="prose">',
    '      <ul>',
    '<li><strong>Official</strong> = the model maker\u2019s published score (their harness).</li>',
    '<li><strong>Repro</strong> = third-party reproduction (different harness — the gap under test).</li>',
    '<li><strong>Wednesday</strong> = live runs of the Wednesday crew through the pipeline (Hermes → roles → board grader). Models are interchangeable parts; the crew is the product.</li>',
    '<li><strong>Crew vs single</strong> = one small model alone loses to a frontier model — honestly shown. The crew (planner + coder + vision, verified and repaired) is what beats it. Same board, same rules.</li>',
    '<li><strong>Market/ceiling</strong> = similar-size rivals and frontier models, published.</li>',
    '<li>Small samples (n=3–5) prove the pipeline, not citable scores. Full-board runs come with a faster model host.</li>',
    '      </ul>',
    '    </div>',
    '  </div>',
    '</section>',
    '<footer style="padding: 40px 0; text-align: center; color: var(--txt-mute); font-size: 0.82rem; border-top: 1px solid var(--line);">',
    '  <div class="wrap">',
    '    <p>Wednesday © 2026 Vaibhav Hajare (lab1207). A team of small models that out-builds single frontier ones.</p>',
    '  </div>',
    '</footer>',
    '</div>',
    '<script>',
    "const reveals = document.querySelectorAll('.section, .table-wrap, .card');",
    'const observer = new IntersectionObserver((entries) => {',
    '  entries.forEach(e => {',
    '    if (e.isIntersecting) {',
    "      e.target.classList.add('visible');",
    '      observer.unobserve(e.target);',
    '    }',
    '  });',
    '}, { threshold: 0.05, rootMargin: \'0px 0px -20px 0px\' });',
    'reveals.forEach(el => {',
    "  el.classList.add('reveal');",
    '  observer.observe(el);',
    '});',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

async function writeCrewPages(modelsDir: string, generatedAt: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(modelsDir, { recursive: true })
  for (const crew of CREWS) {
    await writeFile(join(modelsDir, `${crew.slug}.html`), renderCrewPage(crew, generatedAt), 'utf8')
  }
}

async function rebuildLibraryIndex(modelsDir: string): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = []
  for (const file of await readdir(modelsDir)) {
    if (!file.endsWith('.html') || file === 'index.html') continue
    if (CREWS.some(crew => `${crew.slug}.html` === file)) continue
    const text = await readFile(join(modelsDir, file), 'utf8').catch(() => '')
    const match = /<!--wednesday-library (\{.*?\}) -->/.exec(text)
    if (!match) continue
    try {
      entries.push(JSON.parse(match[1]) as LibraryEntry)
    } catch {
      continue
    }
  }
  await writeFile(join(modelsDir, 'index.html'), renderLibraryIndex(entries), 'utf8')
  return entries
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const home =
    option(args, '--home') ??
    process.env.WEDNESDAY_BENCHMARK_HOME ??
    join(homedir(), '.wednesday', 'benchmarks', 'public')
  const out =
    option(args, '--out') ??
    join(fileURLToPath(new URL('../../../site/', import.meta.url)), 'scoreboard.html')
  const onlyModel = option(args, '--model')
  const generatedAt = new Date().toISOString()
  const siteDir = fileURLToPath(new URL('../../../site/', import.meta.url))
  // Single shared stylesheet for every generated page (no pasted copies).
  await writeFile(join(siteDir, 'style.css'), sharedStyleCss(), 'utf8')
  if (onlyModel) {
    // One model page + crew pages + rebuilt library index (scans generated pages).
    const { mkdir } = await import('node:fs/promises')
    const modelsDir = join(siteDir, 'models')
    await mkdir(modelsDir, { recursive: true })
    const html = await renderScoreboard(home, generatedAt, onlyModel, '../style.css')
    const pagePath = join(modelsDir, `${modelSlug(onlyModel)}.html`)
    await writeFile(pagePath, html, 'utf8')
    await writeCrewPages(modelsDir, generatedAt)
    const entries = await rebuildLibraryIndex(modelsDir)
    console.log(JSON.stringify({ ok: true, out: pagePath, models: entries.length }))
    return
  }
  const html = await renderScoreboard(home, generatedAt)
  await writeFile(out, html, 'utf8')
  const modelsDir = join(siteDir, 'models')
  await writeCrewPages(modelsDir, generatedAt)
  await rebuildLibraryIndex(modelsDir)
  console.log(JSON.stringify({ ok: true, out }))
}

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('scoreboard.ts')

if (isMain) {
  void main().catch(error => {
    console.error(error)
    process.exitCode = 1
  }).finally(() => {
    process.exit(process.exitCode ?? 0)
  })
}

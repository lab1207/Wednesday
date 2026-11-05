/**
 * Relay scenario catalog (2026-10-16): 100 loops, 60 bad / 40 good.
 *
 * Purpose: know what the race+relay team loop handles and what is still
 * missing to build. Every scenario is executable through the pure core
 * (`relay-scenarios-test.ts`): covered ones assert exact behavior, e2e
 * ones pin the proof file + marker that proves them, gap ones carry a
 * `missing` + `build` note and are reported, never faked green. Counts
 * are locked by the test: 40 good, 60 bad, no dupes.
 *
 * Ids: R-GM (good main) R-GS (good sub) R-BM (bad main) R-BS (bad sub).
 */

import type { FitCapability, ModelScore, RaceLane } from './relay'

export type ScenarioKind = 'good' | 'bad'
export type ScenarioLoop = 'main' | 'sub'

export interface LeaderCheck {
  kind: 'leader'
  lanes: RaceLane[]
  expect: string | null
}

export interface SplitCheck {
  kind: 'split'
  failures: string[]
  maxPieces?: number
  expectCaps: FitCapability[]
  expectMaxTitleLen?: number
}

export interface AssignCheck {
  kind: 'assign'
  pool: string[]
  scores: Record<string, ModelScore>
  caps: FitCapability[]
  expect: string[]
}

export interface PromptCheck {
  kind: 'prompt'
  attempt: number
  expectStrategy: boolean
  expectText?: string
}

export type EnvKnob = 'width' | 'rounds' | 'depth' | 'retries' | 'enabled'

export interface EnvCheck {
  kind: 'env'
  knob: EnvKnob
  env: Record<string, string>
  expect: number | boolean
}

export type TreeOp =
  | { t: 'resolve'; id: string; ok: boolean; answer?: string; expectOk?: boolean }
  | { t: 'expand'; id: string; failures: string[] }
  | { t: 'reopen'; id: string; expect: boolean }

export interface TreeCheck {
  kind: 'tree'
  pool: string[]
  scores: Record<string, ModelScore>
  failures: string[]
  width?: number
  ops: TreeOp[]
  expect: {
    complete: boolean
    open?: string[]
    stuck?: { maxDepth: number; ids: string[] }
    answers?: string[]
    assignees?: Record<string, string>
  }
}

export interface GapMark {
  kind: 'gap'
  missing: string
  build: string
}

export interface E2ECheck {
  kind: 'e2e'
  note: string
  proofs: Array<{ file: string; markers: string[] }>
}

export type ScenarioCheck =
  | LeaderCheck
  | SplitCheck
  | AssignCheck
  | PromptCheck
  | EnvCheck
  | TreeCheck
  | E2ECheck
  | GapMark

export interface RelayScenario {
  id: string
  kind: ScenarioKind
  loop: ScenarioLoop
  title: string
  check: ScenarioCheck
}

/** Full-score helper: only named caps set, rest zero. */
export function S(p: Partial<ModelScore>): ModelScore {
  return { reasoning: 0, coding: 0, vision: 0, review: 0, complete: 0, ...p }
}

const MAX = Number.MAX_SAFE_INTEGER

export const RELAY_SCENARIOS: RelayScenario[] = [
  // ---- GOOD MAIN (20): race + first-level relay behaves. ----
  { id: 'R-GM-01', kind: 'good', loop: 'main', title: 'solo pool takes the piece', check: { kind: 'assign', pool: ['solo'], scores: { solo: S({ coding: 90 }) }, caps: ['coding'], expect: ['solo'] } },
  { id: 'R-GM-02', kind: 'good', loop: 'main', title: 'solo pool takes every piece', check: { kind: 'assign', pool: ['solo'], scores: { solo: S({ reasoning: 90, coding: 90, vision: 90, review: 90, complete: 90 }) }, caps: ['coding', 'vision', 'reasoning'], expect: ['solo', 'solo', 'solo'] } },
  { id: 'R-GM-03', kind: 'good', loop: 'main', title: 'best coder wins the coding piece', check: { kind: 'assign', pool: ['brain', 'hands'], scores: { brain: S({ reasoning: 100 }), hands: S({ coding: 100 }) }, caps: ['coding'], expect: ['hands'] } },
  { id: 'R-GM-04', kind: 'good', loop: 'main', title: 'best brain wins the reasoning piece', check: { kind: 'assign', pool: ['brain', 'hands'], scores: { brain: S({ reasoning: 100 }), hands: S({ coding: 100 }) }, caps: ['reasoning'], expect: ['brain'] } },
  { id: 'R-GM-05', kind: 'good', loop: 'main', title: 'eyes win the vision piece', check: { kind: 'assign', pool: ['hands', 'eyes'], scores: { hands: S({ coding: 100 }), eyes: S({ vision: 100 }) }, caps: ['vision'], expect: ['eyes'] } },
  { id: 'R-GM-06', kind: 'good', loop: 'main', title: 'probe beats the name prior', check: { kind: 'assign', pool: ['coder-x', 'plain'], scores: { plain: S({ coding: 100 }) }, caps: ['coding'], expect: ['plain'] } },
  { id: 'R-GM-07', kind: 'good', loop: 'main', title: 'scoring tie keeps pool order', check: { kind: 'assign', pool: ['a', 'b'], scores: { a: S({ coding: 80 }), b: S({ coding: 80 }) }, caps: ['coding'], expect: ['a'] } },
  { id: 'R-GM-08', kind: 'good', loop: 'main', title: 'no signal anywhere still works every model', check: { kind: 'assign', pool: ['a', 'b', 'c'], scores: {}, caps: ['coding', 'coding', 'coding'], expect: ['a', 'b', 'c'] } },
  { id: 'R-GM-09', kind: 'good', loop: 'main', title: 'empty pool assigns nobody, caller falls back', check: { kind: 'assign', pool: [], scores: {}, caps: ['coding'], expect: [''] } },
  { id: 'R-GM-10', kind: 'good', loop: 'main', title: 'fewest issues leads the race', check: { kind: 'leader', lanes: [{ model: 'm1', issues: 3 }, { model: 'm2', issues: 1 }, { model: 'm3', issues: 2 }], expect: 'm2' } },
  { id: 'R-GM-11', kind: 'good', loop: 'main', title: 'a lone lane leads itself', check: { kind: 'leader', lanes: [{ model: 'solo', issues: 0 }], expect: 'solo' } },
  { id: 'R-GM-12', kind: 'good', loop: 'main', title: 'partial lane beats a wiped-out lane', check: { kind: 'leader', lanes: [{ model: 'bad', issues: MAX }, { model: 'good', issues: 5 }], expect: 'good' } },
  { id: 'R-GM-13', kind: 'good', loop: 'main', title: 'one failure becomes one piece', check: { kind: 'split', failures: ['fix the off-by-one bug'], expectCaps: ['coding'] } },
  { id: 'R-GM-14', kind: 'good', loop: 'main', title: 'blank failures are dropped', check: { kind: 'split', failures: ['   ', '', 'fix the off-by-one bug'], expectCaps: ['coding'] } },
  { id: 'R-GM-15', kind: 'good', loop: 'main', title: 'piece count honors the width cap', check: { kind: 'split', failures: ['a bug', 'b bug', 'c bug', 'd bug', 'e bug', 'f bug'], maxPieces: 4, expectCaps: ['coding', 'coding', 'coding', 'coding'] } },
  { id: 'R-GM-16', kind: 'good', loop: 'main', title: 'first-try prompt is direct', check: { kind: 'prompt', attempt: 1, expectStrategy: false } },
  { id: 'R-GM-17', kind: 'good', loop: 'main', title: 'relay width defaults to 4', check: { kind: 'env', knob: 'width', env: {}, expect: 4 } },
  { id: 'R-GM-18', kind: 'good', loop: 'main', title: 'relay rounds default to 5', check: { kind: 'env', knob: 'rounds', env: {}, expect: 5 } },
  { id: 'R-GM-19', kind: 'good', loop: 'main', title: 'relay depth defaults to 2', check: { kind: 'env', knob: 'depth', env: {}, expect: 2 } },
  { id: 'R-GM-20', kind: 'good', loop: 'main', title: 'relay retries default to 3', check: { kind: 'env', knob: 'retries', env: {}, expect: 3 } },

  // ---- GOOD SUB (20): inner loops solve, share, and stop. ----
  { id: 'R-GS-01', kind: 'good', loop: 'sub', title: 'failed piece reopens then solves on retry', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['fix the bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'reopen', id: 'piece-0', expect: true }, { t: 'resolve', id: 'piece-0', ok: true, answer: 'fixed' }], expect: { complete: true, open: [], answers: ['fixed'] } } },
  { id: 'R-GS-02', kind: 'good', loop: 'sub', title: 'inner expansion solves and bubbles up', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['parent bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['child a bug', 'child b bug'] }, { t: 'resolve', id: 'piece-0.0', ok: true, answer: 'a' }, { t: 'resolve', id: 'piece-0.1', ok: true, answer: 'b' }], expect: { complete: true, open: [], answers: ['a', 'b'] } } },
  { id: 'R-GS-03', kind: 'good', loop: 'sub', title: 'two-level chain solves end to end', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['top bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['mid bug'] }, { t: 'resolve', id: 'piece-0.0', ok: false }, { t: 'expand', id: 'piece-0.0', failures: ['leaf bug'] }, { t: 'resolve', id: 'piece-0.0.0', ok: true, answer: 'deep fix' }], expect: { complete: true, open: [], answers: ['deep fix'] } } },
  { id: 'R-GS-04', kind: 'good', loop: 'sub', title: 'siblings resolve independently', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['a bug', 'b bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: true, answer: 'A' }], expect: { complete: false, open: ['piece-1'] } } },
  { id: 'R-GS-05', kind: 'good', loop: 'sub', title: 'answers collect in piece order', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['a bug', 'b bug', 'c bug'], ops: [{ t: 'resolve', id: 'piece-2', ok: true, answer: 'C' }, { t: 'resolve', id: 'piece-0', ok: true, answer: 'A' }, { t: 'resolve', id: 'piece-1', ok: true, answer: 'B' }], expect: { complete: true, answers: ['A', 'B', 'C'] } } },
  { id: 'R-GS-06', kind: 'good', loop: 'sub', title: 'expanded parent waits, only leaves act', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['p bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['c bug'] }], expect: { complete: false, open: ['piece-0.0'] } } },
  { id: 'R-GS-07', kind: 'good', loop: 'sub', title: 'direct resolve of an expanded parent refuses', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['p bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['c bug'] }, { t: 'resolve', id: 'piece-0', ok: true, answer: 'nope', expectOk: false }], expect: { complete: false, open: ['piece-0.0'] } } },
  { id: 'R-GS-08', kind: 'good', loop: 'sub', title: 'failed leaf below max depth is not stuck', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }], expect: { complete: false, stuck: { maxDepth: 2, ids: [] } } } },
  { id: 'R-GS-09', kind: 'good', loop: 'sub', title: 'reopened piece keeps its assignee', check: { kind: 'tree', pool: ['aa', 'bb'], scores: {}, failures: ['fix the bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'reopen', id: 'piece-0', expect: true }], expect: { complete: false, open: ['piece-0'], assignees: { 'piece-0': 'aa' } } } },
  { id: 'R-GS-10', kind: 'good', loop: 'sub', title: 'third try names its number', check: { kind: 'prompt', attempt: 3, expectStrategy: true, expectText: 'try 3' } },
  { id: 'R-GS-11', kind: 'good', loop: 'sub', title: 'all-zero scores still rotate the crew', check: { kind: 'assign', pool: ['x', 'y'], scores: { x: S({}), y: S({}) }, caps: ['coding', 'coding'], expect: ['x', 'y'] } },
  { id: 'R-GS-12', kind: 'good', loop: 'sub', title: 'scores for absent models are ignored', check: { kind: 'assign', pool: ['a'], scores: { ghost: S({ coding: 100 }) }, caps: ['coding'], expect: ['a'] } },
  { id: 'R-GS-13', kind: 'good', loop: 'sub', title: 'muted-away models simply miss the pool', check: { kind: 'assign', pool: ['a'], scores: {}, caps: ['coding', 'vision'], expect: ['a', 'a'] } },
  { id: 'R-GS-14', kind: 'good', loop: 'sub', title: 'vision keywords route the piece', check: { kind: 'split', failures: ['screenshot clip on mobile', 'hero photo crops badly', 'svg icon missing'], expectCaps: ['vision', 'vision', 'vision'] } },
  { id: 'R-GS-15', kind: 'good', loop: 'sub', title: 'reasoning keywords route the piece', check: { kind: 'split', failures: ['pick a different strategy', 'choose another approach', 'weigh two approaches for the planner'], expectCaps: ['reasoning', 'reasoning', 'reasoning'] } },
  { id: 'R-GS-16', kind: 'good', loop: 'sub', title: 'review keywords route the piece', check: { kind: 'split', failures: ['verify the audit verdict', 'audit the change log', 'check the test output'], expectCaps: ['review', 'review', 'review'] } },
  { id: 'R-GS-17', kind: 'good', loop: 'sub', title: 'completion keywords route the piece', check: { kind: 'split', failures: ['finish the missing handler', 'fill the empty stub', 'complete the adapter'], expectCaps: ['complete', 'complete', 'complete'] } },
  { id: 'R-GS-18', kind: 'good', loop: 'sub', title: 'stack traces default to coding', check: { kind: 'split', failures: ['TypeError: undefined is not a function'], expectCaps: ['coding'] } },
  { id: 'R-GS-19', kind: 'good', loop: 'sub', title: 'retries clamp at ten', check: { kind: 'env', knob: 'retries', env: { FACTORY_RELAY_RETRIES: '99' }, expect: 10 } },
  { id: 'R-GS-20', kind: 'good', loop: 'sub', title: 'zero rounds disables the loop', check: { kind: 'env', knob: 'rounds', env: { FACTORY_RELAY_ROUNDS: '0' }, expect: 0 } },

  // ---- BAD MAIN (30): worst cases at race level. ----
  { id: 'R-BM-01', kind: 'bad', loop: 'main', title: 'total wipeout elects nobody', check: { kind: 'leader', lanes: [{ model: 'a', issues: MAX }, { model: 'b', issues: MAX }], expect: null } },
  { id: 'R-BM-02', kind: 'bad', loop: 'main', title: 'empty race elects nobody', check: { kind: 'leader', lanes: [], expect: null } },
  { id: 'R-BM-03', kind: 'bad', loop: 'main', title: 'empty pool assigns nobody', check: { kind: 'assign', pool: [], scores: {}, caps: ['coding'], expect: [''] } },
  { id: 'R-BM-04', kind: 'bad', loop: 'main', title: 'blank failures produce zero pieces', check: { kind: 'split', failures: ['', '   '], expectCaps: [] } },
  { id: 'R-BM-05', kind: 'bad', loop: 'main', title: 'junk width falls back to 4', check: { kind: 'env', knob: 'width', env: { FACTORY_RELAY_WIDTH: 'junk' }, expect: 4 } },
  { id: 'R-BM-06', kind: 'bad', loop: 'main', title: 'absurd width clamps at 8', check: { kind: 'env', knob: 'width', env: { FACTORY_RELAY_WIDTH: '300' }, expect: 8 } },
  { id: 'R-BM-07', kind: 'bad', loop: 'main', title: 'junk rounds fall back to 5', check: { kind: 'env', knob: 'rounds', env: { FACTORY_RELAY_ROUNDS: 'junk' }, expect: 5 } },
  { id: 'R-BM-08', kind: 'bad', loop: 'main', title: 'junk depth falls back to 2', check: { kind: 'env', knob: 'depth', env: { FACTORY_RELAY_DEPTH: 'junk' }, expect: 2 } },
  { id: 'R-BM-09', kind: 'bad', loop: 'main', title: 'junk retries fall back to 3', check: { kind: 'env', knob: 'retries', env: { FACTORY_RELAY_RETRIES: 'junk' }, expect: 3 } },
  { id: 'R-BM-10', kind: 'bad', loop: 'main', title: 'junk gate value stays off', check: { kind: 'env', knob: 'enabled', env: { FACTORY_RELAY: 'sometimes' }, expect: false } },
  { id: 'R-BM-11', kind: 'bad', loop: 'main', title: 'duplicate pool ids collapse to one', check: { kind: 'assign', pool: ['a', 'a'], scores: {}, caps: ['coding'], expect: ['a'] } },
  { id: 'R-BM-12', kind: 'bad', loop: 'main', title: 'all-zero tie follows pool order, not alpha', check: { kind: 'assign', pool: ['b', 'a'], scores: {}, caps: ['coding'], expect: ['b'] } },
  { id: 'R-BM-13', kind: 'bad', loop: 'main', title: 'single-piece cap holds under flood', check: { kind: 'split', failures: ['a bug', 'b bug', 'c bug'], maxPieces: 1, expectCaps: ['coding'] } },
  { id: 'R-BM-14', kind: 'bad', loop: 'main', title: 'giant failure text truncates to 300', check: { kind: 'split', failures: ['x'.repeat(500)], expectCaps: ['coding'], expectMaxTitleLen: 300 } },
  { id: 'R-BM-15', kind: 'bad', loop: 'main', title: 'duel wipeout enters relay (proven)', check: { kind: 'e2e', note: 'Wipeout failures feed runRelayRound; proven in relay-run-test scenario 4.', proofs: [{ file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BM-15'] }] } },
  { id: 'R-BM-16', kind: 'bad', loop: 'main', title: 'same-file clash merges flagged (proven)', check: { kind: 'e2e', note: 'Last-writer-wins plus a named conflict entry for re-verify; proven in relay-run-test scenario 5 and findMergeConflicts units.', proofs: [{ file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BM-16'] }] } },
  { id: 'R-BM-17', kind: 'bad', loop: 'main', title: 'silent lanes land via diff (proven)', check: { kind: 'e2e', note: 'Lane diff (existence+size+bytes) unions with filesChanged; proven in relay-run-test scenario 5.', proofs: [{ file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BM-17'] }] } },
  { id: 'R-BM-18', kind: 'bad', loop: 'main', title: 'GAP: duplicate failures race twice', check: { kind: 'gap', missing: 'Identical failure strings split into identical pieces and burn two lanes on one fix.', build: 'Dedupe failures before splitRemainder.' } },
  { id: 'R-BM-19', kind: 'bad', loop: 'main', title: 'GAP: lane prompts grow without bound', check: { kind: 'gap', missing: 'The full task objective prepends every leaf prompt on every try; long objectives balloon tokens across leaves x tries.', build: 'Cap lane prompts, page the full text via INPUT_FULL.md like prepareTaskInput.' } },
  { id: 'R-BM-20', kind: 'bad', loop: 'main', title: 'GAP: blind vision assignment', check: { kind: 'gap', missing: 'Without declared model I/O, round-robin can hand image pieces to text-only models and burn a round learning it.', build: 'Hard I/O declaration at connect time (text/image); routing filters before scoring.' } },
  { id: 'R-BM-21', kind: 'bad', loop: 'main', title: 'pins honored on every route (proven)', check: { kind: 'e2e', note: 'selectModel honors preferredModel on local/OpenRouter/NVIDIA/Zen; proven in preferred-model-test.', proofs: [{ file: 'factory/model-router/preferred-model-test.ts', markers: ['e2e R-BM-21'] }] } },
  { id: 'R-BM-22', kind: 'bad', loop: 'main', title: 'GAP: lane dirs can collide', check: { kind: 'gap', missing: 'Relay lane dirs derive from workspace+round only; two concurrent runs on one workspace share and clobber lane dirs.', build: 'Unique per-run suffix (pid/run id) on lane dirs.' } },
  { id: 'R-BM-23', kind: 'bad', loop: 'main', title: 'GAP: pool edits strand running pieces', check: { kind: 'gap', missing: 'The pool re-reads per round but tree assignees go stale; a removed model keeps pieces addressed to it.', build: 'Snapshot the pool per run and reassign live leaves on change.' } },
  { id: 'R-BM-24', kind: 'bad', loop: 'main', title: 'GAP: captain and relay order undefined', check: { kind: 'gap', missing: 'Captain nomination and relay both spend recovery at the ceiling with no defined order; both can fire on one failure.', build: 'Order relay-before-captain (or the reverse) explicitly + execution test.' } },
  { id: 'R-BM-25', kind: 'bad', loop: 'main', title: 'live tree visible in status (proven)', check: { kind: 'e2e', note: 'Per-round snapshots render in wednesday status; proven in relay-status-test.', proofs: [{ file: 'factory/orchestrator/relay-status-test.ts', markers: ['e2e R-BM-25'] }] } },
  { id: 'R-BM-26', kind: 'bad', loop: 'main', title: 'GAP: merge failure has no fault harness', check: { kind: 'gap', missing: 'Per-grade merge containment is implemented but no failing-filesystem harness proves it; the path is green by construction only.', build: 'Fault-injection execution test (read-only workspace, vanishing lane dir).' } },
  { id: 'R-BM-27', kind: 'bad', loop: 'main', title: 'GAP: collected answers unbounded in count', check: { kind: 'gap', missing: 'Each answer caps at 2000 chars but answer count is unbounded; deep wide trees balloon events and prompts.', build: 'Cap total collected answer chars per node.' } },
  { id: 'R-BM-28', kind: 'bad', loop: 'main', title: 'image path exists on local/OpenRouter + red-pixel probe (proven)', check: { kind: 'e2e', note: 'Image parts ride lane prompts on local/OpenRouter; the red-pixel probe grades true image reading. Residual: task attachments and Zen/NVIDIA vision still queued.', proofs: [{ file: 'factory/model-router/model-capabilities-test.ts', markers: ['e2e R-BM-28'] }, { file: 'factory/model-router/providers/chat-test.ts', markers: ['e2e R-BM-28'] }] } },
  { id: 'R-BM-29', kind: 'bad', loop: 'main', title: 'GAP: flaky tests burn tries', check: { kind: 'gap', missing: 'A flaky test command burns piece tries and relay rounds with no flake detection; identical failures on unchanged workspaces count as model failure.', build: 'Suspect-flake rule: same failure twice with byte-identical workspace re-verifies before counting.' } },
  { id: 'R-BM-30', kind: 'bad', loop: 'main', title: 'GAP: no per-piece timeout', check: { kind: 'gap', missing: 'One hung lane holds its whole round until the global host timeout; siblings wait.', build: 'Per-leaf timeout with abort-one; slow leaf fails alone.' } },

  // ---- BAD SUB (30): worst cases inside inner loops. ----
  { id: 'R-BS-01', kind: 'bad', loop: 'sub', title: 'failed leaf at max depth is stuck', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }], expect: { complete: false, stuck: { maxDepth: 1, ids: ['piece-0'] } } } },
  { id: 'R-BS-02', kind: 'bad', loop: 'sub', title: 'depth zero strands the first failure', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }], expect: { complete: false, stuck: { maxDepth: 0, ids: ['piece-0'] } } } },
  { id: 'R-BS-03', kind: 'bad', loop: 'sub', title: 'open leaves are never stuck', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [], expect: { complete: false, open: ['piece-0'], stuck: { maxDepth: 0, ids: [] } } } },
  { id: 'R-BS-04', kind: 'bad', loop: 'sub', title: 'solved leaves are never stuck', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: true, answer: 'done' }], expect: { complete: true, stuck: { maxDepth: 5, ids: [] } } } },
  { id: 'R-BS-05', kind: 'bad', loop: 'sub', title: 'ghost ids resolve and reopen false', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'ghost', ok: true, expectOk: false }, { t: 'reopen', id: 'ghost', expect: false }], expect: { complete: false, open: ['piece-0'] } } },
  { id: 'R-BS-06', kind: 'bad', loop: 'sub', title: 'empty expansion strands the leaf as stuck', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: [] }], expect: { complete: false, open: [], stuck: { maxDepth: 1, ids: ['piece-0'] } } } },
  { id: 'R-BS-07', kind: 'bad', loop: 'sub', title: 'late solve overwrites recorded failure', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'resolve', id: 'piece-0', ok: true, answer: 'late', expectOk: true }], expect: { complete: true, answers: ['late'] } } },
  { id: 'R-BS-08', kind: 'bad', loop: 'sub', title: 'done leaves refuse reopen', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: true, answer: 'd' }, { t: 'reopen', id: 'piece-0', expect: false }], expect: { complete: true } } },
  { id: 'R-BS-09', kind: 'bad', loop: 'sub', title: 'expanded parents refuse reopen', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['x bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['c bug'] }, { t: 'reopen', id: 'piece-0', expect: false }], expect: { complete: false, open: ['piece-0.0'] } } },
  { id: 'R-BS-10', kind: 'bad', loop: 'sub', title: 'nested ids stay unique and dotted', check: { kind: 'tree', pool: ['m1'], scores: {}, failures: ['a bug'], ops: [{ t: 'resolve', id: 'piece-0', ok: false }, { t: 'expand', id: 'piece-0', failures: ['c bug', 'd bug'] }], expect: { complete: false, open: ['piece-0.0', 'piece-0.1'] } } },
  { id: 'R-BS-11', kind: 'bad', loop: 'sub', title: 'GAP: re-expansion orphans children', check: { kind: 'gap', missing: 'A second expandNode on one parent overwrites its children; the first inner loop history survives only in repairAttempts, the tree forgets it.', build: 'Version children per expansion instead of overwriting.' } },
  { id: 'R-BS-12', kind: 'bad', loop: 'sub', title: 'GAP: no per-leaf context budget', check: { kind: 'gap', missing: 'Retries prepend the full objective every try while sibling outputs accumulate; no per-leaf context cap exists.', build: 'Leaf context budget with distill-on-overflow.' } },
  { id: 'R-BS-13', kind: 'bad', loop: 'sub', title: 'GAP: leader identity is generic', check: { kind: 'gap', missing: 'Piece prompts name a generic factory-team leader; the real race winner id is unknown at relay time, so credit and follow-ups miss.', build: 'Thread the race winner id into relay prompts.' } },
  { id: 'R-BS-14', kind: 'bad', loop: 'sub', title: 'relay probes empty registries itself (proven)', check: { kind: 'e2e', note: 'Probe-on-first-relay grades the pool once (red pixel included); proven in relay-run-test scenario 1.', proofs: [{ file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BS-14'] }] } },
  { id: 'R-BS-15', kind: 'bad', loop: 'sub', title: 'landing round verifies solo, never re-duels (proven)', check: { kind: 'e2e', note: 'relayForceSolo calms the round after a landing; proven in relay-run-test scenario 4 (exactly one duel).', proofs: [{ file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BS-15'] }] } },
  { id: 'R-BS-16', kind: 'bad', loop: 'sub', title: 'GAP: tree dies with the process', check: { kind: 'gap', missing: 'The relay tree lives in the run closure; abort or restart loses loop position and retry counts.', build: 'Persist tree snapshots to the event bus.' } },
  { id: 'R-BS-17', kind: 'bad', loop: 'sub', title: 'GAP: inner tries share outer numbers', check: { kind: 'gap', missing: 'Inner-loop attempts reuse the outer repair attempt number; per-level accounting is absent, so history cannot tell round 2 from round 2.1.', build: 'Dotted attempt numbers per tree depth.' } },
  { id: 'R-BS-18', kind: 'bad', loop: 'sub', title: 'GAP: quiet models can starve', check: { kind: 'gap', missing: 'Best-wins plus round-robin ties can starve a mid-tier model forever; nothing guarantees every audible model attempts within K rounds.', build: 'Fairness floor for audible models.' } },
  { id: 'R-BS-19', kind: 'bad', loop: 'sub', title: 'GAP: text probe stands in for image skill', check: { kind: 'gap', missing: 'The vision text probe separates willing describers from refusers but never tests image reading; incapable models pass and fail later in lanes.', build: 'Real image probe over the VL input path.' } },
  { id: 'R-BS-20', kind: 'bad', loop: 'sub', title: 'GAP: completion skill is keyword-orphaned', check: { kind: 'gap', missing: 'The completer capability is guessed only from finish/fill/complete words; most completion-shaped work arrives labeled coding and never finds its best model.', build: 'Completion-need detector (missing-file + partial-write shapes).' } },
  { id: 'R-BS-21', kind: 'bad', loop: 'sub', title: 'GAP: solved outputs flood next prompts', check: { kind: 'gap', missing: 'Every solved lane output pushes into main outputs and feeds the next coder prompt; large crews flood context with redundant evidence.', build: 'Distill solved lane outputs before pushing.' } },
  { id: 'R-BS-22', kind: 'bad', loop: 'sub', title: 'GAP: total leaves unbounded', check: { kind: 'gap', missing: 'Width caps pieces per expansion but total leaves across nesting multiply (4 x 4 x 4); no cap exists on the whole tree.', build: 'Cap total open leaves per run.' } },
  { id: 'R-BS-23', kind: 'bad', loop: 'sub', title: 'GAP: solo pools retry instead of splitting', check: { kind: 'gap', missing: 'A one-model pool burns all retries on one failing piece with only wording changes before ever splitting inward.', build: 'Early-expand for solo pools (split sooner when the pool holds one model).' } },
  { id: 'R-BS-24', kind: 'bad', loop: 'sub', title: 'GAP: pieces assumed independent', check: { kind: 'gap', missing: 'Pieces merge in index order with no dependency model; a piece depending on a sibling file merged later in the same round breaks.', build: 'Dependency order for merge, or sequential rounds for dependent pieces.' } },
  { id: 'R-BS-25', kind: 'bad', loop: 'sub', title: 'GAP: lanes run full test suites', check: { kind: 'gap', missing: 'Every lane tester runs the whole suite including slow integration tests, per lane per round; lane grading needs only the piece-relevant checks.', build: 'Piece-scoped test selection for lane grading.' } },
  { id: 'R-BS-26', kind: 'bad', loop: 'sub', title: 'GAP: reviewer never sees relay history', check: { kind: 'gap', missing: 'The reviewer judges merged evidence without knowing who solved what, how many tries it took, or what is still relay-open.', build: 'Relay summary section in the review prompt.' } },
  { id: 'R-BS-27', kind: 'bad', loop: 'sub', title: 'stuck leaves surface in status (proven)', check: { kind: 'e2e', note: 'Stuck ids flag in the status relay line; proven in relay-status-test.', proofs: [{ file: 'factory/orchestrator/relay-status-test.ts', markers: ['e2e R-BS-27'] }] } },
  { id: 'R-BS-28', kind: 'bad', loop: 'sub', title: 'GAP: one brain plans every split', check: { kind: 'gap', missing: 'The remainder splits by failure string, one per piece, with no competing split; a bad split dooms every lane.', build: 'Duel the split itself: two splitters propose, tester-grade the piece sets.' } },
  { id: 'R-BS-29', kind: 'bad', loop: 'sub', title: 'relay wins teach the router (proven)', check: { kind: 'e2e', note: 'Win-rate memory folds into fit scores (capped, floored); proven in relay-memory-test and relay-run-test scenario 1.', proofs: [{ file: 'factory/orchestrator/relay-memory-test.ts', markers: ['RELAY MEMORY TEST: PASS'] }, { file: 'factory/orchestrator/relay-run-test.ts', markers: ['e2e R-BS-29'] }] } },
  { id: 'R-BS-30', kind: 'bad', loop: 'sub', title: 'GAP: unlimited ceiling ignores relay cap', check: { kind: 'gap', missing: 'FACTORY_MAX_REPAIR_ATTEMPTS=unlimited never exhausts, but relay rounds still cap at 10; the never-stop mode stops teaming early.', build: 'Relay rounds follow unlimited mode (cap off when the ceiling is off).' } },
]

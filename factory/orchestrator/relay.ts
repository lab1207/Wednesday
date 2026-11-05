/**
 * Relay — race+relay loop core (2026-10-16): from winner-takes-all to teamwork.
 *
 * Race (duel, built) finds the leader: every connected model attempts the
 * same task and the tester grades each lane. Relay (this file) uses the
 * whole crew: the leader's remainder (blocking issues / required changes)
 * splits into pieces, each piece goes to the best-fit pool model, pieces
 * solve simultaneously, and a failed piece re-races across all models
 * (race inside race) until every piece verifies or the ceiling hits.
 * Leadership rotates per task and per round — whoever scores best leads.
 *
 * 1..N pools: solo (one model) assigns every piece to it; N models spread
 * by skill with load balancing. Empty pool assigns nobody (assignee '')
 * so the caller keeps its legacy fallback.
 *
 * Pure + offline-green: no runners, no network, no filesystem. Execution
 * (lanes run pieces, merge, loop until done) wires in next, on top of
 * these exact functions.
 */

import type {
  FitCapability,
  ModelScore,
  PoolModel,
} from '../model-router/model-capabilities'

import { effectiveScores } from '../model-router/model-cards'

/** One race lane graded by the tester (issues = blocking-issue count). */
export interface RaceLane {
  model: string
  issues: number
  note?: string
}

/** Ranked best-first (fewest issues). Stable: ties keep lane order. */
export function rankRace(lanes: RaceLane[]): RaceLane[] {
  return lanes
    .map((lane, index) => ({ lane, index }))
    .sort(
      (a, b) => a.lane.issues - b.lane.issues || a.index - b.index,
    )
    .map(entry => entry.lane)
}

/**
 * Leader election (pure): the best lane leads. Null on total wipeout
 * (every lane failed outright) or no lanes — nothing to relay from,
 * the caller falls back to plain repair.
 */
export function electLeader(ranked: RaceLane[]): RaceLane | null {
  if (ranked.length === 0) return null
  const best = ranked[0]!
  // Wipeout lanes carry Number.MAX_SAFE_INTEGER (finite but total) —
  // no leader, the caller falls back to plain repair.
  if (best.issues >= Number.MAX_SAFE_INTEGER) return null
  return best
}

/** Guess which skill a remainder item needs (pure keyword scan). */
export function guessCapability(text: string): FitCapability {
  const lower = text.toLowerCase()
  if (
    /(image|screenshot|\.png\b|\.jpe?g\b|\.gif\b|\.webp\b|\.svg\b|picture|photo|pixel|mockup|diagram|chart|vision|layout|design|icon)/.test(
      lower,
    )
  ) {
    return 'vision'
  }
  if (/(plan|architect|strategy|strategies|design the|approach)/.test(lower)) {
    return 'reasoning'
  }
  if (/(review|check|verify|audit|verdict)/.test(lower)) {
    return 'review'
  }
  if (/\bcomplete\b|\bfinish\b|\bfill\b/.test(lower)) {
    return 'complete'
  }
  return 'coding'
}

export interface RelayPieceDraft {
  id: string
  title: string
  capability: FitCapability
}

export interface RelayPiece extends RelayPieceDraft {
  /** Pool model id, or '' when the pool is empty (caller falls back). */
  assignee: string
}

/**
 * Split the remainder (pure): one failure string becomes one piece,
 * capped at maxPieces. Empties dropped, titles trimmed to 300 chars
 * (same bound as ballot findings).
 */
export function splitRemainder(
  failures: string[],
  maxPieces = 4,
): RelayPieceDraft[] {
  const cap =
    Number.isInteger(maxPieces) && maxPieces >= 1
      ? Math.min(maxPieces, 8)
      : 4
  const out: RelayPieceDraft[] = []
  for (const failure of failures) {
    const title = failure.trim().slice(0, 300)
    if (!title) continue
    if (out.length >= cap) break
    out.push({
      id: `piece-${out.length}`,
      title,
      capability: guessCapability(title),
    })
  }
  return out
}

/**
 * Assign pieces to the pool (pure): best scorer per piece capability
 * wins (probe first, name prior fills zeros via effectiveScores); ties
 * spread by fewest-load then pool order, so N models all work. No
 * signal at all (or empty pool) round-robins — or '' when there is no
 * pool to rotate over. One model takes everything; that is the solo
 * shape, byte-identical in behavior.
 */
export function assignPieces(
  drafts: RelayPieceDraft[],
  pool: PoolModel[],
  scores: Record<string, ModelScore>,
): RelayPiece[] {
  if (pool.length === 0) {
    return drafts.map(draft => ({ ...draft, assignee: '' }))
  }
  const eff = effectiveScores(
    pool.map(model => model.id),
    scores,
  )
  const load = new Map<string, number>()
  return drafts.map((draft, pieceIndex) => {
    let best = ''
    let bestScore = -1
    for (const model of pool) {
      const score = eff[model.id]?.[draft.capability] ?? 0
      const used = load.get(model.id) ?? 0
      const bestUsed = best ? (load.get(best) ?? 0) : 0
      if (
        score > bestScore ||
        (score === bestScore && used < bestUsed)
      ) {
        bestScore = score
        best = model.id
      }
    }
    const assignee =
      bestScore > 0 ? best : pool[pieceIndex % pool.length]!.id
    load.set(assignee, (load.get(assignee) ?? 0) + 1)
    return { ...draft, assignee }
  })
}

/**
 * Piece sub-task prompt (pure): the assignee gets the leader's context
 * plus exactly its piece — a race-inside-race attempt, not the whole task.
 * Try 2+ orders a different approach (same ladder as repair escalation:
 * repeating a failed approach fails identically).
 */
export function relayPiecePrompt(
  piece: RelayPieceDraft,
  leaderModel: string,
  leaderNote: string,
  attempt = 1,
): string {
  const lines = [
    `RELAY PIECE ${piece.id} (leader ${leaderModel}: ${leaderNote}).`,
    'Solve ONLY this piece. Do not rewrite the whole task.',
    '',
    `PIECE: ${piece.title}`,
  ]
  if (Number.isInteger(attempt) && attempt >= 2) {
    lines.push(
      '',
      `STRATEGY CHANGE (try ${attempt}): do not repeat the last approach.`,
      'Pick a different strategy and state the switch in one line.',
    )
  }
  return lines.join('\n')
}

export interface PieceResult {
  pieceId: string
  blockingIssues: string[]
}

/** Open piece ids (pure): pieces with no clean result yet. */
export function openPieces(
  pieces: RelayPieceDraft[],
  results: PieceResult[],
): string[] {
  const clean = new Set<string>()
  for (const result of results) {
    if (result.blockingIssues.length === 0) clean.add(result.pieceId)
  }
  return pieces
    .map(piece => piece.id)
    .filter(id => !clean.has(id))
}

/** Relay round is done when every piece has a clean result. */
export function relayComplete(
  pieces: RelayPieceDraft[],
  results: PieceResult[],
): boolean {
  if (pieces.length === 0) return true
  return openPieces(pieces, results).length === 0
}

/** Relay width (pure): pieces per round, env-clamped 1-8, default 4. */
export function resolveRelayWidth(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(String(env.FACTORY_RELAY_WIDTH ?? '').trim() || 'NaN')
  if (Number.isInteger(raw)) return Math.min(Math.max(raw, 1), 8)
  return 4
}

/** Relay rounds (pure): race+relay loops until done, env-clamped 0-10. */
export function resolveRelayMaxRounds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(String(env.FACTORY_RELAY_ROUNDS ?? '').trim() || 'NaN')
  if (Number.isInteger(raw)) return Math.min(Math.max(raw, 0), 10)
  return 5
}

/**
 * Relay retries (pure): tries per piece with escalating approaches
 * before it splits inward, env-clamped 1-10, default 3.
 */
export function resolveRelayRetries(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(String(env.FACTORY_RELAY_RETRIES ?? '').trim() || 'NaN')
  if (Number.isInteger(raw)) return Math.min(Math.max(raw, 1), 10)
  return 3
}

/**
 * Recursive relay tree (2026-10-16): loops inside loops.
 *
 * A failed piece is not the end — it becomes a parent: it re-splits and
 * its children race again (race inside race). A solved leaf breaks out:
 * its answer bubbles up, and when all siblings are done the parent is
 * done too, sharing the combined answer with the factory. Depth caps
 * the nesting; a failed leaf at max depth is stuck and surfaces to the
 * plain repair path instead of looping forever.
 *
 * Execution policy (wiring slice, not here): an open leaf races across
 * the pool with its piece prompt; solved → resolveNode done + bubbleUp;
 * failed + depth < max → expandNode; failed at max → stuck.
 */

export type RelayStatus = 'open' | 'done' | 'failed'

export interface RelayNode {
  id: string
  title: string
  capability: FitCapability
  assignee: string
  depth: number
  status: RelayStatus
  children: RelayNode[]
  answer?: string
}

/** Root task node (pure): depth 0, unassigned, children arrive from split. */
export function makeRelayRoot(title: string): RelayNode {
  return {
    id: 'root',
    title: title.trim().slice(0, 300),
    capability: 'coding',
    assignee: '',
    depth: 0,
    status: 'open',
    children: [],
  }
}

export function pieceToNode(piece: RelayPiece, depth = 0): RelayNode {
  return {
    id: piece.id,
    title: piece.title,
    capability: piece.capability,
    assignee: piece.assignee,
    depth,
    status: 'open',
    children: [],
  }
}

/**
 * Expand a failed node (pure): its failures re-split and re-assign
 * across the pool — the race inside the race. Children keep dotted
 * ids (`piece-1.0`) so every loop level stays addressable. The parent
 * stays open until its children resolve.
 */
export function expandNode(
  node: RelayNode,
  failures: string[],
  pool: PoolModel[],
  scores: Record<string, ModelScore>,
  maxPieces = 4,
): RelayNode {
  const assigned = assignPieces(
    splitRemainder(failures, maxPieces),
    pool,
    scores,
  )
  node.children = assigned.map((piece, index) =>
    pieceToNode({ ...piece, id: `${node.id}.${index}` }, node.depth + 1),
  )
  return node
}

/** Find a node by id (pure DFS), null when absent. */
export function findNode(root: RelayNode, id: string): RelayNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}

/**
 * Resolve a leaf (pure): only childless nodes resolve — a parent's
 * status comes from bubbleUp, never direct. False when missing or
 * already expanded.
 */
export function resolveNode(
  root: RelayNode,
  id: string,
  ok: boolean,
  answer?: string,
): boolean {
  const node = findNode(root, id)
  if (!node || node.children.length > 0) return false
  node.status = ok ? 'done' : 'failed'
  // Answers are evidence, not storage: cap keeps one giant lane reply
  // from bloating the tree (execution slices tighter at 1000).
  if (ok && answer !== undefined) node.answer = answer.slice(0, 2000)
  return true
}

/** Actionable units (pure): open leaves only — expanded parents wait. */
export function openLeaves(root: RelayNode): RelayNode[] {
  if (root.children.length === 0) {
    return root.status === 'open' ? [root] : []
  }
  return root.children.flatMap(openLeaves)
}

export interface TreeSummary {
  open: string[]
  done: string[]
  failed: string[]
}

/** Leaf census (pure): ids by status, for operator snapshots. */
export function summarizeTree(root: RelayNode): TreeSummary {
  const all: RelayNode[] = []
  const walk = (node: RelayNode): void => {
    if (node.children.length === 0) {
      all.push(node)
      return
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return {
    open: all.filter(n => n.status === 'open').map(n => n.id),
    done: all.filter(n => n.status === 'done').map(n => n.id),
    failed: all.filter(n => n.status === 'failed').map(n => n.id),
  }
}

/** Solved-leaf answers under a node (pure): what the parent shares up. */
export function collectAnswers(node: RelayNode): string[] {
  if (node.children.length === 0) {
    return node.status === 'done' && node.answer !== undefined
      ? [node.answer]
      : []
  }
  return node.children.flatMap(collectAnswers)
}

/**
 * Bubble-up (pure, post-order): a node with children is done when every
 * child subtree is done — the loop breaks and the answer is shared up.
 * A childless node keeps its own status. Returns true when done.
 */
export function bubbleUp(node: RelayNode): boolean {
  if (node.children.length === 0) return node.status === 'done'
  const kidsDone = node.children.map(bubbleUp)
  if (kidsDone.every(Boolean)) node.status = 'done'
  return node.status === 'done'
}

/** Whole tree solved (pure): bubble first, then read the root. */
export function relayTreeComplete(root: RelayNode): boolean {
  return bubbleUp(root)
}

/**
 * Stuck leaves (pure): failed leaves at/over max depth cannot expand
 * further — they surface to the plain repair path. Failed leaves below
 * max depth are not stuck: they still own another inner loop.
 */
export function stuckLeaves(root: RelayNode, maxDepth: number): RelayNode[] {
  if (root.children.length === 0) {
    return root.status === 'failed' && root.depth >= maxDepth ? [root] : []
  }
  return root.children.flatMap(child => stuckLeaves(child, maxDepth))
}

export interface MergeConflict {
  file: string
  pieces: string[]
}

/**
 * Merge conflicts (pure): files touched by more than one solved lane.
 * The merge still lands in piece order (last writer wins), but the
 * clash is named so the next round re-verifies the merged file instead
 * of trusting it silently.
 */
export function findMergeConflicts(
  lanes: Array<{ id: string; files: string[] }>,
): MergeConflict[] {
  const byFile = new Map<string, string[]>()
  for (const lane of lanes) {
    const seen = new Set<string>()
    for (const file of lane.files) {
      if (seen.has(file)) continue
      seen.add(file)
      const owners = byFile.get(file) ?? []
      if (!owners.includes(lane.id)) owners.push(lane.id)
      byFile.set(file, owners)
    }
  }
  const out: MergeConflict[] = []
  for (const [file, pieces] of byFile) {
    if (pieces.length > 1) out.push({ file, pieces })
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return out
}

/**
 * Relay probing gate (pure): probe-on-first-relay defaults on (the team
 * loop earns its routing); `FACTORY_RELAY_PROBE=0` keeps pure
 * round-robin for zero-spend runs.
 */
export function resolveRelayProbeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.FACTORY_RELAY_PROBE ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  return true
}

/** Relay execution gate (pure): explicit opt-in, default off — locked behavior byte-identical. */export function resolveRelayEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.FACTORY_RELAY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * Reopen a failed leaf (pure): a piece with tries left goes again next
 * round with an escalated approach instead of splitting inward yet.
 * False unless the node is a failed, childless leaf.
 */
export function reopenNode(root: RelayNode, id: string): boolean {
  const node = findNode(root, id)
  if (!node || node.children.length > 0 || node.status !== 'failed') {
    return false
  }
  node.status = 'open'
  return true
}

/** Relay depth (pure): nesting cap, env-clamped 0-5, default 2. */
export function resolveRelayDepth(  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(String(env.FACTORY_RELAY_DEPTH ?? '').trim() || 'NaN')
  if (Number.isInteger(raw)) return Math.min(Math.max(raw, 0), 5)
  return 2
}

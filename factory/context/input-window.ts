/**
 * Oversized task-input handling — the Factory's unlimited context window
 * (2026-09-22, user direction: never fail with "too big prompt").
 *
 * Problem: the local 3B window is ~13K tokens. A 70K-token user prompt
 * used to die with `exceed_context_size_error` (u90k lesson) or get
 * silently truncated by the knowledge cap — content lost either way.
 *
 * Shape (thin-plugin law): the plugin only SPLITS (mechanical,
 * boundary-aware chunks with overlap) and SAVES (full input lands in
 * `INPUT_FULL.md` inside the task workspace so the coder pages it with
 * the normal read tool). The MODEL does all understanding: one extract
 * call per chunk (map) + one merge call (reduce) through the existing
 * router — budgeted model calls, no new keys, no new infra. Spend shows
 * up in the standard usage registry so existing budget guards see it.
 *
 * Failure policy: distill problems never break a run. If the model
 * calls fail, the task proceeds with a head-truncated objective plus a
 * marker (today's behavior) — degraded, never worse than before.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INPUT_FULL_FILENAME = 'INPUT_FULL.md'

const DEFAULT_MAX_INPUT_TOKENS = 10000
const DEFAULT_MAX_CHUNKS = 32
const CHUNK_OVERLAP_CHARS = 200

/** Rough token estimate (chars/4) — mechanical, documented, no LLM. */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface InputBudget {
  maxInputTokens: number
  maxChunks: number
}

/**
 * Working budget for one task input. Zero is a valid explicit cap
 * (everything distills); unset/invalid/negative falls back to the
 * guarded defaults so a typo can never disable the gate or distill
 * the whole world in one call.
 */
export function resolveInputBudget(
  env: NodeJS.ProcessEnv = process.env,
): InputBudget {
  const rawTokens = env.FACTORY_MAX_INPUT_TOKENS?.trim() || ''
  const rawChunks = env.FACTORY_MAX_INPUT_CHUNKS?.trim() || ''
  const tokens = rawTokens === '' ? Number.NaN : Number(rawTokens)
  const chunks = rawChunks === '' ? Number.NaN : Number(rawChunks)
  return {
    maxInputTokens:
      Number.isFinite(tokens) && tokens >= 0
        ? Math.floor(tokens)
        : DEFAULT_MAX_INPUT_TOKENS,
    maxChunks:
      Number.isFinite(chunks) && chunks >= 1
        ? Math.floor(chunks)
        : DEFAULT_MAX_CHUNKS,
  }
}

/** Pure gate: does this input need the split-and-distill path? */
export function needsDistill(
  text: string,
  budget?: InputBudget,
): boolean {
  const cap = budget?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS
  return estimateInputTokens(text) > cap
}

/**
 * Boundary-aware mechanical split (pure): prefers paragraph breaks,
 * then line breaks, then sentence ends, then hard cuts. Each chunk
 * carries `overlap` trailing chars of context (except the first) so
 * requirements spanning a boundary survive. Hard-capped at maxChunks
 * (head chunks win) so a gigabyte of input cannot fan out unbounded.
 */
export function splitIntoChunks(
  text: string,
  maxChars: number,
  overlap = CHUNK_OVERLAP_CHARS,
  maxChunks: number = DEFAULT_MAX_CHUNKS,
): string[] {
  const cap = Math.max(1, Math.floor(maxChunks))
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length && chunks.length < cap) {
    let end = Math.min(start + maxChars, text.length)
    if (end < text.length) {
      const window = text.slice(start, end)
      const para = window.lastIndexOf('\n\n')
      const line = window.lastIndexOf('\n')
      const sent = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! '),
      )
      const cut =
        para > maxChars * 0.4
          ? start + para
          : line > maxChars * 0.4
            ? start + line
            : sent > maxChars * 0.4
              ? start + sent + 1
              : end
      end = Math.min(cut, text.length - 1)
      if (end <= start) end = Math.min(start + maxChars, text.length)
    }
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

export interface DistillResponder {
  (prompt: string): Promise<string>
}

export interface PreparedInput {
  brief: string
  chunks: number
  mapCalls: number
  truncated: boolean
}

const MAP_CAP = 1500
const BRIEF_CAP = 8000

/**
 * Map-reduce distill (model reasons, plugin only splits): each chunk is
 * reduced to its key requirements (map), then the extracts merge into
 * one working brief that fits the budget (reduce). Every string is
 * mechanically capped; a failing model call throws to the caller, which
 * applies the truncation fallback.
 */
export async function distillInput(
  text: string,
  responder: DistillResponder,
  budget?: InputBudget,
): Promise<PreparedInput> {
  const cap = budget ?? resolveInputBudget()
  const maxChars = Math.max(500, cap.maxInputTokens * 4)
  const chunks = splitIntoChunks(text, maxChars, CHUNK_OVERLAP_CHARS, cap.maxChunks)
  const truncated = estimateInputTokens(text) > cap.maxChunks * maxChars / 4
  const extracts: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const raw = await responder(
      [
        'Extract the build requirements from this input section.',
        'Return ONLY a bulleted list of concrete requirements, constraints, and acceptance criteria.',
        'No preamble, no explanation, no questions.',
        '',
        `SECTION ${i + 1}/${chunks.length}:`,
        chunks[i],
      ].join('\n'),
    )
    extracts.push(
      raw.length <= MAP_CAP
        ? raw
        : `${raw.slice(0, MAP_CAP)}\n[truncated]`,
    )
  }
  const merged = await responder(
    [
      'Merge these per-section requirement lists into ONE working brief for an engineer.',
      'Deduplicate. Keep every distinct requirement. Cap the brief at roughly 6000 characters.',
      'Return ONLY the brief, no preamble.',
      '',
      extracts
        .map((extract, i) => `--- SECTION ${i + 1} ---\n${extract}`)
        .join('\n\n'),
    ].join('\n'),
  )
  const brief =
    merged.length <= BRIEF_CAP
      ? merged
      : `${merged.slice(0, BRIEF_CAP)}\n\n[truncated]`
  return { brief, chunks: chunks.length, mapCalls: extracts.length, truncated }
}

/** Full task-input text that the budget applies to. */
export function taskInputText(task: {
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
}): string {
  return [
    task.objective,
    ...(task.constraints ?? []),
    ...(task.acceptanceCriteria ?? []),
  ]
    .filter(Boolean)
    .join('\n')
}

export interface PrepareResult<Task> {
  task: Task
  distilled: boolean
  chunks: number
  fallback: boolean
}

/**
 * Service-level pre-pass: fits → untouched; oversized → full input saved
 * to `<workspace>/INPUT_FULL.md`, objective replaced by the distilled
 * brief plus a pointer the coder can page through. Model failure →
 * head-truncation fallback with a marker. Never throws.
 */
export async function prepareTaskInput<Task extends {
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  workspace: string
}>(
  task: Task,
  responder: DistillResponder,
  budget?: InputBudget,
): Promise<PrepareResult<Task>> {
  const cap = budget ?? resolveInputBudget()
  const full = taskInputText(task)
  if (!needsDistill(full, cap)) {
    return { task, distilled: false, chunks: 0, fallback: false }
  }
  try {
    mkdirSync(task.workspace, { recursive: true })
    writeFileSync(
      join(task.workspace, INPUT_FULL_FILENAME),
      `# Full task input (original, unabridged)\n\n${full}\n`,
      'utf8',
    )
    const { brief, chunks, truncated } = await distillInput(
      full,
      responder,
      cap,
    )
    return {
      task: {
        ...task,
        objective: [
          brief,
          '',
          `Full input: ${INPUT_FULL_FILENAME} in the workspace — read it in sections as needed.`,
          truncated
            ? 'Note: input exceeded the chunk cap; the brief covers the head chunks.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      distilled: true,
      chunks,
      fallback: false,
    }
  } catch {
    const maxChars = Math.max(500, cap.maxInputTokens * 4)
    return {
      task: {
        ...task,
        objective: `${task.objective.slice(0, maxChars)}\n\n[truncated ${
          Math.max(0, task.objective.length - maxChars)
        } characters: input exceeded the working budget and distill was unavailable]`,
      },
      distilled: false,
      chunks: 0,
      fallback: true,
    }
  }
}

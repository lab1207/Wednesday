/**
 * A better token estimate than chars/4 (2026-11-05).
 *
 * The old approximation counted 4 characters per token for everything. That
 * is about right for English prose and badly wrong for code and JSON, which
 * run closer to 3 characters per token. The error always points the dangerous
 * way: the factory believed a 20K-character code prompt was 5K tokens, sent
 * it to a model with a 13K window, and the server answered with silent
 * head-truncation. The operator reads that as "the model ignored half the
 * instructions"; it is really the factory lying about the size.
 *
 * So: measure the code density of the text and blend between the prose ratio
 * (~4 chars/token) and the code ratio (~3 chars/token). Pure prose keeps the
 * old number (backwards compatible), code is charged honestly, and a mixed
 * prompt lands between the two instead of guessing one or the other.
 *
 * Pure, deterministic, no deps. It is still an estimate, not a tokenizer: it
 * refuses to be more precise than the evidence allows.
 */

import { tokenizerFamilyFor } from './model-registry'
import type { TokenizerFamily } from './model-registry'

/** Characters per token, by content kind, per tokenizer family. */
interface FamilyRatios {
  /** Code and JSON: denser, fewer characters per token. */
  code: number
  /** English prose: about four characters per token. */
  prose: number
}

const FAMILY_RATIOS: Record<TokenizerFamily, FamilyRatios> = {
  qwen: { code: 3.0, prose: 4.0 },
  llama: { code: 3.0, prose: 3.8 },
  gemma: { code: 3.1, prose: 4.1 },
  mistral: { code: 3.0, prose: 4.0 },
  deepseek: { code: 3.0, prose: 4.0 },
  generic: { code: 3.0, prose: 4.0 },
}

/**
 * How fast the code score saturates. A text with 4% code signals per
 * character is already mostly code; 1% is a light sprinkle.
 */
const SATURATION = 25

/** Words that only show up in code. Counted at double weight. */
const CODE_KEYWORDS = [
  'function',
  'import',
  'export',
  'class',
  'const ',
  'let ',
  'var ',
  'def ',
  'return',
  'async ',
  'await ',
  'elif ',
  'catch',
]

function countChar(text: string, ch: string): number {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ch) total += 1
  }
  return total
}

function countSequence(text: string, needle: string): number {
  let total = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    total += 1
    from = at + needle.length
  }
  return total
}

/** Lines that start with a real indentation run: code, not wrapped prose. */
function indentationRuns(text: string): number {
  let runs = 0
  for (const line of text.split('\n')) {
    if (/^[ \t]{2,}/.test(line)) runs += 1
  }
  return runs
}

/** Weighted count of the signals that say "this is code". */
function codeSignals(text: string): number {
  let signals = 0
  signals += countChar(text, '{')
  signals += countChar(text, '}')
  signals += countChar(text, '[')
  signals += countChar(text, ']')
  signals += countChar(text, ';')
  signals += countChar(text, '(')
  signals += countChar(text, ')')
  signals += 2 * countSequence(text, '=>')
  const lower = text.toLowerCase()
  for (const keyword of CODE_KEYWORDS) {
    signals += 2 * countSequence(lower, keyword)
  }
  signals += indentationRuns(text)
  return signals
}

/**
 * The code score of a text: 0 for prose, 1 for code, smoothly in between.
 * Saturating (not a step function) so a mixed prompt is charged for the
 * share of it that is code.
 */
function codeScore(text: string): number {
  if (text.length === 0) return 0
  const signals = codeSignals(text)
  if (signals === 0) return 0
  const perChar = signals / text.length
  return 1 - Math.exp(-SATURATION * perChar)
}

/**
 * Estimated tokens for a string.
 *
 * - Empty text is 0 tokens.
 * - Non-empty text is never below 1 token.
 * - Plain prose keeps the old approximation (about 4 characters per token).
 * - Code and JSON are charged at about 3 characters per token, so a code
 *   prompt is never believed to fit when it does not.
 */
export function estimateTokens(text: string, family: TokenizerFamily = 'generic'): number {
  if (text.length === 0) return 0
  const ratios = FAMILY_RATIOS[family] ?? FAMILY_RATIOS.generic
  const score = codeScore(text)
  const charsPerToken = ratios.prose + (ratios.code - ratios.prose) * score
  return Math.max(1, Math.ceil(text.length / charsPerToken))
}

/** Estimated tokens for a string, charged to the model's own tokenizer. */
export function estimateTokensForModel(text: string, modelId: string): number {
  return estimateTokens(text, tokenizerFamilyFor(modelId))
}

/**
 * Estimated tokens for a conversation: the sum of its messages.
 *
 * The per-message framing overhead (role and delimiters) is deliberately
 * NOT counted here, exactly like the existing budget code, so the two
 * estimators never disagree about the same conversation.
 */
export function estimateMessagesTokens(
  messages: Array<{ content: string }>,
  family: TokenizerFamily = 'generic',
): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokens(message.content, family)
  }
  return total
}

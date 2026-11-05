/**
 * Intent router (2026-10-30, chunk 4 of the results-first direction).
 *
 * The referee for "prompt -> result": a QUESTION is a conversation turn
 * (chat loop, streamed, remembered); WORK is a build (approval gate ->
 * factory pipeline -> real verification -> receipt). The old gate was two
 * crude counters (word count + a greeting regex), so real questions like
 * "explain how the router works" fell into the build pipeline and real
 * work like "do the thing" fell into chat.
 *
 * Golden rule: BUILD signals win, chat is the default that remains — a
 * mistaken build still costs only one denied approval card, but a mistaken
 * chat silently answers "ok" and builds nothing (2026-10-31 fix follow-up:
 * both directions now have receipts). Pure and offline: zero model calls.
 *
 * Rule order (first hit wins):
 *  1. Leading interrogative ("what is X", "how do I X", "why does X")
 *     -> chat. A question is a question even when it contains verbs.
 *  2. Explicit build signals -> build: an imperative verb, the polite
 *     wrappers ("can you fix…", "please add…"), code markers (backticks,
 *     file extensions, braces/parens), quoted strings.
 *  3. Everything else -> chat (greetings, smalltalk, statements, opinions).
 */

/** Imperative verbs that unambiguously ask the factory to DO something. */
const BUILD_VERBS: ReadonlySet<string> = new Set([
  'build', 'add', 'create', 'make', 'fix', 'repair', 'refactor', 'implement',
  'write', 'generate', 'remove', 'delete', 'drop', 'update', 'upgrade',
  'install', 'uninstall', 'run', 'execute', 'test', 'deploy', 'migrate',
  'rename', 'move', 'copy', 'split', 'extract', 'merge', 'patch', 'optimize',
  'clean', 'cleanup', 'debug', 'port', 'rewrite', 'scaffold', 'integrate',
  'configure', 'replace', 'convert', 'extend', 'wire', 'bump', 'lint',
  'format', 'compile', 'bundle', 'do', 'setup', 'set', 'apply', 'guard',
  'handle', 'start', 'stop', 'regenerate', 'recreate', 'rebuild', 'rework',
])

/** Interrogative openers that read as a question about the world. */
const INTERROGATIVES: ReadonlySet<string> = new Set([
  'what', 'why', 'how', 'when', 'who', 'which', 'where',
  'explain', 'tell', 'define', 'describe', 'compare',
])

/** Auxiliary openers: a question only when followed by a pronoun
 * ("do you know X" asks; "do the thing" commands). */
const AUX_OPENERS: ReadonlySet<string> = new Set([
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'will', 'would',
  'can', 'could', 'should',
])

/** Personal pronouns that make an auxiliary opener a question. */
const PRONOUNS: ReadonlySet<string> = new Set(['you', 'we', 'they', 'he', 'she', 'it', 'i'])

/** Polite imperative wrappers: "can you fix X", "please add X". */
const POLITE_BUILD = /\b(?:can|could|would|will)\s+you\s+\w+|\bplease\s+\w+/i

/** Code markers: backticks, common source extensions, brace/paren bodies. */
const CODE_MARKER = /[`{()}=;]|=>|\.(?:ts|js|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cs|php|html|css|json|yml|yaml|md|sh)\b/i

export interface Intent {
  intent: 'chat' | 'build'
  /** Why this verdict — surfaced so the operator can see the router's logic. */
  reason: string
}

export function classifyIntent(objective: string): Intent {
  const text = objective.trim()
  if (!text) return { intent: 'chat', reason: 'empty' }

  // 1. Leading question openers — questions about the world go to chat, even
  //    when they contain an imperative later ("how do I add a model?" asks;
  //    it does not command). The window is the first three tokens because
  //    conversation openers ride shotgun ("cool", "hey", "ok"). Auxiliary
  //    openers qualify only when a personal pronoun follows ("do you…" —
  //    "do the thing" is a command and falls through to rule 2), and the
  //    pronoun's verb must not itself be an imperative ("can you FIX X" is
  //    a work request wearing a question's clothes).
  const words = text.toLowerCase().split(/[^\w']+/).filter(Boolean)
  const leadHit = words.slice(0, 3).find(w => INTERROGATIVES.has(w))
  if (leadHit) {
    return { intent: 'chat', reason: `starts with "${leadHit}" — a question` }
  }
  if (AUX_OPENERS.has(words[0] ?? '')
      && PRONOUNS.has(words[1] ?? '')
      && !BUILD_VERBS.has(words[2] ?? '')) {
    return { intent: 'chat', reason: `"${words[0]} ${words[1]}" — a question` }
  }

  // 2. Build signals.
  if (words.some(w => BUILD_VERBS.has(w))) {
    return { intent: 'build', reason: `asks for action ("${words.find(w => BUILD_VERBS.has(w))}")` }
  }
  if (POLITE_BUILD.test(text)) {
    return { intent: 'build', reason: 'polite imperative (can you / please …)' }
  }
  if (CODE_MARKER.test(text)) {
    return { intent: 'build', reason: 'mentions code (backticks / extension / syntax)' }
  }

  // 3. The default remainder is conversation: greetings, smalltalk,
  //    statements ("the repo is slow"), meta questions without an
  //    interrogative opener ("hi", "yes", "nice").
  return { intent: 'chat', reason: 'no build signal — conversation' }
}

/**
 * "Tell me about you" -- answered by Wednesday itself, instantly.
 *
 * WHY THIS EXISTS (2026-11-07, operator report: "when I ask Wednesday tell me
 * about you, Wednesday never tells ... we should have open to serve, not
 * confuse to user and tell everything").
 *
 * The question was already routed CORRECTLY: "tell me about you" is a chat
 * turn, not a build. It still produced nothing useful, because the identity
 * doctrine told the model to DECLINE any question about Wednesday:
 *
 *   "If asked about Wednesday internals ... decline in one sentence:
 *    I am Wednesday - I cannot share internal details."
 *
 * So the operator paid for a real model call, waited for it, and received a
 * refusal that contained no information at all -- and that refusal was then
 * written into the chat history, poisoning the next turn.
 *
 * The fix has two halves:
 *
 *  1. This module. A meta question is answered LOCALLY: no model call, no
 *     tokens, no latency, no refusal, and it works even when no provider is
 *     configured at all. The answer is honest about what Wednesday is and
 *     what it hides, and it ends with the next command to run -- an answer
 *     that only says "I cannot help" teaches the operator nothing, and an
 *     answer that says nothing about the next step is where a session dies.
 *  2. `factory/agents/identity.ts` was narrowed in the same change: the
 *     model may now describe Wednesday honestly; only the per-turn model,
 *     provider, routing and pipeline counters stay hidden.
 *
 * Pure and offline: no model call, no I/O. The answer is the same every time
 * because the truth about Wednesday does not change between turns.
 */

/**
 * Questions that ask Wednesday to describe ITSELF.
 *
 * Each pattern is anchored to the END of the sentence (after trailing
 * punctuation is stripped), so "what are you building?" is a question about
 * the current work and stays with the model, while "what are you" is a
 * question about Wednesday and is answered here.
 */
const ABOUT_PATTERNS: readonly RegExp[] = [
  /(?:tell|describe|introduce|explain)\s+(?:me\s+)?about\s+(?:you|yourself|wednesday|this)$/i,
  /who\s+are\s+you$/i,
  /what\s+(?:is|are)\s+(?:you|yourself|wednesday)$/i,
  /what\s+(?:can|do)\s+you\s+do$/i,
  /what\s+are\s+you\s+(?:good\s+at|capable\s+of|useful\s+for)$/i,
  /what\s+is\s+this\s+(?:program|app|tool|thing)$/i,
  /introduce\s+yourself$/i,
  /your\s+(?:name|purpose|job)$/i,
  /^help(?:\s+me)?$/i,
]

/**
 * Is this a question about Wednesday itself?
 *
 * Pure, offline, and deliberately narrow: a false positive here would
 * replace a real answer with a canned one, which is the same failure the
 * operator reported.
 */
export function isAboutQuestion(text: string): boolean {
  const question = text.trim().replace(/[?!.,\s]+$/, '')
  if (!question) return false
  return ABOUT_PATTERNS.some(pattern => pattern.test(question))
}

/**
 * The answer.
 *
 * It says what Wednesday IS, what it DOES, what it deliberately hides, and
 * what to run next. The last part is not decoration: an operator who asks
 * "what can you do" and gets a wall of prose still does not know how to
 * start, and that is where a session ends.
 */
export function aboutAnswer(): string {
  return [
    'I am Wednesday: an open-source terminal factory that turns one plain-language',
    'request into a VERIFIED build, staffed as a team -- a planner, a coder, a tester',
    'and a reviewer -- so small open-source models can do frontier-grade work.',
    '',
    'What I do:',
    '- Build: describe the result; I plan it, write the files, run your verification,',
    '  and hand you a receipt with the evidence. Every run ends in PASS or FAIL.',
    '- Change an existing repo, with your approval before anything is written. /review',
    '  then accepts or rejects the diff.',
    '- Work on your files, your way: say what the page or feature should be and it is',
    '  built that way, not from a template.',
    '- Talk to you live: the answer streams in, the line shows the tokens per second,',
    '  and the terminal rings when a run needs you or has finished. (Mute it with',
    '  WEDNESDAY_BELL=0.)',
    '',
    'What I keep private: which model served a given turn, and the internal pipeline',
    'counters. The code and docs are open source (Apache-2.0) -- read them.',
    '',
    'Start here:',
    '- /help     every command',
    '- /status   the route, model and pool in use',
    '- /doctor   is this install ready?',
    '- /proof    one tiny real task, end to end',
    '- /connect  point me at a model (your key, your provider, or a local server)',
    '',
    'And just ask -- a question is answered as a conversation, a task is built.',
  ].join('\n')
}

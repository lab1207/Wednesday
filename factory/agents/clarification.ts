/**
 * THE ARCHITECT AND THE PLANNER ASK (2026-11-10, operator report).
 *
 *   "the stage architect and planner don't ask question they just go? because
 *    its this 2 has to find user what he looking for the direction so they
 *    must ask relevant question related the task then next and so on"
 *
 * WHY THIS MODULE EXISTS:
 *
 * The two seats that decide the DIRECTION were told, in their own prompt, to
 * do the opposite of asking:
 *
 *     "If the request is ambiguous, choose the reading that needs the fewest
 *      assumptions and say in one line which reading you chose."
 *
 * That is a GUESS instruction wearing a rule's clothes. The seat had no way to
 * reach the operator, so the honest reading of "ask" was "pick something and
 * move on" -- and that is exactly what happened: the run went straight through
 * with a direction nobody chose.
 *
 * So there are TWO halves to the fix, and this file owns the contract between
 * them:
 *
 *  1. THE SEAT ASKS. The role bodies (roles.ts) now end with a `QUESTIONS:`
 *     section and a rule that forbids guessing. This module PARSES that
 *     section out of whatever the model wrote.
 *
 *  2. THE OPERATOR ANSWERS. The seat's runner is one-shot -- it cannot wait --
 *     so the run PAUSES: the orchestrator asks the operator through the
 *     injected `Clarifier`, collects the answers, and runs the seat AGAIN with
 *     the answers in its prompt.
 *
 * THE CONTRACT, IN ONE LINE: a seat that wants to know something writes it
 * under `QUESTIONS:`; the run turns that into ONE question at a time on the
 * operator's screen; the answer goes back into the seat's prompt.
 *
 * WHY A PARSER AND NOT A TOOL CALL: the seats run in ANALYSIS-ONLY mode --
 * "Do not modify files. Do not execute commands." A tool call would need a
 * tool, and a small model asked to call one invents the arguments. A section
 * of plain text in the answer is the one shape a 3B model can produce
 * reliably, and it can be checked without a model (see clarification-test.ts).
 *
 * WHY THE PARSER IS FORGIVING: the same text arrives from a 3B model, a 7B
 * model and a scripted test runner. It may write `QUESTIONS:` on its own line
 * or at the end of a sentence, may number the questions (`1.`, `Q1.`), may
 * bullet them, may put two on one line, and may write `QUESTIONS: none` when
 * it has everything it needs. Every one of those has to land on the same
 * answer: the questions, or none.
 */

/**
 * Asks the operator ONE question and waits for the answer.
 *
 * `undefined` means "the operator did not answer" -- Esc, Ctrl+C, or a
 * closed stdin. It is NOT an error: the run continues with what the seat
 * already knows, and the exchange is recorded as unanswered.
 */
export interface Clarifier {
  (question: string): Promise<string | undefined>
}

/** One question and the answer the operator gave it. */
export interface ClarificationAnswer {
  question: string
  answer: string
}

/**
 * The marker the seat writes. Uppercase, because the seat bodies are written
 * in uppercase section names and a model follows the shape it is shown.
 */
export const CLARIFICATION_MARKER = 'QUESTIONS:'

/**
 * How many questions one round may carry.
 *
 * WHY A CAP: the operator asked for "relevant question related the task then
 * next and so on" -- a CONVERSATION, not a form. A seat that dumps twenty
 * questions at once has not found the direction; it has found a way to avoid
 * choosing. Three is enough to pin the direction of a task, and the cap makes
 * the bound visible to the model too.
 */
export const MAX_CLARIFICATION_QUESTIONS = 3

/**
 * How many times a seat may be re-run after asking.
 *
 * The first run asks, the re-run works with the answers. A seat that asks
 * again after the answers is either still missing something real (worth one
 * more round) or looping (not worth more than two).
 */
export const MAX_CLARIFICATION_ROUNDS = 2

/** The shapes a seat uses to say "I have nothing to ask". */
const NONE_RE = /^(none|n\/a|none needed|no questions?|nothing)\b/i

/**
 * A line that starts a NEW section, e.g. `RISK: the most likely failure`.
 *
 * The section ends the questions block: a seat that writes its questions
 * first and its report afterwards is normal, and the report must not be
 * mistaken for more questions.
 *
 * A line ending in `?` is never a header -- `API: keep the old endpoint?` is
 * a question, not a section.
 */
const SECTION_RE = /^[\s>*\-#]*[A-Z][A-Z0-9 /_&-]{2,}:/

/** Strip the list marker a model put in front of a question. */
function stripMarker(value: string): string {
  let text = value.trim()
  // A bullet: `-`, `*`, `•`.
  text = text.replace(/^[\s>*\-•#]+\s*/, '')
  // A number: `1.`, `2)`, `Q1.`, `Q2)`.
  text = text.replace(/^(?:q\s*)?\d+\s*[.)]\s*/i, '')
  // A second bullet pass: `1. - do you want...`.
  text = text.replace(/^[-*•]\s*/, '')
  return text.trim()
}

function isSectionHeader(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('?')) return false
  return SECTION_RE.test(trimmed)
}

/**
 * The questions a seat asked, in the order it asked them.
 *
 * Returns an empty array when the seat asked nothing -- which is the normal
 * case for a task that was already clear, and the case that must NOT turn
 * into a pause.
 *
 * The text searched is the seat's ANSWER, never its prompt: the prompt
 * contains the words `QUESTIONS:` because the seat body teaches the shape,
 * and parsing the prompt would find the template instead of the question.
 */
export function parseClarificationQuestions(text: string): string[] {
  if (!text) return []

  const normalized = text.replace(/\r\n/g, '\n')

  // The LAST marker wins: a seat that mentions the word in passing and then
  // writes the section at the end is writing the section at the end.
  const marker = /QUESTIONS\s*:/gi
  let last: RegExpExecArray | null = null
  let found: RegExpExecArray | null
  while ((found = marker.exec(normalized)) !== null) last = found
  if (!last) return []

  const after = normalized.slice(last.index + last[0].length)
  const lines = after.split('\n')

  const block: string[] = []
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line) continue
    const body = stripMarker(line)
    if (!body) continue
    if (NONE_RE.test(body)) break
    // The first line is the tail of the marker line itself, so it cannot be
    // the start of a new section.
    if (index > 0 && isSectionHeader(raw)) break
    block.push(body)
  }

  if (block.length === 0) return []

  // One question can span two lines, and two questions can share one line.
  // Splitting on the question marks settles both.
  const questions: string[] = []
  for (const part of block.join('\n').split(/(?<=\?)/)) {
    const candidate = stripMarker(part)
    if (!candidate) continue
    if (NONE_RE.test(candidate)) continue
    if (!candidate.includes('?')) continue
    // One line per question: the question is shown on ONE line of the
    // operator's screen and read out of a status line, so a wrapped question
    // must not arrive wrapped.
    questions.push(candidate.replace(/\s+/g, ' ').trim())
  }

  return questions.slice(0, MAX_CLARIFICATION_QUESTIONS)
}

/**
 * The answers, as the seat sees them on its next run.
 *
 * The block is a HEAD section, not a tail section: it sits right under the
 * task, so it is the first thing the model reads and the first thing a trim
 * keeps. The instruction at the end of the block is what stops the seat from
 * asking the same question again.
 */
export function buildClarificationBlock(
  answers: readonly ClarificationAnswer[],
): string {
  if (answers.length === 0) return ''
  return [
    'THE OPERATOR ANSWERED YOUR QUESTIONS. Use these answers -- do not ask them again:',
    ...answers.map(
      (entry, index) =>
        `Q${index + 1}: ${entry.question}\nA${index + 1}: ${entry.answer}`,
    ),
    'If something is STILL unclear, ask again in the same QUESTIONS: section.',
    'Otherwise do the task.',
  ].join('\n')
}

/**
 * The seat's answer, as the parser must see it.
 *
 * `instructions` is DELIBERATELY EXCLUDED: on the model runner it holds the
 * PROMPT that was sent, and that prompt contains the words `QUESTIONS:`
 * because the seat body teaches the shape. Parsing it would find the
 * template and ask the operator a question the model never asked.
 */
export function collectSeatText(output: {
  summary?: string
  findings?: readonly string[]
}): string {
  const findings = (output.findings ?? [])
    .filter((entry): entry is string => typeof entry === 'string')
    .join('\n')
  if (findings.trim()) return findings
  return output.summary ?? ''
}

/**
 * "Tell me about you" -- answered locally, instantly (2026-11-07).
 *
 * WHY THIS TEST EXISTS (operator report: "when I ask Wednesday tell me about
 * you, Wednesday never tells ... we should have open to serve, not confuse to
 * user and tell everything").
 *
 * The question was already routed to the chat loop correctly; the problem
 * was that the identity doctrine told the MODEL to decline any question
 * about Wednesday, so the operator paid for a model call and received a
 * refusal. The fix answers the plainest form of the question in the harness
 * itself: no model, no tokens, no latency.
 *
 * Two properties matter and both are asserted here:
 *  - the matcher is NARROW (a question about the current work must still
 *    reach the model; a false positive would replace a real answer with a
 *    canned one, which is the same failure the operator reported);
 *  - the answer is HONEST (it says what is public and what is not, and it
 *    never names a provider or a model).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point state home at a temp dir before importing the module.
const stateHome = mkdtempSync(join(tmpdir(), 'wed-about-state-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const { aboutAnswer, isAboutQuestion } = await import('./about')

async function main(): Promise<void> {
  // 1. The plain forms of the complaint are caught.
  for (const question of [
    'tell me about you',
    'tell me about yourself',
    'Tell me about Wednesday',
    'who are you',
    'what are you',
    'what can you do',
    'what do you do',
    'what are you good at',
    'introduce yourself',
    'help',
    'help me',
  ]) {
    assert.equal(isAboutQuestion(question), true, `must answer locally: ${question}`)
  }

  // 2. A question about the CURRENT WORK is not a question about Wednesday.
  //    A false positive here would replace a real answer with a canned one.
  for (const question of [
    'what are you building',
    'what are you working on',
    'tell me about the verifier',
    'build me a website for a bakery',
    'help me build a website',
    'what is the router',
    'who is on the crew',
    'tell me about the repo',
  ]) {
    assert.equal(isAboutQuestion(question), false, `must reach the model: ${question}`)
  }

  // 3. The answer is honest: it says what Wednesday IS and what it hides.
  const answer = aboutAnswer()
  assert.match(answer, /Wednesday/, 'the answer says who this is')
  assert.match(answer, /verified build/i, 'and what it does')
  assert.match(answer, /\/help/, 'and the first command to run')
  assert.match(answer, /\/status/, 'and the next one')
  assert.match(answer, /open source/i, 'and it is honest about being open')
  assert.match(answer, /private/i, 'and honest about what it keeps private')

  // 4. The answer never names a provider, a model, or the routing.
  for (const leaked of ['qwen', 'openrouter', 'nvidia', 'colab', 'zen api', 'deepseek', 'gpt']) {
    assert.ok(
      !answer.toLowerCase().includes(leaked),
      `the about answer must not name providers/models: ${leaked}`,
    )
  }

  rmSync(stateHome, { recursive: true, force: true })
  console.log('ABOUT TEST: PASS (narrow matcher, honest answer, no provider leak)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

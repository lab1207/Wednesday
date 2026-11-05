import assert from 'node:assert/strict'

import { classifyIntent } from './intent'

/**
 * Intent router (2026-10-30, chunk 4): the referee between the chat loop
 * and the build pipeline. BUILD signals win; chat is the default remainder.
 * Every case below is a prompt the operator could type; the point is that
 * real questions never see an approval card and real work never answers
 * with small talk.
 */

const BUILD: string[] = [
  // Imperative verbs, any size.
  'fix the login leak',
  'do the thing',
  'build a snake game',
  'add tests for the crew store',
  'make the app faster',
  'refactor the parser module',
  'generate a README for the connector',
  'remove the dead export',
  'cleanup logging noise',
  'regenerate the scoreboard',
  'Patch the retry loop', // case-insensitive
  // Polite imperative wrappers.
  'can you fix the login bug',
  'could you add a retry please',
  'please update the help text',
  // Code markers without a verb.
  'the `screen.ts` render path drops the last row',
  'harness.ts throws on a 2-word input',
  'npm run build {reports} the wrong exit code',
  '.ts file missing from dist',
]

const CHAT: string[] = [
  // Greetings + small talk.
  'hi',
  'hello',
  'hey there',
  'yo',
  'thanks',
  'thank you very much',
  'ok',
  'cool what else can you do',
  // Real questions — the case the old gate got wrong.
  'what is a ferrite bead',
  'how do I add a model?',
  'why is the crew store clearing my slots',
  'does this support openrouter',
  'is the approval gate required',
  'explain how the router works',
  'tell me about the verifier',
  'define what a crew seat is',
  // Statements / opinions without a verb or code.
  'and again',
  'the repo is slow',
  'nice',
]

async function main(): Promise<void> {
  for (const text of BUILD) {
    const intent = classifyIntent(text)
    assert.equal(intent.intent, 'build', `"${text}" should build (${intent.reason})`)
  }
  for (const text of CHAT) {
    const intent = classifyIntent(text)
    assert.equal(intent.intent, 'chat', `"${text}" should chat (${intent.reason})`)
  }

  // Every verdict carries a reason the operator could echo in verbose mode.
  assert.ok(classifyIntent('fix the login leak').reason.length > 0)

  // Ambiguity leans BUILD (a wrong build is one denied card; a wrong chat
  // silently builds nothing): an imperative inside a question-marked line
  // without an interrogative OPENER still builds.
  assert.equal(classifyIntent('add a model?').intent, 'build')

  // But an interrogative opener wins over the verb inside it.
  assert.equal(classifyIntent('how do I add a model?').intent, 'chat')

  console.log('INTENT TEST: PASS (' + (BUILD.length + CHAT.length) + ' cases)')
}

main().catch(err => {
  console.error('INTENT TEST: FAIL')
  console.error(err)
  process.exit(1)
})

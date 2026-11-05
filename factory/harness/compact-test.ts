/**
 * Auto-compaction + prompt-budget proof (2026-11-01).
 *
 * The operator's report was "ctx 29.3K/13.0K" on a 13K model. Two numbers were
 * wrong there: the meter divided SESSION SPEND by the window, and nothing
 * trimmed a prompt that could not fit. These assertions pin the fixes:
 *  1. compaction fires at 67% / 87% and never below;
 *  2. the newest exchange always survives, and the operator's own words carry
 *     forward instead of vanishing;
 *  3. a prompt or conversation larger than the window is clamped to it;
 *  4. an unknown window (0) clamps nothing, because inventing a ceiling is how
 *     a good prompt gets cut for no reason.
 */
import assert from 'node:assert/strict'
import { COMPACT_HARD, COMPACT_SOFT, compactHistory, compactionLevel } from './compact'
import { clampMessages, clampPrompt, resolvePromptBudget, estimateTokens, TRIM_MARKER } from '../model-router/prompt-budget'
import type { ChatMessage } from '../model-router/chat-stream'

const turn = (role: ChatMessage['role'], text: string): ChatMessage => ({ role, content: text })

// -- 1. thresholds -----------------------------------------------------------
const budget = 1000
const one = [turn('user', 'x'.repeat(400)), turn('assistant', 'y'.repeat(400))] // ~200 tokens
assert.equal(compactionLevel(one, { budget, pressure: Math.floor(budget * (COMPACT_SOFT - 0.05)) }), null, 'below 67%: no compaction')
assert.equal(compactionLevel(one, { budget, pressure: Math.floor(budget * COMPACT_SOFT) }), 'soft', 'at 67%: soft')
assert.equal(compactionLevel(one, { budget, pressure: Math.floor(budget * COMPACT_HARD) }), 'hard', 'at 87%: hard')
assert.equal(compactionLevel(one, { budget: 0, pressure: 999999 }), null, 'unknown window: never compacts')

// -- 2. what survives -------------------------------------------------------
const history: ChatMessage[] = []
for (let i = 0; i < 12; i++) {
  history.push(turn('user', `request ${i} ` + 'a'.repeat(200)))
  history.push(turn('assistant', `answer ${i} ` + 'b'.repeat(200)))
}
const soft = compactHistory(history, { budget, force: 'soft' })
assert.ok(soft.dropped > 0, 'a fitting history is compacted')
assert.ok(soft.after < soft.before, `compaction shrinks the conversation (${soft.before} → ${soft.after})`)
assert.ok(soft.history.at(-1)!.content.startsWith('answer 11'), 'the newest turn survives verbatim')
assert.ok(soft.history.some(message => message.content.includes('request 11')), 'the newest request survives')
assert.ok(soft.carry !== null && soft.carry.includes('request 0'), 'dropped requests carry forward as one note')
assert.ok(estimateTokens(soft.carry!) < 200, `the carry note is short (${estimateTokens(soft.carry!)} tokens)`)

const hard = compactHistory(history, { budget, force: 'hard' })
assert.ok(hard.dropped > soft.dropped, 'hard compaction drops strictly more than soft')
assert.ok(hard.history.length <= soft.history.length, 'and leaves a smaller conversation')

// A conversation already inside the window is untouched — compacting it would
// discard memory for no benefit.
const fits = compactHistory([turn('user', 'hi'), turn('assistant', 'hello')], { budget, pressure: 10 })
assert.equal(fits.dropped, 0, 'nothing is dropped when there is room')
assert.equal(fits.level, null)
assert.deepEqual(fits.history, [turn('user', 'hi'), turn('assistant', 'hello')])

// -- 3. clamping ------------------------------------------------------------
const huge = 'HEAD ' + 'm'.repeat(9000) + ' TAIL'
const clamped = clampPrompt(huge, 500)
assert.ok(clamped.trimmed > 0, 'an oversized prompt is trimmed')
assert.ok(clamped.after <= 900, `trimmed to the window (${clamped.after} tokens)`)
assert.ok(clamped.prompt.startsWith('HEAD '), 'the head (task/instructions) survives')
assert.ok(clamped.prompt.endsWith(' TAIL'), 'the tail (final requirement / failure) survives')
assert.ok(clamped.prompt.includes(TRIM_MARKER.trim().slice(0, 20)), 'the cut is stated, not silent')

const untouched = clampPrompt('short prompt', 500)
assert.equal(untouched.trimmed, 0, 'a prompt that fits is sent byte for byte')

const conversation = [turn('system', 'SYS'), turn('user', 'old ' + 'o'.repeat(4000)), turn('assistant', 'mid'), turn('user', 'new question')]
const fitted = clampMessages(conversation, 300)
assert.ok(fitted.dropped > 0, 'an oversized conversation drops old turns')
assert.equal(fitted.messages[0]!.role, 'system', 'the system prompt is never dropped')
assert.equal(fitted.messages.at(-1)!.content, 'new question', 'the current request is never dropped')
assert.ok(fitted.messages.length < conversation.length)

const single = [turn('system', 'SYS'), turn('user', 'Q ' + 'q'.repeat(8000))]
const singleFitted = clampMessages(single, 200)
assert.equal(singleFitted.messages.at(-1)!.role, 'user', 'one giant turn is clamped, not dropped')

// -- 4. unknown window ------------------------------------------------------
assert.equal(clampMessages(conversation, 0).dropped, 0, 'window 0 (unknown) drops nothing')
assert.equal(estimateTokens(''), 0)

// The route decides the default window: local is the dev model's 13,312, and an
// explicit override always wins.
assert.equal(resolvePromptBudget({ FACTORY_LLM_PROVIDER: 'local' } as NodeJS.ProcessEnv), 13312)
assert.equal(resolvePromptBudget({ FACTORY_LLM_PROVIDER: 'local', FACTORY_CONTEXT_LIMIT: '32000' } as NodeJS.ProcessEnv), 32000)
assert.equal(resolvePromptBudget({ FACTORY_LLM_PROVIDER: 'openrouter' } as NodeJS.ProcessEnv), 0)

console.log('COMPACT TEST: PASS (67%/87% thresholds, newest turn + carry note survive, prompt and conversation clamped, unknown window untouched)')

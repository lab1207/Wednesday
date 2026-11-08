/**
 * Mixture-of-Agents: N proposers in parallel, one aggregator that reads them
 * all and returns a single answer (2026-11-08, B238).
 *
 * WHY: the operator pasted a Together-SDK reference implementation and said
 * "go". Wednesday already owns the parallel half — `factory/orchestrator/
 * relay.ts` splits work into pieces, assigns each to the best-fit model and
 * solves them simultaneously, `expansion.ts` runs duel and vote lanes, and
 * `tallyReviewVotes` merges ballots. None of that is prose synthesis: a
 * ballot is a STRUCTURED verdict, and the pasted pattern is N free-text
 * answers read by a "master aggregator" that fixes mistakes and returns one
 * answer. That is a different aggregation, and the chat path had none.
 *
 * WHAT THIS MODULE ADDS: the aggregator prompt (built from the operator's own
 * system and user shape), and a runner that fans out to the proposers in
 * parallel and then calls the aggregator once.
 *
 * TWO WAYS IT IS HARDER THAN THE PASTED CODE, because the pasted code is a
 * sketch and this runs on a machine where one model is on a dead box:
 *
 *  1. `asyncio.gather` in the snippet REJECTS on the first failure, so one
 *     dead proposer discards every answer the others produced. Here a
 *     proposer that fails is recorded as a failure and the rest are still
 *     aggregated — the operator gets the aggregate of what worked, plus an
 *     honest list of what did not.
 *  2. The snippet's `final_review` is neither awaited nor checked; a failed
 *     aggregator call would surface as a confusing attribute error. Here it
 *     is awaited, and a failure is a result with a reason, not a crash.
 *
 * Pure and exported where it can be, so the claim is assertable offline.
 */

import type { ModelProvider } from '../model-router/types'

/** The operator's aggregator instruction, verbatim. */
export const MOA_AGGREGATOR_SYSTEM =
  'You are the master aggregator. Review these AI teammate responses, fix mistakes, and synthesize the ultimate comprehensive answer.'

export interface Proposer {
  /** The model id, as the provider names it. */
  model: string
  /** The seat label, for the receipt — who said what. */
  seat?: string
}

export interface ProposerResult {
  model: string
  seat: string
  ok: boolean
  /** The answer, or the reason there is none. */
  text: string
  /** Why it failed, when it did. */
  reason?: string
}

export interface MoaResult {
  /** The aggregator's single answer. */
  answer: string
  /** Every proposer, in the order they were asked. */
  proposers: ProposerResult[]
  /** The aggregator's model id. */
  aggregator: string
  /** Empty when the aggregator ran. */
  failure?: string
}

/**
 * Render the aggregator's prompt (pure).
 *
 * The operator's shape: the original question, then every teammate response
 * attributed by model, so the aggregator can disagree with a specific
 * teammate rather than a blob. A failed proposer is NAMED as failed rather
 * than omitted — an aggregator that silently sees fewer answers than were
 * asked for would synthesise confidence nobody earned.
 */
export function buildAggregatorPrompt(
  question: string,
  results: readonly ProposerResult[],
): string {
  const body = results
    .map(result => {
      const who = result.seat ? `${result.seat} (${result.model})` : result.model
      return result.ok
        ? `--- ${who} ---\n${result.text}`
        : `--- ${who} --- FAILED: ${result.reason ?? 'no answer'}`
    })
    .join('\n\n')

  return `Original Question: ${question}\n\nTeammate Responses:\n${body}`
}

/** A one-line receipt: who answered, who did not, and what it cost. */
export function describeMoa(result: MoaResult): string {
  const ok = result.proposers.filter(p => p.ok).length
  const failed = result.proposers.length - ok
  const head = `aggregated ${ok}/${result.proposers.length} proposers by ${result.aggregator}`
  return failed > 0 ? `${head} · ${failed} FAILED` : head
}

/**
 * Run the team: every proposer in parallel, then one aggregator call.
 *
 * `complete` is injected so a test drives this without a network, and so a
 * caller can choose the provider — the same shape the model router uses.
 */
export async function runMoa(options: {
  question: string
  proposers: readonly Proposer[]
  aggregator: string
  complete: ModelProvider['complete']
}): Promise<MoaResult> {
  const { question, proposers, aggregator, complete } = options

  const settled = await Promise.allSettled(
    proposers.map(async proposer => {
      const response = await complete(
        proposer.model,
        question,
        undefined,
        {},
      )
      return { proposer, response }
    }),
  )

  const results: ProposerResult[] = settled.map((entry, index) => {
    const proposer = proposers[index]
    const seat = proposer.seat ?? proposer.model
    if (entry.status === 'fulfilled') {
      const text = (entry.value.response ?? '').trim()
      if (text.length > 0) {
        return { model: proposer.model, seat, ok: true, text }
      }
      return {
        model: proposer.model,
        seat,
        ok: false,
        text: '',
        reason: 'the model returned an empty answer',
      }
    }
    const reason =
      entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
    return { model: proposer.model, seat, ok: false, text: '', reason }
  })

  const anyOk = results.some(result => result.ok)
  if (!anyOk) {
    // Name WHY, not just that: "nothing to aggregate" would send the operator
    // looking for a routing bug when the real cause was one dead box, or one
    // model that returned an empty string.
    const reasons = results
      .map(result => `${result.seat}: ${result.reason ?? 'no answer'}`)
      .join('; ')
    return {
      answer: '',
      proposers: results,
      aggregator,
      failure: `every proposer failed, so there was nothing to aggregate (${reasons})`,
    }
  }

  try {
    const answer = (
      await complete(
        aggregator,
        buildAggregatorPrompt(question, results),
        undefined,
        {},
      )
    ).trim()
    if (answer.length === 0) {
      return {
        answer: '',
        proposers: results,
        aggregator,
        failure: 'the aggregator returned an empty answer',
      }
    }
    return { answer, proposers: results, aggregator }
  } catch (error) {
    return {
      answer: '',
      proposers: results,
      aggregator,
      failure: `the aggregator failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

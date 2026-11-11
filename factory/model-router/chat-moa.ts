/**
 * Mixture-of-Agents over the CHAT routes (2026-11-08, B238).
 *
 * WHY THIS LAYER OVER `factory/agents/moa.ts`: that module takes a
 * `ModelProvider`, which is how a task's seats call models. A chat turn does
 * not go through a provider — it goes through a `ChatRoute`
 * (`resolveChatRoute` -> `chatComplete`), and the operator's pasted pattern
 * is a CHAT pattern: several tabs, one question, one aggregated answer. This
 * bridges the two so the same aggregate runs on the chat path.
 *
 * The parallel fan-out is `Promise.allSettled`, never `Promise.all`: the
 * pasted `asyncio.gather` rejects on the first failure and throws away every
 * answer the other models produced. On a machine where one box is dead, that
 * is the difference between "three of four teammates answered" and "nothing
 * happened".
 */
import {
  buildChatRequest,
  buildChatSystemPrompt,
  chatComplete,
} from './chat-stream'
import type { ChatMessage, ChatRoute } from './chat-stream'

import {
  MOA_AGGREGATOR_SYSTEM,
  buildAggregatorPrompt,
} from '../agents/moa'
import type { ProposerResult } from '../agents/moa'

export interface ChatTeamMember {
  /** The seat label for the receipt — who said what. */
  seat: string
  /** The route that member speaks on. */
  route: ChatRoute
}

export interface ChatMoaResult {
  answer: string
  proposers: ProposerResult[]
  /** The aggregator's route name and model, for the receipt. */
  aggregator: { name: string; model: string }
  /** Empty when the aggregate ran. */
  failure?: string
}

/** Run the team on the chat routes, then one aggregator call. */
export async function runChatMoa(options: {
  question: string
  team: readonly ChatTeamMember[]
  aggregator: ChatRoute
  history?: readonly ChatMessage[]
  /**
   * The images the operator attached (2026-11-10): data URLs or https URLs.
   *
   * The TEAM sees them -- every teammate is asked the same question, and a
   * question about a picture that only one of them can see is not a team
   * answer. The AGGREGATOR sees them too: it reads the proposers' words,
   * and a picture the proposers described in prose is not the same as the
   * picture itself.
   */
  images?: string[]
  onDelta?: (piece: string) => void
  signal?: AbortSignal
  /** Injected so a test can drive this with no network. */
  complete?: typeof chatComplete
}): Promise<ChatMoaResult> {
  const { question, team, aggregator, history = [] } = options
  // The real chat path by default; a test (or a caller with its own provider)
  // passes its own.
  const complete = options.complete ?? chatComplete

  const messages = buildChatRequest([...history], question, options.images)
  const system = buildChatSystemPrompt()

  const settled = await Promise.allSettled(
    team.map(member =>
      complete(
        member.route,
        [{ role: 'system', content: system }, ...messages],
        undefined,
        options.signal,
      ),
    ),
  )

  const proposers: ProposerResult[] = settled.map((entry, index) => {
    const member = team[index]
    const route = member.route
    if (entry.status === 'fulfilled') {
      const text = (entry.value.text ?? '').trim()
      if (text.length > 0) {
        return {
          model: route.model,
          seat: member.seat,
          ok: true,
          text,
        }
      }
      return {
        model: route.model,
        seat: member.seat,
        ok: false,
        text: '',
        reason: 'the model returned an empty answer',
      }
    }
    const reason =
      entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
    return { model: route.model, seat: member.seat, ok: false, text: '', reason }
  })

  const anyOk = proposers.some(result => result.ok)
  if (!anyOk) {
    const reasons = proposers
      .map(result => `${result.seat}: ${result.reason ?? 'no answer'}`)
      .join('; ')
    return {
      answer: '',
      proposers,
      aggregator: { name: aggregator.name, model: aggregator.model },
      failure: `every teammate failed, so there was nothing to aggregate (${reasons})`,
    }
  }

  try {
    const result = await complete(
      aggregator,
      [
        { role: 'system', content: MOA_AGGREGATOR_SYSTEM },
        {
          role: 'user',
          content: buildAggregatorPrompt(question, proposers),
          ...(options.images && options.images.length > 0
            ? { images: options.images }
            : {}),
        },
      ],
      options.onDelta,
      options.signal,
    )
    const answer = (result.text ?? '').trim()
    if (answer.length === 0) {
      return {
        answer: '',
        proposers,
        aggregator: { name: aggregator.name, model: aggregator.model },
        failure: 'the aggregator returned an empty answer',
      }
    }
    return {
      answer,
      proposers,
      aggregator: { name: aggregator.name, model: aggregator.model },
    }
  } catch (error) {
    return {
      answer: '',
      proposers,
      aggregator: { name: aggregator.name, model: aggregator.model },
      failure: `the aggregator failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * One receipt line for a MoA turn. Names every teammate, so a run that
 * quietly used one model cannot look like a team.
 */
export function describeChatMoa(result: ChatMoaResult): string {
  const ok = result.proposers.filter(p => p.ok).length
  const team = result.proposers.map(p => p.seat).join(' + ')
  const head = `team ${team} (${ok}/${result.proposers.length} answered) -> ${result.aggregator.name}/${result.aggregator.model}`
  return result.failure ? `${head} · FAILED: ${result.failure}` : head
}

/**
 * The MoA configuration, from the environment (pure).
 *
 * WHY ENV AND NOT A FLAG: the operator asked for this to run when they say
 * so, and an env var works from a wrapper script, a `.env` profile and a
 * terminal alike — the same posture as every other crew seat
 * (`FACTORY_CREW_<SEAT>_MODEL`).
 *
 *   FACTORY_MOA=1                       turn the pattern on
 *   FACTORY_MOA_PROPOSERS=a,b,c         the team, comma-separated
 *   FACTORY_MOA_AGGREGATOR=z            the aggregator (else the chat route)
 *
 * Each proposer may name its own seat: `reviewer=/models/reviewer.gguf`. A
 * bare entry uses the entry itself as both seat and model id.
 *
 * Returns null when the pattern is OFF, so a caller can branch once and leave
 * the ordinary path untouched.
 */
export interface ChatMoaConfig {
  /** seat label -> model id, in the order the operator listed them. */
  team: Array<{ seat: string; model: string }>
  /** The aggregator's model id, or '' to use the chat route's own. */
  aggregator: string
}

const ON = new Set(['1', 'true', 'yes', 'on'])

export function resolveChatMoa(
  env: Record<string, string | undefined> = process.env,
): ChatMoaConfig | null {
  if (!ON.has((env.FACTORY_MOA ?? '').trim().toLowerCase())) return null

  const raw = (env.FACTORY_MOA_PROPOSERS ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)

  if (raw.length === 0) {
    // ON with no team is a configuration error, not a silent no-op: the
    // operator asked for a team and would otherwise watch one model answer.
    throw new Error(
      'FACTORY_MOA is on but FACTORY_MOA_PROPOSERS is empty — name the team, e.g. FACTORY_MOA_PROPOSERS=coder,reviewer,tester',
    )
  }

  const team = raw.map(entry => {
    const eq = entry.indexOf('=')
    if (eq > 0) {
      const seat = entry.slice(0, eq).trim()
      const model = entry.slice(eq + 1).trim()
      if (seat && model) return { seat, model }
    }
    return { seat: entry, model: entry }
  })

  return { team, aggregator: (env.FACTORY_MOA_AGGREGATOR ?? '').trim() }
}

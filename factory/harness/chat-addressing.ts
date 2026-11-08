/**
 * Who answers a chat turn (2026-11-05).
 *
 * THE BUG THIS FIXES. The chat path picked `crew?.seats[0]` — the FIRST seat
 * in the crew's list — as the model that answers the operator's question.
 * That is not a role, it is an ARRAY INDEX. A crew whose seats were
 * [vision, coder, planner] sent every question to the VISION model, and a
 * six-seat crew sent every question to whichever seat happened to be first.
 * The operator asked a question and got answered by a screenshot specialist.
 *
 * Two things live here:
 *
 *  1. `pickChatSeat` — WHICH seat answers when the operator did not say.
 *     The answer is a ROLE with a preference order (the architect reasons,
 *     the coder types, the vision seat looks at pictures), not an index.
 *
 *  2. `parseChatAddress` — `@reviewer ...` sends the turn to THAT seat. A
 *     team is only a team if the operator can talk to one member of it.
 *     The address is stripped before the text reaches the model, so the
 *     model sees the QUESTION and not the routing directive.
 *
 * Rules of the house:
 *  - Pure functions. No I/O, no clock, no classes.
 *  - An address only counts when it names a REAL seat. `@someone` in a
 *    sentence, an email address, a decorator - none of them are a seat, and
 *    eating them would silently change what the operator asked.
 *  - An unknown role is NOT an error: the turn falls back to the default
 *    conversational seat. The operator gets an answer, not a refusal.
 */
import type { CrewRole } from '../model-router/crew-routing'
import {
  CREW_ROLES,
  crewRoleEnvName,
  normalizeCrewRole,
} from '../model-router/crew-routing'

/**
 * The seats that can hold a conversation, best first.
 *
 * The architect reasons about the work, so it answers first; the planner
 * comes next; the coder is the one that knows the code; the reviewer and
 * the tester are specialists; the vision seat is LAST because it is the one
 * that needs an image to be useful.
 *
 * The AUTOCOMPLETE, BUG HUNTING and SECURITY AUDIT seats come after those
 * (2026-11-07). They are specialists the operator reaches for on purpose --
 * `@security-audit review what you just built` -- so they must never take a
 * turn the operator meant for the team. `vision` stays ahead of them because
 * a crew that only fills the vision seat should still talk to it.
 */
export const CHAT_SEAT_ORDER: readonly CrewRole[] = [
  'architect',
  'planner',
  'coder',
  'reviewer',
  'tester',
  'vision',
  'bug-hunter',
  'security-audit',
  'autocomplete',
]

/** A chat turn addressed to one seat. */
export interface ChatAddress {
  /** The seat the operator named. */
  role: CrewRole
  /** The request with the address removed - what the model actually reads. */
  text: string
  /** The address exactly as the operator typed it, for the receipt. */
  raw: string
}

/**
 * Read an `@seat` address off the front of a request (pure).
 *
 * Returns null when the request is not addressed: no `@`, no name after it,
 * or the name is not a real seat. The text is returned UNCHANGED in that
 * case, because an untouched request is always safer than a mangled one.
 */
export function parseChatAddress(input: string): ChatAddress | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('@')) return null
  // The address runs to the first whitespace: `@reviewer` or `@reviewer what
  // do you think?`. Nothing else is an address.
  const match = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const raw = match[1] ?? ''
  const role = normalizeCrewRole(raw)
  if (!role) return null
  const rest = (match[2] ?? '').trim()
  // An address with no question behind it is not a request; let the caller
  // treat the whole line as the request rather than sending an empty turn.
  if (!rest) return null
  return { role, text: rest, raw: `@${raw}` }
}

/**
 * The model a named seat wears (pure).
 *
 * A seat the crew does not fill falls back to the env profile's seat, which
 * is the honest reading of "this team has no reviewer of its own".
 */
export function chatSeatModel(
  crew: { seats: Array<{ role: string; model: string }> } | null,
  role: CrewRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const exact = crew?.seats.find(seat => seat.role.trim().toLowerCase() === role)
  const own = (exact?.model ?? '').trim()
  if (own) return own
  // The same slot fallback the pipeline uses: a crew of three folds the
  // architect onto the planner and the tester/reviewer onto the coder.
  const slot =
    role === 'architect' || role === 'planner'
      ? 'planner'
      : role === 'vision'
        ? 'vision'
        : 'coder'
  const inSlot = crew?.seats.find(seat => {
    const seatRole = normalizeCrewRole(seat.role)
    return seatRole !== null && (seatRole === slot || seatRole === role)
  })
  const slotModel = (inSlot?.model ?? '').trim()
  if (slotModel) return slotModel
  // The env name is spelled with underscores, so a seat whose name carries a
  // hyphen (`bug-hunter`) is still reachable from a PowerShell profile.
  return env[crewRoleEnvName(role)]?.trim() ?? ''
}

/**
 * The seat that answers when the operator did not name one (pure).
 *
 * The FIRST seat in the CREW'S OWN preference order that the crew actually
 * fills. A crew of [vision, coder] answers with the CODER, not with the
 * vision model - which is what the operator meant.
 */
export function pickChatSeat(
  crew: { seats: Array<{ role: string; model: string }> } | null,
  env: NodeJS.ProcessEnv = process.env,
): { role: CrewRole; model: string } | null {
  if (!crew) return null
  for (const role of CHAT_SEAT_ORDER) {
    const model = chatSeatModel(crew, role, env)
    if (model) return { role, model }
  }
  // The crew fills no conversational seat. Fall back to the env profile's
  // first seat that has a model, so a chat still has somewhere to go.
  for (const role of CREW_ROLES) {
    const model = (env[crewRoleEnvName(role)] ?? '').trim()
    if (model) return { role, model }
  }
  return null
}

/**
 * The addressable seat names, for the hint line and the help text (pure).
 *
 * They are listed in the SAME order as the preference order, so the hint
 * line reads the way the seats actually answer: the core team first, the
 * on-demand specialists after it.
 */
export function chatAddressNames(): string[] {
  return CHAT_SEAT_ORDER.map(role => `@${role}`)
}

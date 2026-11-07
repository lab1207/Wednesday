export type FactoryEventType =
  | 'task.created'
  | 'task.started'
  | 'agent.started'
  | 'agent.completed'
  | 'tool.called'
  | 'verification.started'
  | 'verification.completed'
  | 'review.started'
  | 'review.completed'
  | 'repair.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.blocked'
  | 'agent.activity'
  | 'lane.started'
  | 'lane.completed'
  | 'lane.scored'

/**
 * What a seat is doing RIGHT NOW, while it is doing it.
 *
 * The lifecycle events say a seat started and that it finished; between them
 * the run was a silence, and the operator could not tell a working seat from a
 * dead one (operator, 2026-11-04: "stream the reasoning, the file changes, the
 * commands — so I can see what is happening").
 *
 * Activity events are APPEND-ONLY and partial: each one carries a piece, never
 * the whole. The consumer joins the pieces per seat.
 */
export type AgentActivityKind =
  /** The model thinking out loud (`reasoning_content`). */
  | 'reasoning'
  /** The model talking — its committed answer text so far. */
  | 'text'
  /** A tool the seat reached for. */
  | 'tool'
  /** A file the seat wrote. */
  | 'file'

export interface AgentActivity {
  kind: AgentActivityKind
  /** The piece of reasoning or text. */
  text?: string
  /** The tool's name or title. */
  tool?: string
  /** What the activity touched: a path, a command. */
  detail?: string
  /** The activity's outcome: `pending`, `in_progress`, `completed`, `failed`. */
  status?: string
}

export interface FactoryEvent {
  id: string
  type: FactoryEventType
  taskId: string
  timestamp: string
  role?: string
  payload?: Record<string, unknown>
}

/**
 * Lane events: the TEAM lane made visible.
 *
 * A team run puts several seats in the SAME role (two coder lanes in a duel,
 * three reviewer ballots in a vote, one seat per relay piece), and every one
 * of them spoke the same role, so the operator's dock could only ever show
 * the last of them (one row, one model, no idea who was still working).
 *
 * The lane identity lives in the PAYLOAD (`duel-0`, `vote-1`, `relay-2`) and
 * the seat's role stays on the event itself, so a consumer can tell "the
 * coder seat" from "the coder seat in lane duel-0" without guessing.
 */
export interface LaneStartedPayload {
  /** Stable lane label: `duel-<index>`, `vote-<index>`, `relay-<index>`. */
  lane: string
  /** The model pinned to this lane, or '' when the lane runs unpinned. */
  model: string
  /** The seat's role inside the lane (`coder`, `reviewer`). */
  role: string
  /** The repair round this lane belongs to. */
  round: number
}

export interface LaneCompletedPayload {
  /** Stable lane label (same vocabulary as `LaneStartedPayload`). */
  lane: string
  /** The model that ran the lane, or '' when unpinned. */
  model: string
  /** The seat's role inside the lane. */
  role: string
  /** True when the lane finished its work. */
  ok: boolean
}

export interface LaneScoredPayload {
  /** Stable lane label (same vocabulary as `LaneStartedPayload`). */
  lane: string
  /** The model that ran the lane, or '' when unpinned. */
  model: string
  /** The lane's grade (blocking issues, a ballot score), or null when it has none. */
  score: number | null
  /** What the grade means, in words (`verdict pass`). */
  detail: string
}

export interface FactoryEventSink {
  publish(event: FactoryEvent): Promise<void>
}

export interface FactoryEventReader {
  list(taskId?: string): Promise<FactoryEvent[]>
}
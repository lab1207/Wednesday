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

export interface FactoryEventSink {
  publish(event: FactoryEvent): Promise<void>
}

export interface FactoryEventReader {
  list(taskId?: string): Promise<FactoryEvent[]>
}
import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts'
import type {
  AgentActivity,
} from '../events/types'

import type {
  ClarificationAnswer,
} from './clarification'

export type AgentRoleId =
  | 'architect'
  | 'planner'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'bug-hunter'
  | 'security-audit'

export interface AgentContext {
  task: EngineeringTask
  workspace: string
  previousOutputs: AgentOutput[]

  knowledge?: {
    skills: Array<{
      name: string
      source: string
      provider: string
      content: string
    }>
    rendered: string
  }

  reportToolCall?: (tool: string, payload?: Record<string, unknown>) => void

  /**
   * What the seat is doing while it does it: reasoning pieces, the text it has
   * committed so far, the tools it reaches for, the files it writes.
   *
   * Optional and fire-and-forget: a seat that never reports still produces the
   * same output it always did.
   */
  reportActivity?: (activity: AgentActivity) => void

  /**
   * The operator's answers to the questions this seat asked (2026-11-10).
   *
   * The architect and the planner decide the DIRECTION, so they are the seats
   * that may ask. The run pauses, the operator answers, and the seat runs
   * AGAIN with the answers here -- without them the seat would be asked the
   * same question twice, which is the "it just goes" behaviour in a new coat.
   */
  clarifications?: ClarificationAnswer[]
}

export interface AgentOutput {
  role: AgentRoleId
  summary: string
  instructions?: string
  findings?: string[]
  filesChanged?: string[]
  recommendations?: string[]
  blockingIssues?: string[]
  review?: ReviewResult
engineeringResult?: EngineeringResult
  /**
   * The exchange that produced this output (2026-11-10).
   *
   * The questions the seat asked and the answers the operator gave. It rides
   * in the output so the record of a run says what the direction was, and not
   * only what was built.
   */
  clarifications?: ClarificationAnswer[]
}

export type ReviewVerdict =
  | 'pass'
  | 'fail'

export interface ReviewResult {
  verdict: ReviewVerdict
  summary: string
  findings: string[]
  requiredChanges: string[]
  evidence: string[]
}

export interface AgentRole {
  readonly id: AgentRoleId
  readonly purpose: string
  buildPrompt(context: AgentContext): string
}
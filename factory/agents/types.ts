import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts'
import type {
  AgentActivity,
} from '../events/types'

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
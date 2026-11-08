import type {
  EngineeringResult,
  EngineeringTask,
} from '../contracts'

import type {
  AgentOutput,
  AgentRoleId,
} from '../agents/types'
import type { EngineeringTask } from '../contracts'

export type OrchestratorStatus =
  | 'completed'
  | 'failed'
  | 'blocked'

export interface AgentStep {
  role: AgentRoleId
  status: 'pending' | 'running' | 'completed' | 'failed'
  output?: AgentOutput
  error?: string
}

export interface AgentPlan {
  taskId: string
  steps: AgentRoleId[]
}

export interface RepairAttempt {
  attempt: number
  reason: string[]
  reviewerFindings: string[]
  requiredChanges: string[]
}

export interface OrchestrationResult {
  task: EngineeringTask
  status: OrchestratorStatus
  plan: AgentPlan
  steps: AgentStep[]
  finalOutput?: AgentOutput
  /**
   * Every file the run changed, unioned across all seats.
   *
   * WHY (2026-11-07): `finalOutput` is the LAST seat, which is the reviewer.
   * The reviewer writes no files, so reading the changed-file list from it
   * always produced an empty list -- and the receipt told the operator "no
   * changed files were reported" while the workspace held the page the coder
   * had written. The list is a property of the RUN, not of whichever seat
   * happened to finish last.
   */
  filesChanged: string[]
  engineeringResult?: EngineeringResult
  blockingIssues: string[]
  repairAttempts: RepairAttempt[]
}
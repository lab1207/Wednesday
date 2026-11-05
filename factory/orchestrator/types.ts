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
  engineeringResult?: EngineeringResult
  blockingIssues: string[]
  repairAttempts: RepairAttempt[]
}
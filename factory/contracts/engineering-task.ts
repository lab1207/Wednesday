import type { ModelRequirements } from '../model-router/types'

export interface VerificationPlan {
  setupCommands: string[]
  testCommands: string[]
}

export interface AcceptancePlan {
  requiredFiles: string[]
}

export interface EngineeringTask {
  id: string
  workspace: string
  objective: string
  role?: string
  stack?: string
  constraints: string[]
  acceptanceCriteria: string[]
  modelRequirements?: ModelRequirements
  verification?: VerificationPlan
  acceptance?: AcceptancePlan
}
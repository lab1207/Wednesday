export type EngineeringStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface EngineeringTestResult {
  command: string
  passed: boolean
  output?: string
}

export interface AcceptanceCheckResult {
  criterion: string
  passed: boolean
  details?: string
}

export interface EngineeringResult {
  taskId: string
  status: EngineeringStatus
  summary: string
  output: string
  filesChanged: string[]
  tests: EngineeringTestResult[]
  acceptanceChecks: AcceptanceCheckResult[]
  provider?: string
  model?: string
  diagnostics?: string
}
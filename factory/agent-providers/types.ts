export type CodingAgentId =
  | 'opencode'
  | 'freebuff'
  | 'codex'
  | 'gemini'

export interface CodingAgentRequest {
  taskId: string
  workspace: string
  prompt: string
  model?: string
  timeoutMs?: number
  autoApprove?: boolean
}

export interface CodingAgentResult {
  provider: CodingAgentId
  status: 'completed' | 'failed'
  output: string
  filesChanged: string[]
  diagnostics?: string
}

export interface CodingAgentProvider {
  readonly id: CodingAgentId

  available(): Promise<boolean>

  run(
    request: CodingAgentRequest,
  ): Promise<CodingAgentResult>
}
import type {
  AgentContext,
  AgentRole,
  AgentRoleId,
} from './types'

function baseTask(context: AgentContext): string {
  const { task } = context

  return [
    `Objective: ${task.objective}`,
    task.role ? `Requested role: ${task.role}` : undefined,
    task.stack ? `Stack: ${task.stack}` : undefined,
    task.constraints.length > 0
      ? `Constraints:\n${task.constraints.map(x => `- ${x}`).join('\n')}`
      : undefined,
    task.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map(x => `- ${x}`).join('\n')}`
      : undefined,
    `Workspace: ${context.workspace}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join('\n')
}

const MAX_SUMMARY = 1000
const MAX_INSTRUCTIONS = 2000
const MAX_ITEM = 1500
const MAX_RECOMMENDATION = 1000
const MAX_PREVIOUS_OUTPUTS = 5

function limitOutputItem(
  value: string,
  max: number,
): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n[... truncated ${value.length - max} characters]`
}

function previousOutputs(context: AgentContext): string {
  const outputs = context.previousOutputs.slice(-MAX_PREVIOUS_OUTPUTS)

  if (outputs.length === 0) {
    return 'No previous agent outputs.'
  }

  return outputs
    .map(output => {
      const lines = [
        `[${output.role}] ${limitOutputItem(output.summary, MAX_SUMMARY)}`,
      ]

      if (output.instructions) {
        lines.push(`Instructions: ${limitOutputItem(output.instructions, MAX_INSTRUCTIONS)}`)
      }

      if (output.findings?.length) {
        lines.push(
          `Findings:\n${output.findings
            .slice(0, 6)
            .map(x => `- ${limitOutputItem(x, MAX_ITEM)}`)
            .join('\n')}`,
        )
      }

      if (output.recommendations?.length) {
        lines.push(
          `Recommendations:\n${output.recommendations
            .slice(0, 6)
            .map(x => `- ${limitOutputItem(x, MAX_RECOMMENDATION)}`)
            .join('\n')}`,
        )
      }

      if (output.blockingIssues?.length) {
        lines.push(
          `Blocking issues:\n${output.blockingIssues
            .slice(0, 6)
            .map(x => `- ${limitOutputItem(x, MAX_ITEM)}`)
            .join('\n')}`,
        )
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

function createRole(
  id: AgentRoleId,
  purpose: string,
  instructions: string,
): AgentRole {
  return {
    id,
    purpose,
    buildPrompt(context) {
      return [
        `You are the ${id} agent.`,
        `Your purpose: ${purpose}`,
        '',
        baseTask(context),
        '',
        'Previous agent outputs:',
        previousOutputs(context),
        '',
        instructions,
        '',
        'Do not silently change the task requirements.',
        'Return a concise structured report for the next agent.',
      ].join('\n')
    },
  }
}

export const architectAgent = createRole(
  'architect',
  'understand the system problem and design the solution before implementation.',
  [
    'Inspect the workspace and existing architecture.',
    'Identify relevant components, dependencies, interfaces, and risks.',
    'Propose an implementation architecture.',
    'Do not implement code.',
    'Produce concrete guidance for the planner.',
  ].join('\n'),
)

export const plannerAgent = createRole(
  'planner',
  'turn the architectural direction into an ordered implementation plan.',
  [
    'Break the work into small executable steps.',
    'Identify files or modules that need to be created or changed.',
    'Define the order of implementation.',
    'Define how each acceptance criterion will be verified.',
    'Do not implement the solution.',
  ].join('\n'),
)

export const coderAgent = createRole(
  'coder',
  'implement the planned solution in the assigned workspace.',
  [
    'Follow the architectural and planning outputs.',
    'Inspect existing code before changing it.',
    'Implement the required changes.',
    'Use the provided tools to read and write files. NEVER write a tool call as text, markdown, or a code fence — a tool call written as text is never executed, and the task fails.',
    'If a required file does not exist yet, create it with the write tool instead of only trying to read it.',
    'Keep changes focused on the task.',
    'Run available checks when practical.',
    'Report exactly what was changed.',
  ].join('\n'),
)

export const testerAgent = createRole(
  'tester',
  'verify the implementation objectively.',
  [
    'Inspect the implementation and test coverage.',
    'Run the verification commands available to the workspace.',
    'Look for functional, integration, and regression problems.',
    'Do not assume the coder is correct.',
    'Report concrete failures and reproduction information.',
  ].join('\n'),
)

export const reviewerAgent = createRole(
  'reviewer',
  'perform a final engineering review against the task and evidence.',
  [
    'Compare the implementation against the original objective.',
    'Check every acceptance criterion.',
    'Consider correctness, maintainability, security, and regressions.',
    'Do not approve based solely on the coder report.',
    'Identify remaining blockers or explicitly state that the work is ready.',
  ].join('\n'),
)

export const AGENT_ROLES: readonly AgentRole[] = [
  architectAgent,
  plannerAgent,
  coderAgent,
  testerAgent,
  reviewerAgent,
]
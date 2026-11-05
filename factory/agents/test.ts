import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import { AgentRegistry } from './index'
import type { AgentContext } from './types'

const registry = new AgentRegistry()

const context: AgentContext = {
  task: {
    id: 'agent-role-test-001',
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
    objective: 'Build a small Python calculator.',
    role: 'backend',
    stack: 'python',
    constraints: [
      'Use pytest',
    ],
    acceptanceCriteria: [
      'Calculator works',
      'Tests pass',
    ],
  },
  workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
  previousOutputs: [],
}

for (const role of registry.list()) {
  const agent = registry.get(role)

  console.log(JSON.stringify({
    role: agent.id,
    purpose: agent.purpose,
    promptPreview: agent.buildPrompt(context).slice(0, 240),
  }, null, 2))
}
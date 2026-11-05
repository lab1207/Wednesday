import type { AgentRole, AgentRoleId } from './types'
import { AGENT_ROLES } from './roles'

export class AgentRegistry {
  private readonly roles = new Map<AgentRoleId, AgentRole>(
    AGENT_ROLES.map(role => [role.id, role]),
  )

  get(role: AgentRoleId): AgentRole {
    const value = this.roles.get(role)

    if (value === undefined) {
      throw new Error(`Unknown agent role: ${role}`)
    }

    return value
  }

  list(): AgentRoleId[] {
    return [...this.roles.keys()]
  }
}
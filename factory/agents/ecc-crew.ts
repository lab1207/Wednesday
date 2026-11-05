/**
 * ECC specialist crew — small-crew-first multi-agent wiring (user direction
 * 2026-09-21). The ECC checkout ships 68 agent playbooks
 * (`ecc-source/agents/*.md`, gitignored like dsh); the Factory does NOT
 * spawn them as separate loops. Instead a small crew (code-reviewer,
 * python-reviewer, security-reviewer, silent-failure-hunter) is loaded as
 * review checklists and injected into the pipeline — the same proven
 * pattern as the C3 planner handoff (offline-selected, prompt-injected,
 * unit-tested, live-usable later with zero harness changes).
 *
 * Selection follows ECC's own orchestration table: code written →
 * code-reviewer (+ stack reviewer); bug fix / failure loop →
 * silent-failure-hunter; security-sensitive → security-reviewer.
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EccAgent {
  readonly name: string
  readonly description: string
  /** Prompt body after frontmatter, capped for context budgets. */
  readonly body: string
}

/** Small crew wired first; the 68-file catalog expands only after this proves out. */
export const SMALL_CREW = [
  'code-reviewer',
  'python-reviewer',
  'security-reviewer',
  'silent-failure-hunter',
  'build-error-resolver',
  'tdd-guide',
] as const

export function defaultEccAgentsHome(): string {
  return (
    process.env.ECC_AGENTS_HOME ??
    join(fileURLToPath(new URL('../..', import.meta.url)), 'ecc-source', 'agents')
  )
}

const BODY_CAP = 3000

export function parseEccAgentFile(fileName: string, text: string): EccAgent | null {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  let name = ''
  let description = ''
  for (const line of lines.slice(1, end)) {
    const nameMatch = /^name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch) name = nameMatch[1]
    const descMatch = /^description:\s*(.+?)\s*$/.exec(line)
    if (descMatch) description = descMatch[1]
  }
  if (!name) {
    const base = fileName.replace(/\.md$/, '')
    name = base
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim()
    .slice(0, BODY_CAP)
  return { name, description, body }
}

export async function loadEccAgent(
  agentsHome: string,
  name: string,
): Promise<EccAgent | null> {
  try {
    const text = await readFile(join(agentsHome, `${name}.md`), 'utf8')
    return parseEccAgentFile(`${name}.md`, text)
  } catch {
    return null
  }
}

export async function loadSmallCrew(
  agentsHome: string = defaultEccAgentsHome(),
): Promise<EccAgent[]> {
  const crew: EccAgent[] = []
  for (const name of SMALL_CREW) {
    const agent = await loadEccAgent(agentsHome, name)
    if (agent) crew.push(agent)
  }
  return crew
}

/** Process-lifetime cache: the checkout is static, reviews must not re-read it. */
let cachedCrew: EccAgent[] | undefined
let cachedCatalog: EccAgent[] | undefined

export async function getCachedSmallCrew(): Promise<EccAgent[]> {
  if (cachedCrew === undefined) {
    try {
      cachedCrew = await loadSmallCrew()
    } catch {
      cachedCrew = []
    }
  }
  return cachedCrew
}

/**
 * Sync variant for sync prompt builders: same cache semantics, first call
 * reads small files synchronously once. Silent on absence.
 */
export function getCachedSmallCrewSync(home?: string): EccAgent[] {
  const root = home ?? defaultEccAgentsHome()
  const key = `sync\u0000${root}`
  const hit = syncCrewCache.get(key)
  if (hit) return hit
  const crew: EccAgent[] = []
  try {
    for (const name of SMALL_CREW) {
      try {
        const text = readFileSync(join(root, `${name}.md`), 'utf8')
        const agent = parseEccAgentFile(`${name}.md`, text)
        if (agent) crew.push(agent)
      } catch {
        // One missing specialist never breaks the crew.
      }
    }
  } catch {
    return []
  }
  syncCrewCache.set(key, crew)
  return crew
}

const syncCrewCache = new Map<string, EccAgent[]>()

export async function getCachedCatalog(): Promise<EccAgent[]> {
  if (cachedCatalog === undefined) {
    cachedCatalog = []
    try {
      const names = await listEccCatalog()
      for (const name of names) {
        const agent = await loadEccAgent(defaultEccAgentsHome(), name)
        if (agent) cachedCatalog.push(agent)
      }
    } catch {
      cachedCatalog = []
    }
  }
  return cachedCatalog
}

export async function listEccCatalog(
  agentsHome: string = defaultEccAgentsHome(),
): Promise<string[]> {
  try {
    return (await readdir(agentsHome))
      .filter((file: string) => file.endsWith('.md'))
      .map((file: string) => file.replace(/\.md$/, ''))
      .sort()
  } catch {
    return []
  }
}

function taskText(task: {
  objective?: string
  stack?: string
  role?: string
}): string {
  return `${task.objective ?? ''}\n${task.stack ?? ''}\n${task.role ?? ''}`.toLowerCase()
}

/**
 * Select crew members for a task. code-reviewer is the default spine;
 * stack/sensitivity keywords add specialists. `maxAgents` caps the pick
 * (difficulty band). Pure function of the loaded crew + task text —
 * offline-safe.
 */
export function selectCrewForTask(
  crew: EccAgent[],
  task: { objective?: string; stack?: string; role?: string },
  maxAgents = Number.POSITIVE_INFINITY,
): EccAgent[] {
  const text = taskText(task)
  const byName = new Map(crew.map(agent => [agent.name, agent]))
  const selected: EccAgent[] = []
  const push = (name: string): void => {
    const agent = byName.get(name)
    if (agent && !selected.includes(agent)) selected.push(agent)
  }
  push('code-reviewer')
  if (/(python|\.py\b|pytest|pandas|django|fastapi)/.test(text)) push('python-reviewer')
  if (/(rust|cargo|\.rs\b)/.test(text)) {
    const rust = byName.get('rust-reviewer')
    if (rust && !selected.includes(rust)) selected.push(rust)
  }
  if (/(auth|secret|password|token|crypto|sql|inject|permission|credential)/.test(text)) {
    push('security-reviewer')
  }
  if (/(fix|bug|repair|fail|error|broken|regress)/.test(text)) push('silent-failure-hunter')
  // Repair-adjacent specialists: build breaks route to the resolver,
  // verification work routes to the TDD guide. Keywords stay narrow so
  // plain tasks keep the spine-only shape (no context-budget creep).
  if (/(build|compile|tsc|type error|cannot find module|test fail|red test)/.test(text)) {
    push('build-error-resolver')
  }
  if (/(test|tdd|coverage|verify|verification|pytest|\bqa\b)/.test(text)) {
    push('tdd-guide')
  }
  return selected.slice(0, Math.max(1, Math.floor(maxAgents)))
}

/** Small domain bridge so task words meet catalog words (auth→security…). */
const RANK_SYNONYMS: Record<string, string[]> = {
  auth: ['security'],
  password: ['security'],
  token: ['security'],
  login: ['security'],
  secret: ['security'],
  credential: ['security'],
  bug: ['fix', 'debug'],
  fix: ['debug', 'test'],
  race: ['concurrency'],
  parallel: ['concurrency'],
  review: ['reviewer', 'quality'],
  test: ['testing', 'qa'],
}

/**
 * Rank the FULL catalog for a task by keyword overlap (name + description
 * vs task text) so high bands can activate beyond the small crew.
 * Deterministic, offline-safe. Ties break alphabetically.
 */
export function rankCatalog(
  catalog: EccAgent[],
  task: { objective?: string; stack?: string; role?: string },
  limit: number,
): EccAgent[] {
  const words = new Set(
    `${task.objective ?? ''} ${task.stack ?? ''} ${task.role ?? ''}`
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter(word => word.length > 2),
  )
  for (const word of [...words]) {
    for (const synonym of RANK_SYNONYMS[word] ?? []) {
      words.add(synonym)
    }
  }
  const scored = catalog.map(agent => {
    const haystack = `${agent.name} ${agent.description}`.toLowerCase().replace(/[-_]/g, ' ')
    let score = 0
    for (const word of words) {
      if (haystack.includes(word)) score += 1
    }
    if (agent.name === 'code-reviewer') score += 2
    return { agent, score }
  })
  scored.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
  return scored.slice(0, Math.max(0, Math.floor(limit))).map(entry => entry.agent)
}

/**
 * Render selected specialists as a review checklist section for prompt
 * injection (reviewer first, coder on repair). Capped and silent when
 * the crew is empty — same contract as buildPlannerGuidance.
 */
export function buildCrewGuidance(agents: EccAgent[]): string {
  if (agents.length === 0) return ''
  const sections = agents.map(agent => {
    const checklist = agent.body
      .split('\n')
      .filter(line => /^-|^\d+\.|^#{2,4} /.test(line.trim()))
      .slice(0, 12)
      .join('\n')
    return [
      `### Specialist: ${agent.name}`,
      agent.description,
      checklist,
    ].join('\n')
  })
  return ['## Specialist review checklist (ECC crew)', ...sections].join('\n\n')
}

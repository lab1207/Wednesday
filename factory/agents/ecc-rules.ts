/**
 * ECC engineering rules — waking the dormant `rules/` surface (user
 * direction 2026-09-21: wake the factory, don't let layers sleep). The
 * checkout carries always-follow guidelines per stack
 * (`ecc-source/rules/<stack>/{coding-style,patterns,security,testing}.md`
 * plus `common/`), none of which the Factory ever read. Same injection
 * pattern as the crew: load once, select per task stack, inject into BOTH
 * coder prompts, silent when absent. Coders get rules (how to write);
 * reviewers get checklists (how to judge) — that split stays.
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EccRule {
  readonly stack: string
  readonly kind: string
  readonly body: string
}

/** Rule files that carry enforceable guidance (hooks/ are agent triggers, not rules). */
const RULE_KINDS = ['coding-style', 'patterns', 'security', 'testing'] as const

const BODY_CAP = 1500

export function defaultEccRulesHome(): string {
  return (
    process.env.ECC_RULES_HOME ??
    join(fileURLToPath(new URL('../..', import.meta.url)), 'ecc-source', 'rules')
  )
}

function stackDir(task: { stack?: string; objective?: string }): string | null {
  const text = `${task.stack ?? ''}\n${task.objective ?? ''}`.toLowerCase()
  if (/(^|\W)python(\W|$)|django|fastapi|\.py\b|pytest/.test(text)) return 'python'
  if (/(^|\W)rust(\W|$)|cargo|\.rs\b/.test(text)) return 'rust'
  if (/(^|\W)go(\W|$)|golang/.test(text)) return 'golang'
  if (/(^|\W)java(\W|$)|spring|maven|gradle/.test(text)) return 'java'
  if (/react|jsx|\.tsx\b/.test(text)) return 'react'
  if (/vue|\.vue\b/.test(text)) return 'vue'
  if (/angular/.test(text)) return 'angular'
  if (/typescript|\.ts\b|javascript|\.js\b|node|npm|tsx/.test(text)) return 'typescript'
  if (/(^|\W)cpp(\W|$)|c\+\+|cmake/.test(text)) return 'cpp'
  if (/(^|\W)php(\W|$)|laravel/.test(text)) return 'php'
  if (/(^|\W)ruby(\W|$)|rails/.test(text)) return 'ruby'
  if (/(^|\W)swift(\W|$)|xcode/.test(text)) return 'swift'
  if (/(^|\W)kotlin(\W|$)|android/.test(text)) return 'kotlin'
  return null
}

async function loadRuleFile(home: string, stack: string, kind: string): Promise<EccRule | null> {
  try {
    const body = (await readFile(join(home, stack, `${kind}.md`), 'utf8')).trim().slice(0, BODY_CAP)
    if (!body) return null
    return { stack, kind, body }
  } catch {
    return null
  }
}

/** common/* always; plus the task stack dir when one matches. */
export async function loadRulesForTask(
  task: { stack?: string; objective?: string },
  home: string = defaultEccRulesHome(),
): Promise<EccRule[]> {
  const rules: EccRule[] = []
  for (const kind of RULE_KINDS) {
    const rule = await loadRuleFile(home, 'common', kind)
    if (rule) rules.push(rule)
  }
  const dir = stackDir(task)
  if (dir && dir !== 'common') {
    for (const kind of RULE_KINDS) {
      const rule = await loadRuleFile(home, dir, kind)
      if (rule) rules.push(rule)
    }
  }
  return rules
}

/** Process-lifetime cache: the checkout is static, coders must not re-read it. */
let cachedByKey = new Map<string, EccRule[]>()

export async function getCachedRulesForTask(task: {
  stack?: string
  objective?: string
}): Promise<EccRule[]> {
  const key = `${task.stack ?? ''}\u0000${(task.objective ?? '').slice(0, 120)}`
  const hit = cachedByKey.get(key)
  if (hit) return hit
  try {
    const rules = await loadRulesForTask(task)
    cachedByKey.set(key, rules)
    return rules
  } catch {
    return []
  }
}

/**
 * Sync variant for sync prompt builders (external coder path): same cache,
 * first call reads small files synchronously once. Silent on absence.
 */
export function getCachedRulesForTaskSync(task: {
  stack?: string
  objective?: string
  home?: string
}): EccRule[] {
  const home = task.home ?? defaultEccRulesHome()
  const key = `sync\u0000${home}\u0000${task.stack ?? ''}\u0000${(task.objective ?? '').slice(0, 120)}`
  const hit = cachedByKey.get(key)
  if (hit) return hit
  const rules: EccRule[] = []
  try {
    const stacks = ['common']
    const dir = stackDir(task)
    if (dir && dir !== 'common') stacks.push(dir)
    for (const stack of stacks) {
      for (const kind of RULE_KINDS) {
        try {
          const body = readFileSync(join(home, stack, `${kind}.md`), 'utf8').trim().slice(0, BODY_CAP)
          if (body) rules.push({ stack, kind, body })
        } catch {
          // Missing kind file: skip.
        }
      }
    }
  } catch {
    return []
  }
  cachedByKey.set(key, rules)
  return rules
}

/**
 * Render rules as a coder prompt section. Silent when empty — the coder
 * prompt must never break on rules availability.
 */
export function buildRulesGuidance(rules: EccRule[]): string {
  if (rules.length === 0) return ''
  const sections = rules.map(rule => [`### ${rule.stack}/${rule.kind}`, rule.body].join('\n'))
  return ['## ENGINEERING RULES (always follow)', ...sections].join('\n\n')
}

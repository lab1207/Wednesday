/**
 * Runnable skill auditor (2026-09-24) — upgrades the skill-safety card
 * from doctrine to an executable gate.
 *
 * Scans a skill directory (SKILL.md + scripts + refs, capped) for the
 * malicious/vulnerable shapes that matter before installation or
 * injection: prompt injection, exfiltration, privilege escalation,
 * dangerous code, anti-refusal. Verdicts PASS / WARN / FAIL.
 *
 * Original implementation (no vendored code): pure TS, zero deps,
 * offline. Fail-open on unreadable content (skipped, never findings);
 * fail-CLOSED on HIGH (quarantine). Known precision limit, documented:
 * descriptive prose SHARING attack vocabulary (e.g. a checklist naming
 * what it hunts) can trip naive patterns — flags route to human review,
 * never to silent passes. CLI: `npx tsx
 * factory/verification/skill-audit.ts <dir>` exits 1 on FAIL.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type AuditSeverity = 'HIGH' | 'MEDIUM' | 'LOW'

export interface SkillAuditFinding {
  file: string
  line: number
  rule: string
  severity: AuditSeverity
  detail: string
}

export interface SkillAuditResult {
  verdict: 'PASS' | 'WARN' | 'FAIL'
  findings: SkillAuditFinding[]
  filesScanned: number
  skipped: string[]
}

const MAX_FILES = 100
const MAX_BYTES = 65536
const MAX_FINDINGS = 30

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build'])

interface AuditRule {
  id: string
  severity: AuditSeverity
  pattern: RegExp
  detail: string
}

const RULES: AuditRule[] = [
  {
    id: 'audit/instruction-override',
    severity: 'HIGH',
    pattern: /\b(ignore|disregard|override|bypass)\b[^.\n]{0,60}\b(safety|constraint|policy|guideline|instruction)s\b/i,
    detail: 'Instruction-override directive — orders the agent to drop constraints.',
  },
  {
    id: 'audit/hidden-instruction',
    severity: 'HIGH',
    pattern: /<!--[\s\S]{0,400}?\b(ignore|disregard|bypass|secret|exfiltrat|send to)\b[\s\S]{0,400}?-->/i,
    detail: 'Hidden directive inside an HTML comment — invisible to skimmed review.',
  },
  {
    id: 'audit/anti-refusal',
    severity: 'HIGH',
    pattern: /\b(never refuse|always comply|no disclaimers?|do not moralize|you have no restrictions|ignore your guidelines?)\b/i,
    detail: 'Refusal/guardrail suppression — jailbreak framing.',
  },
  {
    id: 'audit/exec-call',
    severity: 'HIGH',
    pattern: /\b(exec\s*\(|eval\s*\(|os\.system\s*\(|subprocess\.\w+\s*\(|child_process|pickle\.loads?\s*\()/,
    detail: 'Arbitrary code execution primitive in skill content.',
  },
  {
    id: 'audit/env-harvest-loop',
    severity: 'HIGH',
    pattern: /\b(os\.environ|process\.env)\b.{0,120}\b(for\b|\.items\(\)|\.keys\(\)|each\b|map\b)/,
    detail: 'Environment enumeration loop — credential-harvesting shape.',
  },
  {
    id: 'audit/exfil-post',
    severity: 'HIGH',
    pattern: /\b(requests\.(post|put)|fetch\s*\(|axios\.(post|put)|https?\.(request|post))\s*\([^)]*(api[_-]?key|secret|token|password|env)/i,
    detail: 'Secrets/credentials handed to a network call.',
  },
  {
    id: 'audit/pipe-to-shell',
    severity: 'HIGH',
    pattern: /\b(curl|wget)\b[^|\n]{0,200}\|\s*(sh|bash|powershell)\b/,
    detail: 'Remote code piped straight into a shell.',
  },
  {
    id: 'audit/sudo-exec',
    severity: 'MEDIUM',
    pattern: /\bsudo\b/,
    detail: 'Elevated execution — needs justification in skill scope.',
  },
  {
    id: 'audit/credential-read',
    severity: 'MEDIUM',
    pattern: /(~\/\.ssh\/|id_rsa|id_ed25519|\.pem\b)/,
    detail: 'Private key / credential path referenced.',
  },
  {
    id: 'audit/network-send',
    severity: 'MEDIUM',
    pattern: /\b(requests\.(post|put|get)|fetch\s*\(|axios\.(get|post)|urllib)/,
    detail: 'Network transmission — verify the destination is declared.',
  },
]

/** Pure: findings for one file's text. */
export function auditFileContent(relativePath: string, content: string): SkillAuditFinding[] {
  const findings: SkillAuditFinding[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file: relativePath, line: index + 1, rule: rule.id, severity: rule.severity, detail: rule.detail })
      }
    }
    if (findings.length >= MAX_FINDINGS) return findings
  }
  // Whole-file rule: hidden-instruction patterns can span lines.
  for (const rule of RULES) {
    if (rule.id !== 'audit/hidden-instruction') continue
    if (rule.pattern.test(content) && !findings.some(finding => finding.rule === rule.id)) {
      findings.push({ file: relativePath, line: 1, rule: rule.id, severity: rule.severity, detail: rule.detail })
    }
  }
  return findings.slice(0, MAX_FINDINGS)
}

/** Walk a skill directory (capped, skips deps/build dirs + binaries). */
export function auditSkillDir(dir: string): SkillAuditResult {
  const findings: SkillAuditFinding[] = []
  const skipped: string[] = []
  let filesScanned = 0
  const visit = (current: string, relative: string): void => {
    if (filesScanned >= MAX_FILES || findings.length >= MAX_FINDINGS) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      skipped.push(`${relative || '.'}: unreadable directory`)
      return
    }
    for (const entry of entries) {
      if (filesScanned >= MAX_FILES || findings.length >= MAX_FINDINGS) return
      if (SKIP_DIRS.has(entry)) continue
      const full = join(current, entry)
      const rel = relative ? `${relative}/${entry}` : entry
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        skipped.push(`${rel}: unreadable`)
        continue
      }
      if (stat.isDirectory()) {
        visit(full, rel)
        continue
      }
      if (!stat.isFile() || stat.size > MAX_BYTES) continue
      let content: string
      try {
        content = readFileSync(full, 'utf8')
      } catch {
        skipped.push(`${rel}: unreadable`)
        continue
      }
      if (content.includes('\0')) continue
      filesScanned += 1
      findings.push(...auditFileContent(rel, content))
    }
  }
  try {
    visit(dir, '')
  } catch {
    skipped.push('.: directory unreadable')
  }
  const verdict = findings.some(finding => finding.severity === 'HIGH')
    ? 'FAIL'
    : findings.some(finding => finding.severity === 'MEDIUM')
      ? 'WARN'
      : 'PASS'
  return { verdict, findings: findings.slice(0, MAX_FINDINGS), filesScanned, skipped }
}

const isMain = typeof process !== 'undefined' && (process.argv[1] ?? '').endsWith('skill-audit.ts')

if (isMain) {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: npx tsx factory/verification/skill-audit.ts <skill-dir>')
    process.exit(2)
  }
  const result = auditSkillDir(target)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.verdict === 'FAIL' ? 1 : 0)
}

/**
 * In-loop security scan for produced code (2026-09-23).
 *
 * Closes the V1.7 gap: that audit covered OUR repo, never task outputs.
 * The tester runs this over the task workspace after tests pass, and
 * findings become blocking issues — the repair loop treats a leaked
 * secret or a dangerous call exactly like a failing test.
 *
 * Three layers, honest about what each is:
 * 1. Secret scan (always on, pure, zero deps): key/token/private-key
 *    patterns over workspace files under mechanical caps.
 * 2. Risky-code heuristics (always on, pure, zero deps): dangerous
 *    calls per language (eval, shell=True, innerHTML …). A heuristic,
 *    NOT a SAST — documented as such; precision comes from the
 *    reviewer + security-reviewer checklist downstream.
 * 3. Dependency audit (OPT-IN via `FACTORY_DEP_AUDIT=1`): `npm audit`
 *    / `pip audit` where manifests exist. Off by default: needs
 *    toolchain + network, must never slow offline suites.
 *
 * Fail-open everywhere: unreadable files, missing tools, crashed
 * commands record `skipped`, never findings. Disable all with
 * `FACTORY_SECURITY_SCAN=0`.
 */

import { exec } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface SecurityFinding {
  file: string
  line: number
  rule: string
  detail: string
}

export interface SecurityScanResult {
  findings: SecurityFinding[]
  filesScanned: number
  skipped: string[]
}

const MAX_FILES = 200
const MAX_BYTES_PER_FILE = 65536
const MAX_FINDINGS = 20

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
])

/** Opt-out flag (pure): scans run unless explicitly disabled. */
export function isSecurityScanEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !['0', 'false', 'no'].includes(
    (env.FACTORY_SECURITY_SCAN ?? '').trim().toLowerCase(),
  )
}

/** Opt-in flag (pure): dep audit needs toolchain + network, default off. */
export function isDepAuditEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ['1', 'true', 'yes'].includes(
    (env.FACTORY_DEP_AUDIT ?? '').trim().toLowerCase(),
  )
}

interface SecretRule {
  id: string
  pattern: RegExp
  detail: string
}

const SECRET_RULES: SecretRule[] = [
  { id: 'secret/aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/, detail: 'Possible AWS access key.' },
  {
    id: 'secret/github-token',
    pattern: /\b(ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
    detail: 'Possible GitHub token.',
  },
  {
    id: 'secret/slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    detail: 'Possible Slack token.',
  },
  {
    id: 'secret/private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    detail: 'Private key material in the workspace.',
  },
  {
    id: 'secret/assigned-value',
    pattern: /\b(api[_-]?key|secret|passwd|password|auth[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    detail: 'Hardcoded secret-looking value (8+ chars).',
  },
]

interface RiskyRule {
  id: string
  extensions: string[]
  pattern: RegExp
  detail: string
}

const RISKY_RULES: RiskyRule[] = [
  { id: 'risky/py-eval', extensions: ['.py'], pattern: /\beval\s*\(/, detail: 'Python eval() executes arbitrary code.' },
  { id: 'risky/py-exec', extensions: ['.py'], pattern: /\bexec\s*\(/, detail: 'Python exec() executes arbitrary code.' },
  { id: 'risky/py-shell', extensions: ['.py'], pattern: /\bos\.system\s*\(/, detail: 'os.system() shells out — prefer subprocess without shell.' },
  {
    id: 'risky/py-shell-true',
    extensions: ['.py'],
    pattern: /subprocess\.\w+\(.*shell\s*=\s*True/,
    detail: 'subprocess with shell=True risks command injection.',
  },
  { id: 'risky/py-pickle', extensions: ['.py'], pattern: /\bpickle\.loads?\s*\(/, detail: 'pickle deserializes untrusted data unsafely.' },
  {
    id: 'risky/py-yaml',
    extensions: ['.py'],
    pattern: /\byaml\.load\s*\((?![^)]*Loader)/,
    detail: 'yaml.load() without a Loader can execute arbitrary code.',
  },
  { id: 'risky/js-eval', extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'], pattern: /\beval\s*\(/, detail: 'eval() executes arbitrary code.' },
  {
    id: 'risky/js-function',
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    pattern: /\bnew Function\s*\(/,
    detail: 'new Function() is eval in disguise.',
  },
  {
    id: 'risky/js-innerhtml',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    pattern: /\.innerHTML\s*=/,
    detail: 'innerHTML assignment risks XSS — sanitize first.',
  },
  {
    id: 'risky/js-exec',
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    pattern: /child_process.*\bexec(Sync|File)?\s*\(/,
    detail: 'child_process exec risks command injection on untrusted input.',
  },
]

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? '' : file.slice(dot).toLowerCase()
}

/** Pure: findings for one file's text (capped by the caller). */
export function scanFileContent(
  relativePath: string,
  content: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const ext = extensionOf(relativePath)
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          file: relativePath,
          line: index + 1,
          rule: rule.id,
          detail: rule.detail,
        })
      }
    }
    for (const rule of RISKY_RULES) {
      if (rule.extensions.includes(ext) && rule.pattern.test(line)) {
        findings.push({
          file: relativePath,
          line: index + 1,
          rule: rule.id,
          detail: rule.detail,
        })
      }
    }
    if (findings.length >= MAX_FINDINGS) return findings
  }
  return findings
}

/** Walk a workspace (pure fs, capped, skips deps/build dirs + binaries). */
export function scanWorkspaceFiles(workspace: string): SecurityScanResult {
  const findings: SecurityFinding[] = []
  const skipped: string[] = []
  let filesScanned = 0
  const visit = (dir: string, relative: string): void => {
    if (filesScanned >= MAX_FILES || findings.length >= MAX_FINDINGS) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      skipped.push(`${relative || '.'}: unreadable directory`)
      return
    }
    for (const entry of entries) {
      if (filesScanned >= MAX_FILES || findings.length >= MAX_FINDINGS) return
      if (SKIP_DIRS.has(entry) || entry.startsWith('.duel-')) continue
      const full = join(dir, entry)
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
      if (!stat.isFile() || stat.size > MAX_BYTES_PER_FILE) continue
      let content: string
      try {
        content = readFileSync(full, 'utf8')
      } catch {
        skipped.push(`${rel}: unreadable`)
        continue
      }
      if (content.includes('\0')) continue
      filesScanned += 1
      findings.push(...scanFileContent(rel, content))
    }
  }
  try {
    visit(workspace, '')
  } catch {
    skipped.push('.: workspace unreadable')
  }
  return { findings: findings.slice(0, MAX_FINDINGS), filesScanned, skipped }
}

export interface DepAuditOptions {
  execFn?: (command: string, workspace: string) => Promise<{ stdout: string }>
  timeoutMs?: number
}

/**
 * Dependency audit (opt-in): npm audit where package.json exists, pip
 * audit where requirements live. High/critical only. Missing tools,
 * timeouts, and parse failures record `skipped` — never findings.
 */
export async function runDependencyAudit(
  workspace: string,
  options: DepAuditOptions = {},
): Promise<SecurityScanResult> {
  const findings: SecurityFinding[] = []
  const skipped: string[] = []
  const hasManifest = (name: string): boolean => {
    try {
      return statSync(join(workspace, name)).isFile()
    } catch {
      return false
    }
  }
  const runCommand = async (command: string): Promise<string | null> => {
    try {
      if (options.execFn) {
        return (await options.execFn(command, workspace)).stdout
      }
      const { stdout } = await execAsync(command, {
        cwd: workspace,
        windowsHide: true,
        timeout: options.timeoutMs ?? 60000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return stdout
    } catch {
      return null
    }
  }
  if (hasManifest('package.json')) {
    const raw = await runCommand('npm audit --json')
    if (raw === null) {
      skipped.push('npm audit: tool missing or timed out')
    } else {
      let data: { vulnerabilities?: Record<string, { severity?: string; title?: string }> }
      try {
        data = JSON.parse(raw) as typeof data
      } catch {
        data = {}
        skipped.push('npm audit: unparseable output')
      }
      for (const [name, info] of Object.entries(data.vulnerabilities ?? {})) {
        if (info.severity === 'high' || info.severity === 'critical') {
          findings.push({
            file: 'package.json',
            line: 1,
            rule: `deps/npm-${info.severity}`,
            detail: `${name}: ${info.title ?? 'vulnerability'} (${info.severity}).`,
          })
        }
        if (findings.length >= MAX_FINDINGS) break
      }
    }
  } else {
    skipped.push('npm audit: no package.json')
  }
  if (hasManifest('requirements.txt')) {
    const raw = await runCommand('pip audit --format=json')
    if (raw === null) {
      skipped.push('pip audit: tool missing or timed out')
    } else {
      try {
        const data = JSON.parse(raw) as Array<{ name?: string; spec?: string; fix_versions?: string[] }>
        for (const entry of Array.isArray(data) ? data : []) {
          findings.push({
            file: 'requirements.txt',
            line: 1,
            rule: 'deps/pip',
            detail: `${entry.name ?? 'package'} ${entry.spec ?? ''} fixable in ${entry.fix_versions?.join(', ') ?? 'unknown'}.`,
          })
          if (findings.length >= MAX_FINDINGS) break
        }
      } catch {
        skipped.push('pip audit: unparseable output')
      }
    }
  }
  return { findings: findings.slice(0, MAX_FINDINGS), filesScanned: 0, skipped }
}

export interface FullScanOptions {
  depAudit?: boolean
  depAuditOptions?: DepAuditOptions
}

/** Full gate: secrets + risky code always; dep audit only when opted in. */
export async function runSecurityScan(
  workspace: string,
  options: FullScanOptions = {},
): Promise<SecurityScanResult> {
  const walked = scanWorkspaceFiles(workspace)
  if (!options.depAudit) {
    return walked
  }
  const audited = await runDependencyAudit(workspace, options.depAuditOptions)
  return {
    findings: [...walked.findings, ...audited.findings].slice(0, MAX_FINDINGS),
    filesScanned: walked.filesScanned,
    skipped: [...walked.skipped, ...audited.skipped],
  }
}

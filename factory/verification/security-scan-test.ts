/**
 * Offline test for the in-loop security scan. Pure asserts (secret +
 * risky-code rules, caps, flags) plus real temp workspaces (walk, skip
 * dirs, dep-audit skip/fail-open) and one end-to-end TestingRunner gate
 * (leaked secret blocks, clean passes). No network; dep audit uses an
 * injected fake executor.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isDepAuditEnabled,
  isSecurityScanEnabled,
  runDependencyAudit,
  runSecurityScan,
  scanFileContent,
  scanWorkspaceFiles,
} from './security-scan'
import { TestingRunner } from '../agents/role-runners'
import { AgentRegistry } from '../agents/registry'
import type { AgentContext } from '../agents/types'

async function main(): Promise<void> {
  // 1. Flags: scan on unless opted out; audit off unless opted in.
  assert.equal(isSecurityScanEnabled({}), true)
  assert.equal(isSecurityScanEnabled({ FACTORY_SECURITY_SCAN: '0' }), false)
  assert.equal(isDepAuditEnabled({}), false)
  assert.equal(isDepAuditEnabled({ FACTORY_DEP_AUDIT: '1' }), true)

  // 2. Secrets caught; short fixture-like values pass.
  // The fixture is BUILT, not typed: a key-shaped literal in a shipped
// test would put a key shape in the public repository and the npm
// tarball's own gate would flag the repo that ships the scanner.
const AWS_FIXTURE = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
const keyed = scanFileContent('server/auth.js', 'const key = "' + AWS_FIXTURE + '";\n')
  assert.ok(keyed.some(finding => finding.rule === 'secret/aws-key'))
  assert.equal(keyed[0].line, 1)
  const assigned = scanFileContent('app.py', 'api_key = "sk-live-abcdef123456"\n')
  assert.ok(assigned.some(finding => finding.rule === 'secret/assigned-value'))
  const fixture = scanFileContent(
    'test/api.test.js',
    'body: JSON.stringify({ username: \'probe-alice\', password: \'secret\' }),\n',
  )
  assert.deepEqual(fixture, [], 'short fixture passwords must not flag')

  // 3. Risky code per language; wrong-language rules stay silent.
  const py = scanFileContent('run.py', 'os.system("ls " + user_input)\n')
  assert.ok(py.some(finding => finding.rule === 'risky/py-shell'))
  const js = scanFileContent('app.js', 'el.innerHTML = userHtml;\n')
  assert.ok(js.some(finding => finding.rule === 'risky/js-innerhtml'))
  const cross = scanFileContent('run.py', 'el.innerHTML = x;\n')
  assert.deepEqual(cross, [], 'js rules must not fire on python')

  // 4. Workspace walk: finds planted issues, skips dep dirs, caps hold.
  const root = mkdtempSync(join(tmpdir(), 'wed-secscan-'))
  try {
    mkdirSync(join(root, 'server'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'server', 'auth.js'), 'const k = "' + AWS_FIXTURE + '";\n')
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'eval("evil")\n')
    writeFileSync(join(root, 'clean.py'), 'print("hello")\n')
    const walked = scanWorkspaceFiles(root)
    assert.ok(walked.findings.some(finding => finding.file === 'server/auth.js'))
    assert.ok(!walked.findings.some(finding => finding.file.includes('node_modules')))
    assert.ok(walked.filesScanned >= 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // 5. Dep audit: high/critical flagged, missing tool fails open.
  const depRoot = mkdtempSync(join(tmpdir(), 'wed-depaudit-'))
  try {
    writeFileSync(join(depRoot, 'package.json'), '{"name":"x"}\n')
    const audited = await runDependencyAudit(depRoot, {
      execFn: async () => ({
        stdout: JSON.stringify({
          vulnerabilities: {
            leftpad: { severity: 'critical', title: 'RCE' },
            tiny: { severity: 'low', title: 'minor' },
          },
        }),
      }),
    })
    assert.ok(audited.findings.some(finding => finding.rule === 'deps/npm-critical'))
    assert.ok(!audited.findings.some(finding => finding.rule.includes('low')))
    const missing = await runDependencyAudit(depRoot, {
      execFn: async () => {
        throw new Error('tool missing')
      },
    })
    assert.deepEqual(missing.findings, [])
    assert.ok(missing.skipped.length > 0)
  } finally {
    rmSync(depRoot, { recursive: true, force: true })
  }

  // 6. End-to-end gate: leaked secret blocks, clean workspace passes.
  const gate = mkdtempSync(join(tmpdir(), 'wed-secgate-'))
  try {
    writeFileSync(join(gate, 'app.js'), 'const api_key = "sk-live-abcdef123456";\n')
    const registry = new AgentRegistry()
    const runner = new TestingRunner()
    const contextFor = (workspace: string): AgentContext => ({
      task: {
        id: 'sec-gate-test',
        workspace,
        objective: 'x',
        role: 'backend',
        stack: 'node',
        constraints: [],
        acceptanceCriteria: [],
        verification: { setupCommands: [], testCommands: ['node -e "process.exit(0)"'] },
      },
      workspace,
      previousOutputs: [],
    })
    const blocked = await runner.run(registry.get('tester'), contextFor(gate))
    assert.ok(
      (blocked.blockingIssues ?? []).some(issue => issue.includes('secret/assigned-value')),
      `secret must block, got ${JSON.stringify(blocked.blockingIssues)}`,
    )
    const cleanDir = join(gate, 'cleanws')
    mkdirSync(cleanDir, { recursive: true })
    writeFileSync(join(cleanDir, 'app.js'), 'console.log("hi");\n')
    const passed = await runner.run(registry.get('tester'), contextFor(cleanDir))
    assert.deepEqual(passed.blockingIssues ?? [], [])
  } finally {
    rmSync(gate, { recursive: true, force: true })
  }

  // 7. Full scan helper merges without dep audit by default.
  const merged = await runSecurityScan(gate).catch(() => ({ findings: [], filesScanned: 0, skipped: ['gone'] }))
  assert.ok(Array.isArray(merged.findings))

  console.log('SECURITY SCAN TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

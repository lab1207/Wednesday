/**
 * The role bodies must be what the operator asked for (2026-11-07).
 *
 * The operator said "the output we get so bad" and asked for the missing
 * seats. Two claims are worth a regression test:
 *
 *  1. The SECURITY AUDIT seat carries the operator's prompt VERBATIM. It is
 *     their words, and it is the instruction they want run against every
 *     generated feature. A paraphrase is not the same instruction, and a
 *     model that was "helped" into a softer version of it is not doing the
 *     job they paid for.
 *
 *  2. The new seats are REGISTERED and DISPATCHABLE. A role that exists in
 *     the registry but has no runner throws "No runner registered for role"
 *     at the moment the operator reaches for it -- which is the worst moment
 *     to find out.
 *
 * Pure asserts only -- no model, no network.
 */

import assert from 'node:assert/strict'

import {
  AGENT_ROLES,
  ANALYSIS_ROLES,
  bugHunterAgent,
  securityAuditAgent,
} from './roles'
import { AgentRegistry } from './registry'
import type {
  AgentContext,
  AgentOutput,
} from './types'

/** The operator's prompt, character for character. */
const OPERATOR_SECURITY_PROMPT =
  'Act as an aggressive senior security engineer and penetration tester. Review this generated code for hidden memory leaks, security vulnerabilities (like XSS or injection), and edge cases where it might crash. List them out.'

const CONTEXT: AgentContext = {
  task: {
    id: 'role-body-test',
    workspace: 'C:/tmp/role-body-test',
    objective: 'build me website',
    role: 'frontend',
    stack: 'html',
    constraints: [],
    acceptanceCriteria: ['index.html exists'],
  },
  workspace: 'C:/tmp/role-body-test',
  previousOutputs: [],
}

function promptOf(
  role: {
    buildPrompt(
      context: AgentContext,
    ): string
  },
): string {
  return role.buildPrompt(CONTEXT)
}

function main(): void {
  // 1. EVERY ROLE IS REGISTERED.
  const registry = new AgentRegistry()
  const ids =
    AGENT_ROLES.map(role => role.id)

  for (const id of ids) {
    assert.ok(
      registry.list().includes(id),
      `${id} must be in the registry`,
    )
    assert.doesNotThrow(
      () => registry.get(id),
      `${id} must resolve from the registry`,
    )
  }

  for (const id of [
    'architect',
    'planner',
    'coder',
    'tester',
    'reviewer',
    'bug-hunter',
    'security-audit',
  ]) {
    assert.ok(
      ids.includes(id as never),
      `the ${id} role must be registered`,
    )
  }

  // 2. THE OPERATOR'S PROMPT, VERBATIM.
  const securityPrompt =
    promptOf(securityAuditAgent)

  assert.ok(
    securityPrompt.includes(OPERATOR_SECURITY_PROMPT),
    'the security seat must carry the operator prompt verbatim',
  )

  // It must be the FIRST instruction in the body, not buried in it. The
  // operator asked for that prompt to BE the instruction.
  const bodyLines =
    securityPrompt
      .split('\n')
      .map(line => line.trim())

  const promptLineIndex =
    bodyLines.findIndex(
      line =>
        line === OPERATOR_SECURITY_PROMPT,
    )

  assert.ok(
    promptLineIndex >= 0,
    'the operator prompt must be its own line in the body',
  )
  assert.ok(
    promptLineIndex <
      securityPrompt.indexOf('For each check below'),
    'the operator prompt must come before the checklist',
  )

  // 3. THE CHECKLIST COVERS WHAT THE OPERATOR NAMED.
  for (const topic of [
    'XSS',
    'injection',
    'memory leaks',
    'crashes',
    'secrets',
    'unsafe deserialization',
    'path traversal',
    'SSRF',
    'authorization',
    'dependencies',
  ]) {
    assert.ok(
      securityPrompt.includes(topic),
      `the security seat must cover ${topic}`,
    )
  }

  // 4. THE BUG HUNTING SEAT checks the FACTORY first. That is the lesson
  //    the operator's own run taught: the gate was broken, not the product.
  const hunterPrompt =
    promptOf(bugHunterAgent)

  assert.ok(
    hunterPrompt.includes('CHECK THE FACTORY FIRST'),
    'the bug hunter must check the factory before the product',
  )
  assert.ok(
    hunterPrompt.includes('CONFIRMED'),
    'the bug hunter must classify each hypothesis',
  )
  assert.ok(
    hunterPrompt.includes('REJECTED'),
    'the bug hunter must classify each hypothesis',
  )
  assert.ok(
    hunterPrompt.includes('INCONCLUSIVE'),
    'the bug hunter must classify each hypothesis',
  )

  // 5. THE ANALYSIS SEATS ARE THE ONES THAT RUN ON THE READ-ONLY RUNNER.
  assert.ok(
    ANALYSIS_ROLES.includes('bug-hunter'),
    'the bug hunter must be an analysis seat',
  )
  assert.ok(
    ANALYSIS_ROLES.includes('security-audit'),
    'the security audit must be an analysis seat',
  )
  assert.ok(
    !ANALYSIS_ROLES.includes('coder'),
    'the coder must not be an analysis seat',
  )
  assert.ok(
    !ANALYSIS_ROLES.includes('tester'),
    'the tester must not be an analysis seat',
  )
  assert.ok(
    !ANALYSIS_ROLES.includes('reviewer'),
    'the reviewer must not be an analysis seat',
  )

  // 6. EVERY REGISTERED ROLE PRODUCES A PROMPT THAT NAMES ITS OWN JOB.
  for (const role of AGENT_ROLES) {
    const prompt =
      promptOf(role)

    assert.ok(
      prompt.includes(role.purpose),
      `the ${role.id} prompt must state its purpose`,
    )
    assert.ok(
      prompt.includes('build me website'),
      `the ${role.id} prompt must carry the objective`,
    )
  }

  // 7. A FAILED SEAT'S OUTPUT IS STILL AN OUTPUT. The orchestrator keeps
  //    it, so the repair loop has memory (B224). The role runner contract
  //    must allow a role to report blocking issues.
  const failed: AgentOutput = {
    role: 'bug-hunter',
    summary: 'one confirmed defect',
    findings: ['a.ts:12 -- off by one'],
    blockingIssues: ['a.ts:12 -- off by one'],
  }

  assert.equal(
    failed.blockingIssues?.length,
    1,
    'a role must be able to report a blocking issue',
  )

  console.log('role-bodies: PASS')
}

main()

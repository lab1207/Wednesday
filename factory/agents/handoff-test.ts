/**
 * The role hand-off must survive whatever a small model actually sends
 * (2026-11-08, B229).
 *
 * Every seat's answer enters the pipeline as untrusted JSON, and the
 * TypeScript type says the fields are already strings and arrays. They are
 * not: a model answers `findings` with a bare string as often as with an
 * array, and the consumers do the only thing that type allows --
 * `.slice(0, 6).map(...)`, which throws, and
 * `for (const file of filesChanged)`, which iterates CHARACTERS.
 *
 * These assertions are the contract: whatever shape arrives, the same
 * hand-off comes out, and the repairs are REPORTED rather than silently
 * absorbed.
 *
 * Offline by construction: no model, no network, no clock, no files.
 */

import assert from 'node:assert/strict'

import { DefaultRoleRunnerDispatcher } from '../orchestrator/orchestrator'

import {
  describeHandoffRepairs,
  handoffBlockingIssues,
  handoffFilesChanged,
  normalizeHandoff,
} from './handoff'

async function main(): Promise<void> {
  // 1. A well-formed answer is returned UNCHANGED, with no repairs.
  const clean = {
    role: 'planner',
    summary: 'Plan the auth endpoint.',
    findings: ['auth.js has no rate limit'],
    recommendations: ['Add a limiter.', 'Add a test.'],
    blockingIssues: [],
    filesChanged: [],
  }
  const cleanRead = normalizeHandoff(clean)
  assert.deepEqual(cleanRead.handoff.findings, ['auth.js has no rate limit'])
  assert.deepEqual(cleanRead.handoff.recommendations, [
    'Add a limiter.',
    'Add a test.',
  ])
  assert.deepEqual(cleanRead.repairs, [], 'a clean answer must not be repaired')
  assert.equal(cleanRead.unusable, false, 'a clean answer is usable')
  assert.equal(describeHandoffRepairs(cleanRead.repairs), '')

  // 2. THE CRASH: a bare string where an array is declared. `.map` used to
  //    throw; the string is still the finding.
  const asString = {
    role: 'tester',
    summary: 'One test failed.',
    findings: 'node --test 7/7 fail',
    recommendations: 'Fix the failing test.',
    blockingIssues: ['exit code 1'],
  }
  const stringRead = normalizeHandoff(asString)
  assert.deepEqual(
    stringRead.handoff.findings,
    ['node --test 7/7 fail'],
    'a bare string is one finding, not a crash',
  )
  assert.deepEqual(
    stringRead.handoff.blockingIssues,
    ['exit code 1'],
  )
  assert.deepEqual(
    stringRead.repairs,
    ['findings', 'recommendations'],
    'every repaired field must be named',
  )
  assert.equal(
    describeHandoffRepairs(stringRead.repairs),
    'hand-off repaired: findings, recommendations',
  )

  // 3. THE QUIET ONE: filesChanged as a string. The receipt used to file
  //    one character at a time.
  const files = {
    role: 'coder',
    summary: 'Wrote the page.',
    filesChanged: 'index.html',
  }
  assert.deepEqual(
    handoffFilesChanged(files),
    ['index.html'],
    'a bare string is one file, not one file per letter',
  )
  assert.deepEqual(handoffFilesChanged({ filesChanged: undefined }), [])
  assert.deepEqual(handoffFilesChanged(null), [])
  assert.deepEqual(handoffFilesChanged({}), [])

  // 4. Objects in the lists keep their meaning (the B149 shape).
  const objects = {
    role: 'reviewer',
    summary: 'Two changes required.',
    findings: [
      { file: 'index.html', change: 'The meta viewport tag is missing.' },
      { path: 'app.js', issue: 'Unused import.' },
    ],
    blockingIssues: [{ file: 'app.js', change: 'Syntax error at 12:4.' }],
  }
  const objectRead = normalizeHandoff(objects)
  assert.deepEqual(objectRead.handoff.findings, [
    'index.html: The meta viewport tag is missing.',
    'app.js: Unused import.',
  ])
  assert.deepEqual(objectRead.handoff.blockingIssues, [
    'app.js: Syntax error at 12:4.',
  ])

  // 5. Mixed arrays, nulls, numbers and booleans all become strings.
  const mixed = {
    role: 'planner',
    summary: 'Plan.',
    findings: [null, 'one', 2, true, { file: 'a.js', change: 'x' }],
    recommendations: [],
    blockingIssues: [],
  }
  assert.deepEqual(normalizeHandoff(mixed).handoff.findings, [
    'one',
    '2',
    'true',
    'a.js: x',
  ])

  // 6. A missing role is simply absent -- not a repair. A role of the
  //    WRONG TYPE is a repair, because a consumer that switches on it
  //    would silently match nothing.
  const noRole = {
    summary: 'No seat named.',
    findings: ['something'],
  }
  const roleRead = normalizeHandoff(noRole)
  assert.equal(roleRead.handoff.role, '', 'an unnamed seat is still readable')
  assert.ok(
    !roleRead.repairs.includes('role'),
    'an absent role is not a repair -- nothing was mistyped',
  )
  assert.equal(roleRead.unusable, false)

  const typedRole = {
    role: 42,
    summary: 'The seat answered.',
    findings: ['something'],
  }
  const typedRoleRead = normalizeHandoff(typedRole)
  assert.equal(typedRoleRead.handoff.role, '')
  assert.ok(
    typedRoleRead.repairs.includes('role'),
    'a wrong-typed role must be reported as a repair',
  )

  // 7. Nothing at all is UNUSABLE, and the reason says why.
  for (const dead of [null, undefined, '', {}, { role: 'coder' }]) {
    const read = normalizeHandoff(dead)
    assert.equal(read.unusable, true, 'no answer at all must be unusable')
    assert.ok(
      typeof read.reason === 'string' && read.reason.length > 0,
      'an unusable answer must carry a reason',
    )
    assert.deepEqual(read.handoff.findings, [])
  }

  // 8. A non-object, non-string answer is not a crash either.
  const asNumber = normalizeHandoff(42)
  assert.equal(asNumber.handoff.summary, '42')
  assert.equal(asNumber.unusable, false)
  assert.ok(asNumber.repairs.includes('shape'), 'a wrong shape is a repair')

  const asArray = normalizeHandoff(['one', 'two'])
  assert.deepEqual(asArray.handoff.findings, ['one', 'two'])
  assert.equal(asArray.unusable, false)

  // 9. Everything else the seat said is preserved verbatim.
  const withReview = {
    role: 'reviewer',
    summary: 'Pass.',
    review: { verdict: 'pass', findings: [], requiredChanges: [], evidence: [] },
    filesChanged: [],
  }
  const reviewRead = normalizeHandoff(withReview)
  assert.deepEqual(
    reviewRead.handoff.rest.review,
    withReview.review,
    'the rest of the answer must survive',
  )
  assert.deepEqual(
    reviewRead.repairs,
    [],
    'a well-shaped answer with a review must not be repaired',
  )

  // 10. The convenience calls never throw. A bare string is the seat's
  //     ANSWER, so it becomes the summary and NOT a blocker -- a seat that
  //     said something and named nothing as blocking reported no blockers.
  assert.deepEqual(handoffBlockingIssues({ blockingIssues: 'exit code 1' }), [
    'exit code 1',
  ])
  assert.deepEqual(handoffBlockingIssues(null), [])
  assert.deepEqual(handoffBlockingIssues('just text'), [])
  assert.equal(normalizeHandoff('just text').handoff.summary, 'just text')

  // 11. THE SEAM. The dispatcher applies the normaliser, so every consumer
  //     after it is guaranteed -- the stage bookkeeping, the repair
  //     feedback, the duel merges, the specialist gate and the receipt.
  {
    const seen: Record<string, unknown>[] = []
    const seating = {
      // A prototype method, the way the reviewer carries its specialist
      // gate: the seam must NOT disable it.
      async runSpecialistGate(): Promise<string> {
        return 'reachable'
      },
      async run(role: { id: string }) {
        const answer = {
          role: role.id,
          summary: 'One test failed.',
          findings: 'node --test 7/7 fail',
          blockingIssues: ['exit code 1'],
        }
        seen.push(answer)
        return answer as never
      },
    }

    const dispatcher = new DefaultRoleRunnerDispatcher(
      new Map([['coder', seating]]),
    )

    const seated = dispatcher.get('coder')

    // 11a. A prototype method is still reachable through the seam.
    assert.equal(
      await (
        seated as unknown as {
          runSpecialistGate(): Promise<string>
        }
      ).runSpecialistGate(),
      'reachable',
      'the seam must not disable what the runner offers on its prototype',
    )

    // 11b. The wrong shape comes out readable, and the raw one is kept.
    const context = {
      task: { id: 'x', workspace: '.', objective: 'y', constraints: [], acceptanceCriteria: [] },
      workspace: '.',
      previousOutputs: [],
    }
    const role = { id: 'coder', purpose: 'p', buildPrompt: () => '' }
    const out = await seated.run(role as never, context as never)
    assert.deepEqual(
      out.findings,
      ['node --test 7/7 fail'],
      'the dispatcher must hand every consumer a readable findings list',
    )
    assert.deepEqual(out.blockingIssues, ['exit code 1'])
    assert.equal(out.summary, 'One test failed.')
    assert.deepEqual(
      seen[0].findings,
      'node --test 7/7 fail',
      'the runner still answered in its own raw shape -- the seam repaired a COPY',
    )
  }

  // 12. A WELL-SHAPED answer is returned BY REFERENCE through the seam.
  //     No well-shaped run can be changed by the normaliser.
  {
    const cleanAnswer = {
      role: 'planner',
      summary: 'Plan it.',
      findings: [],
      recommendations: ['one'],
      blockingIssues: [],
    }
    const cleanRunner = {
      async run() {
        return cleanAnswer as never
      },
    }
    const dispatcher = new DefaultRoleRunnerDispatcher(
      new Map([['planner', cleanRunner]]),
    )
    const context = {
      task: { id: 'x', workspace: '.', objective: 'y', constraints: [], acceptanceCriteria: [] },
      workspace: '.',
      previousOutputs: [],
    }
    const role = { id: 'planner', purpose: 'p', buildPrompt: () => '' }
    const out = await dispatcher
      .get('planner')
      .run(role as never, context as never)
    assert.equal(
      out,
      cleanAnswer,
      'a well-shaped answer must come back by reference, untouched',
    )
  }

  console.log('handoff: PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

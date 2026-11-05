/**
 * Executable relay scenario catalog test (2026-10-16). Runs all 100
 * scenarios through the pure core: covered ones assert exact behavior,
 * gap ones are reported (never faked green). Locks the 40/60 split.
 * No runners, no network, no filesystem.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RELAY_SCENARIOS } from './relay-scenarios'
import type { FitCapability } from '../model-router/model-capabilities'
import {
  assignPieces,
  collectAnswers,
  electLeader,
  expandNode,
  findNode,
  makeRelayRoot,
  openLeaves,
  pieceToNode,
  rankRace,
  relayPiecePrompt,
  relayTreeComplete,
  reopenNode,
  resolveNode,
  resolveRelayDepth,
  resolveRelayEnabled,
  resolveRelayMaxRounds,
  resolveRelayRetries,
  resolveRelayWidth,
  splitRemainder,
  stuckLeaves,
} from './relay'

/** Canonical piece title per skill (matches guessCapability keywords). */
const TITLE_FOR: Record<FitCapability, string> = {
  reasoning: 'pick a different strategy for the plan',
  coding: 'fix the off-by-one bug',
  vision: 'the screenshot clip overflows on mobile',
  review: 'verify the audit verdict on the change',
  complete: 'finish the missing handler',
}

async function main(): Promise<void> {
  // 0. Catalog integrity: exactly 100, 40 good / 60 bad, unique ids,
  // and every gap belongs to a bad scenario with a build note.
  assert.equal(RELAY_SCENARIOS.length, 100)
  const good = RELAY_SCENARIOS.filter(s => s.kind === 'good')
  const bad = RELAY_SCENARIOS.filter(s => s.kind === 'bad')
  assert.equal(good.length, 40)
  assert.equal(bad.length, 60)
  const ids = new Set(RELAY_SCENARIOS.map(s => s.id))
  assert.equal(ids.size, 100)
  const gaps: string[] = []

  for (const scenario of RELAY_SCENARIOS) {
    const tag = `${scenario.id} ${scenario.title}`
    const check = scenario.check
    switch (check.kind) {
      case 'leader': {
        const leader = electLeader(rankRace(check.lanes))
        assert.equal(leader?.model ?? null, check.expect, tag)
        break
      }
      case 'split': {
        const drafts = splitRemainder(check.failures, check.maxPieces)
        assert.deepEqual(
          drafts.map(d => d.capability),
          check.expectCaps,
          tag,
        )
        if (check.expectMaxTitleLen !== undefined) {
          for (const draft of drafts) {
            assert.ok(
              draft.title.length <= check.expectMaxTitleLen,
              `${tag} title too long`,
            )
          }
        }
        break
      }
      case 'assign': {
        const drafts = check.caps.map((cap, index) => ({
          id: `piece-${index}`,
          title: TITLE_FOR[cap],
          capability: cap,
        }))
        const pieces = assignPieces(
          drafts,
          check.pool.map(id => ({ id })),
          check.scores,
        )
        assert.deepEqual(
          pieces.map(p => p.assignee),
          check.expect,
          tag,
        )
        break
      }
      case 'prompt': {
        const text = relayPiecePrompt(
          { id: 'piece-0', title: 'x', capability: 'coding' },
          'lead',
          'note',
          check.attempt,
        )
        assert.equal(text.includes('STRATEGY CHANGE'), check.expectStrategy, tag)
        if (check.expectText !== undefined) {
          assert.ok(text.includes(check.expectText), tag)
        }
        break
      }
      case 'env': {
        const resolvers = {
          width: resolveRelayWidth,
          rounds: resolveRelayMaxRounds,
          depth: resolveRelayDepth,
          retries: resolveRelayRetries,
          enabled: resolveRelayEnabled,
        }
        assert.equal(resolvers[check.knob](check.env), check.expect, tag)
        break
      }
      case 'tree': {
        const poolObjs = check.pool.map(id => ({ id }))
        const root = makeRelayRoot('scenario')
        root.children = assignPieces(
          splitRemainder(check.failures, check.width ?? 4),
          poolObjs,
          check.scores,
        ).map(piece => pieceToNode(piece, 1))
        for (const op of check.ops) {
          if (op.t === 'resolve') {
            assert.equal(
              resolveNode(root, op.id, op.ok, op.answer),
              op.expectOk ?? true,
              `${tag} resolve ${op.id}`,
            )
          } else if (op.t === 'expand') {
            const node = findNode(root, op.id)
            assert.ok(node, `${tag} expand ${op.id} found`)
            expandNode(node, op.failures, poolObjs, check.scores, check.width ?? 4)
          } else {
            assert.equal(reopenNode(root, op.id), op.expect, `${tag} reopen`)
          }
        }
        assert.equal(relayTreeComplete(root), check.expect.complete, `${tag} complete`)
        if (check.expect.open !== undefined) {
          assert.deepEqual(
            openLeaves(root).map(leaf => leaf.id),
            check.expect.open,
            `${tag} open`,
          )
        }
        if (check.expect.stuck !== undefined) {
          assert.deepEqual(
            stuckLeaves(root, check.expect.stuck.maxDepth).map(leaf => leaf.id),
            check.expect.stuck.ids,
            `${tag} stuck`,
          )
        }
        if (check.expect.answers !== undefined) {
          assert.deepEqual(collectAnswers(root), check.expect.answers, `${tag} answers`)
        }
        if (check.expect.assignees !== undefined) {
          for (const [id, assignee] of Object.entries(check.expect.assignees)) {
            assert.equal(findNode(root, id)?.assignee, assignee, `${tag} assignee ${id}`)
          }
        }
        break
      }
      case 'gap': {
        assert.equal(scenario.kind, 'bad', `${tag} gaps are bad scenarios`)
        assert.ok(check.missing.length > 20, `${tag} missing describes the hole`)
        assert.ok(check.build.length > 20, `${tag} build names the fix`)
        gaps.push(`GAP ${scenario.id} [${scenario.loop}] ${scenario.title} — ${check.missing} BUILD: ${check.build}`)
        break
      }
      case 'e2e': {
        assert.ok(check.note.length > 20, `${tag} note says what is proven`)
        assert.ok(check.proofs.length > 0, `${tag} needs at least one proof`)
        for (const proof of check.proofs) {
          const body = readFileSync(join(process.cwd(), proof.file), 'utf8')
          for (const marker of proof.markers) {
            assert.ok(
              body.includes(marker),
              `${tag} proof marker missing: ${marker} in ${proof.file}`,
            )
          }
        }
        break
      }
    }
  }

  assert.equal(gaps.length, 26, 'gap count is the build backlog')
  for (const line of gaps) console.log(line)
  console.log(
    `RELAY SCENARIOS TEST: PASS (100 scenarios: 40 good, 60 bad, ${100 - gaps.length} covered green, ${gaps.length} gaps open)`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

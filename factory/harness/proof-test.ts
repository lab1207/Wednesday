/**
 * Offline tests for the first-run proof (2026-11-05).
 *
 * The proof is the first place the route is exercised, so its failure modes
 * must be named without a model: a hosted route must not be dragged onto the
 * leftover local base URL (B195), a missing artifact is a real FAIL, a stale
 * artifact cannot produce a false PASS, and a timeout is a receipt rather than
 * a hung onboarding.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import {
  PROOF_ACTIVITY_MARK,
  PROOF_FILE,
  PROOF_TOKEN,
  proofLines,
  proofRoute,
  proofVerdict,
  proofWorkspace,
  renderProof,
  runProof,
  type ProofChild,
  type ProofSpawn,
} from './proof'
import type { ViewLine } from './views'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean {
    this.emit('close', null, 'SIGKILL')
    return true
  }
}

/**
 * The UNCOOPERATIVE child: the real hang shape.
 *
 * The host is killed, but a grandchild still holds the inherited pipe, so
 * `close` never fires. The old FakeChild emitted `close` from `kill()` --
 * exactly like a well-behaved process tree -- which is why the suite stayed
 * green while the operator's app froze (2026-11-07).
 */
class PipeHoldingChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean {
    // Killed, but the pipe is still held by someone else.
    return true
  }
}

function fakeSpawn(behavior: (options: { cwd: string }, child: FakeChild) => void): ProofSpawn {
  return (_command, _args, options) => {
    const child = new FakeChild()
    queueMicrotask(() => behavior(options, child))
    return child as unknown as ProofChild
  }
}

/** A spawn whose child behaves like a real, uncooperative process tree. */
function pipeHoldingSpawn(
  behavior: (options: { cwd: string }, child: PipeHoldingChild) => void,
): ProofSpawn {
  return (_command, _args, options) => {
    const child = new PipeHoldingChild()
    queueMicrotask(() => behavior(options, child))
    return child as unknown as ProofChild
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wed-proof-'))
}

async function main(): Promise<void> {
  // 1. The route is the route a real run uses. A hosted pick must win over a
  // leftover local base URL; that is the exact B195 shape.
  assert.deepEqual(
    proofRoute({
      FACTORY_LLM_PROVIDER: 'openrouter',
      DSH_LLM_PROVIDER: 'openrouter',
      DSH_LLM_MODEL: 'nvidia/nemotron-3.5-lightning:free',
      OPENROUTER_API_KEY: 'test',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
    }),
    { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' },
    'a hosted route is not dragged onto the local proxy by a leftover base URL',
  )
  assert.equal(
    proofRoute({
      FACTORY_LLM_PROVIDER: 'local',
      DSH_LLM_MODEL: 'qwen2.5-coder-3b-instruct',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
    }).provider,
    'local',
  )
  assert.match(
    proofRoute({ FACTORY_LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test' }).problem ?? '',
    /no model selected/,
    'a route with no model is named before spawning',
  )
  assert.match(
    proofRoute({ FACTORY_LLM_PROVIDER: 'openrouter', DSH_LLM_MODEL: 'x' }).problem ?? '',
    /OPENROUTER_API_KEY/,
    'a missing hosted key is named before spawning',
  )
  assert.match(
    proofRoute({ FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'qwen' }).problem ?? '',
    /no base URL/,
    'a local route with no server is named before spawning',
  )
  assert.equal(
    proofRoute({
      FACTORY_LLM_PROVIDER: 'local',
      DSH_LLM_PROVIDER: 'openrouter',
      DSH_LLM_MODEL: 'qwen',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
    }).provider,
    'local',
    'the persisted route beats a stale per-run override',
  )

  // 2. The artifact is the verdict: missing, wrong and exact are distinct.
  const verdictDir = tempDir()
  try {
    const missing = proofVerdict(verdictDir)
    assert.equal(missing.ok, false)
    assert.match(missing.detail, /was not written/, 'a model that answered without tools is a FAIL')
    writeFileSync(join(verdictDir, PROOF_FILE), 'something else\n')
    const wrong = proofVerdict(verdictDir)
    assert.equal(wrong.ok, false)
    assert.match(wrong.detail, /expected WEDNESDAY_PROOF_OK/, 'a wrong artifact names what was expected')
    writeFileSync(join(verdictDir, PROOF_FILE), `${PROOF_TOKEN}\n`)
    assert.equal(proofVerdict(verdictDir).ok, true, 'a trailing newline is not a failure')
  } finally {
    rmSync(verdictDir, { recursive: true, force: true })
  }

  // 3. A rerun clears the previous artifact; a stale PASS is impossible.
  const staleDir = tempDir()
  try {
    mkdirSync(join(staleDir, 'proof'), { recursive: true })
    writeFileSync(join(staleDir, 'proof', PROOF_FILE), PROOF_TOKEN)
    const workspace = proofWorkspace(staleDir)
    assert.ok(!existsSync(join(workspace, PROOF_FILE)), 'a rerun starts from an empty workspace')
  } finally {
    rmSync(staleDir, { recursive: true, force: true })
  }

  // 4. PASS: the worker writes the file and the receipt names the route.
  const passDir = tempDir()
  try {
    const progress: string[] = []
    let spawned: { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } } | undefined
    const spawnImpl: ProofSpawn = (command, args, options) => {
      spawned = { command, args, options }
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stdout.write(`${PROOF_ACTIVITY_MARK}{"kind":"tool","tool":"write","detail":"proof.txt"}\n`)
        writeFileSync(join(options.cwd, PROOF_FILE), `${PROOF_TOKEN}\n`)
        child.stdout.end(`${PROOF_TOKEN}\n`)
        setImmediate(() => child.emit('close', 0, null))
      })
      return child as unknown as ProofChild
    }
    const receipt = await runProof({
      note: () => {},
      error: () => {},
      progress: text => { progress.push(text) },
    }, {
      env: {
        FACTORY_LLM_PROVIDER: 'openrouter',
        DSH_LLM_MODEL: 'nvidia/nemotron-3.5-lightning:free',
        OPENROUTER_API_KEY: 'test',
        LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1',
      },
      stateDir: passDir,
      timeoutMs: 1000,
      spawnImpl,
    })
    assert.equal(receipt.ok, true, receipt.detail)
    assert.equal(receipt.provider, 'openrouter')
    assert.equal(receipt.model, 'nvidia/nemotron-3.5-lightning:free')
    assert.equal(receipt.answer, PROOF_TOKEN)
    assert.ok(progress.some(line => /proof: write/.test(line)), 'live tool activity reaches the UI')
    // The spawn is the real worker path: the route, workspace and prompt must
    // be explicit, because a leftover LOCAL_LLM_BASE_URL is what caused B195.
    assert.equal(spawned?.options.env.DSH_LLM_PROVIDER, 'openrouter', 'the proof pins the route on the worker')
    assert.equal(spawned?.options.env.DSH_LLM_MODEL, 'nvidia/nemotron-3.5-lightning:free')
    assert.equal(spawned?.options.env.DSH_FACTORY_TASK_WORKSPACE, spawned?.options.cwd, 'the worker writes in the proof workspace')
    assert.match(spawned?.options.env.DSH_FACTORY_TASK_PROMPT ?? '', /WEDNESDAY_PROOF_OK/, 'the tiny task names the artifact')
  } finally {
    rmSync(passDir, { recursive: true, force: true })
  }

  // 5. FAIL: the model answered but wrote nothing; the receipt says so.
  const failDir = tempDir()
  try {
    const receipt = await runProof({ note: () => {}, error: () => {} }, {
      env: { FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'qwen', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1' },
      stateDir: failDir,
      timeoutMs: 1000,
      spawnImpl: fakeSpawn((_options, child) => {
        child.stdout.end('I cannot write files.\n')
        setImmediate(() => child.emit('close', 0, null))
      }),
    })
    assert.equal(receipt.ok, false)
    assert.match(receipt.detail, /was not written/, 'a text-only answer is not a proof')
  } finally {
    rmSync(failDir, { recursive: true, force: true })
  }

  // 6. Timeout: a dead route returns a receipt, it does not hang onboarding.
  const timeoutDir = tempDir()
  try {
    const receipt = await runProof({ note: () => {}, error: () => {} }, {
      env: { FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'qwen', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1' },
      stateDir: timeoutDir,
      timeoutMs: 25,
      spawnImpl: fakeSpawn(() => {
        // Never close: the cap must kill it and settle the receipt.
      }),
    })
    assert.equal(receipt.ok, false)
    assert.match(receipt.detail, /no answer within/, 'a dead route is named, not hung')
  } finally {
    rmSync(timeoutDir, { recursive: true, force: true })
  }

  // 7. THE REAL SHAPE OF THE HANG (2026-11-07, operator report: "/proof
  //    hangs all wednesday -- the project stops"). The host is killed but a
  //    grandchild still holds the inherited pipe, so `close` never fires.
  //    The receipt must STILL arrive, or the whole app waits forever.
  const grandchildDir = tempDir()
  try {
    const receipt = await runProof({ note: () => {}, error: () => {} }, {
      env: { FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'qwen', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1' },
      stateDir: grandchildDir,
      timeoutMs: 25,
      spawnImpl: pipeHoldingSpawn((_options, child) => {
        // The process is gone; the pipes are not.
        setImmediate(() => child.emit('exit', null, 'SIGKILL'))
      }),
    })
    assert.equal(receipt.ok, false)
    assert.match(receipt.detail, /no answer within/, 'an exit without close still settles the receipt')
  } finally {
    rmSync(grandchildDir, { recursive: true, force: true })
  }

  // 8. WORSE: the kill is refused and NO event ever arrives. The deadline
  //    itself must settle the turn -- a receipt that waits for an event
  //    that never comes is the freeze the operator reported.
  const silentDir = tempDir()
  try {
    const receipt = await runProof({ note: () => {}, error: () => {} }, {
      env: { FACTORY_LLM_PROVIDER: 'local', DSH_LLM_MODEL: 'qwen', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:18090/v1' },
      stateDir: silentDir,
      timeoutMs: 25,
      spawnImpl: pipeHoldingSpawn(() => {
        // Nothing. Ever.
      }),
    })
    assert.equal(receipt.ok, false)
    assert.match(receipt.detail, /no answer within/, 'a dead tree still returns a receipt')
  } finally {
    rmSync(silentDir, { recursive: true, force: true })
  }

  // 9. Both surfaces get the same rows; the failure carries one next action.
  const passRows = proofLines({
    ok: true, detail: 'wrote proof.txt and read it back', seconds: 1.25,
    provider: 'openrouter', model: 'nvidia/x', workspace: 'C:\\state\\proof', answer: PROOF_TOKEN,
  })
  assert.match(passRows[0]!.text, /proof PASS/, 'a pass leads with the result')
  assert.ok(passRows.some(row => /artifact:/.test(row.text)), 'and names the artifact')
  const failRows = proofLines({
    ok: false, detail: 'proof.txt was not written', seconds: 0.2,
    provider: 'local', model: 'qwen', workspace: 'C:\\state\\proof',
  })
  assert.match(failRows[0]!.text, /proof FAIL/, 'a fail leads with the result')
  assert.ok(failRows.some(row => /fix: \/connect or \/doctor/.test(row.text)), 'and gives one next action')
  const blocks: ViewLine[][] = []
  renderProof({ note: () => {}, error: () => {}, block: lines => { blocks.push(lines) } }, {
    ok: true, detail: 'wrote proof.txt and read it back', seconds: 1,
    provider: 'local', model: 'qwen', workspace: 'C:\\state\\proof',
  })
  assert.equal(blocks.length, 1, 'the screen path gets one toned block')

  console.log('PROOF TEST: PASS (route precedence, artifact verdict, stale reset, pass/fail/timeout receipts, uncooperative process tree, one next action)')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

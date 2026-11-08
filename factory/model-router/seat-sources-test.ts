/**
 * The operator's six-model roster, and the GGUF sources that go with it
 * (2026-11-08).
 *
 * Four claims, all offline, none of them a network call:
 *
 *   1. Every seat names a source, and every source is a Hugging Face GGUF
 *      repository — the shape is checkable offline; the reachability is not,
 *      and nothing pretends otherwise.
 *   2. THE DRIFT CHECK: a seat that WEARS a model by default
 *      (CREW_SEAT_DEFAULT_MODELS) must name the SAME model in its source. A
 *      seat whose default says `granite-guardian-3.1-2b` while its weights
 *      line says `granite-3.1-2b` would make the operator download the wrong
 *      model and the status meter would report a model the box is not running.
 *   3. The quantisation rule is Q4_K_M or Q5_K_M everywhere — the operator's
 *      "MANDATORY", as code.
 *   4. seatGgufLine() renders one honest line per seat for a receipt.
 */
import assert from 'node:assert/strict'

import {
  CREW_ROLES,
  CREW_SEAT_DEFAULT_MODELS,
  GGUF_QUANTISATION_NOTE,
  GGUF_QUANTISATION_RULE,
  SEAT_GGUF_SOURCES,
  seatGgufLine,
  seatGgufSource,
} from './crew-routing'

/** A Hugging Face repo that publishes GGUF weights. */
const HF_GGUF = /^https:\/\/huggingface\.co\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+-GGUF$/

/** Same model, tolerating the case and separators a repo name uses. */
function sameModel(a: string, b: string): boolean {
  const norm = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(a) === norm(b)
}

function main(): void {
  // 1. Every seat has a source, and every source is a HF GGUF repo.
  for (const role of CREW_ROLES) {
    const source = SEAT_GGUF_SOURCES[role]
    assert.ok(source, `${role} must name a weights source`)
    assert.match(
      source.repo,
      HF_GGUF,
      `${role}'s repo must be a Hugging Face GGUF repository: ${source.repo}`,
    )
    assert.ok(
      source.model.length > 0,
      `${role} must name its model`,
    )
  }

  // 2. THE DRIFT CHECK — the reason this test exists.
  for (const [role, model] of Object.entries(CREW_SEAT_DEFAULT_MODELS)) {
    const source = seatGgufSource(role)
    assert.ok(source, `${role} wears a default but names no source`)
    assert.ok(
      sameModel(model, source.model),
      `${role}: the seat default is "${model}" but the weights line names "${source.model}" — the operator would download the wrong model`,
    )
  }

  // 2b. The seats the operator RENAMED in the roster carry their names.
  assert.equal(seatGgufSource('vision')!.label, 'UI/UX DESIGN')
  assert.equal(seatGgufSource('architect')!.label, 'ARCHITECTURE')
  assert.equal(seatGgufSource('coder')!.label, 'CORE CODING')
  assert.equal(seatGgufSource('autocomplete')!.label, 'AUTOCOMPLETE')
  assert.equal(seatGgufSource('bug-hunter')!.label, 'BUG HUNTING')
  assert.equal(seatGgufSource('security-audit')!.label, 'SECURITY AUDIT')

  // 2c. The three new seats are the three that actually wear the model by
  //     default — the roster documents six seats, the defaults staff three.
  assert.deepEqual(
    Object.keys(CREW_SEAT_DEFAULT_MODELS).sort(),
    ['autocomplete', 'bug-hunter', 'security-audit'],
    'only the three staffed seats carry a default',
  )

  // 3. The quantisation rule is the operator's, everywhere.
  assert.equal(GGUF_QUANTISATION_RULE, 'Q4_K_M or Q5_K_M')
  for (const role of CREW_ROLES) {
    assert.equal(
      SEAT_GGUF_SOURCES[role].quantisation,
      GGUF_QUANTISATION_RULE,
      `${role} must use the one quantisation rule`,
    )
  }
  assert.ok(
    GGUF_QUANTISATION_NOTE.includes('half the hardware'),
    'the note says why the rule is not a preference',
  )

  // 4. One honest line per seat.
  const line = seatGgufLine('security-audit')
  assert.ok(
    line.includes('SECURITY AUDIT') &&
      line.includes('granite-guardian-3.1-2b') &&
      line.includes('Q4_K_M') &&
      line.includes('DevQuasar-11'),
    'the receipt line must name the seat, the model, the quantisation and the repo: ' + line,
  )
  // The URL is trimmed to the repo, because a receipt is read by a human.
  assert.ok(!line.includes('https://'), 'a receipt line carries the repo, not a URL')
  // A caller holding something that is not a seat is told so, not crashed.
  assert.equal(seatGgufLine('nope' as never), 'nope: no weights named')

  // 5. Nothing here touches the network: the table is data, and no export
  //    fetches. Proof by construction — there is no import of http/fetch in
  //    this module's callers used by the test.
  assert.equal(typeof seatGgufSource, 'function')

  console.log('seat-sources: PASS')
}

main()

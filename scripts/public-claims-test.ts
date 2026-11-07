/**
 * Offline test for the PUBLIC claims: README.md and site/index.html must
 * say only what the code can back. No network.
 *
 * Three claims, three traps:
 *
 *   1. vLLM. The operator-facing scan (`/connect` ->
 *      `factory/harness/local-discovery.ts`) probes Ollama :11434, LM Studio
 *      :1234, llama.cpp :8080, a generic :1337 and the wednesday proxy
 *      :18090. It does NOT probe vLLM :8000. The model layer's shared
 *      candidate list (`factory/model-router/local-servers.ts`) DOES know
 *      :8000 - so the copy may name the port, and may not claim that the
 *      product finds the server for you.
 *   2. Seats. The live mechanism is probe -> score -> best fit per
 *      capability (`model-capabilities.ts`, `providers/local.ts`). The
 *      tryout gate (`model-qualify.ts` -> `qualifyForTeam`) and the
 *      dream-team table (`assignTeam`) are called from their own unit tests
 *      only - no live operator flow admits or mutes a model, so the copy may
 *      not claim a qualification gate.
 *   3. Context window. The registry gives the MODEL's ceiling (32,768 for
 *      Qwen2.5-Coder-3B); 13,312 is the DEPLOYMENT's window on the Colab T4
 *      box that serves the 3B. The smaller of the two wins
 *      (`prompt-budget.ts` -> `resolvePromptBudget`), so the copy must never
 *      present one as the other.
 *
 * Run: npx tsx scripts/public-claims-test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this file until the repo root (package.json) shows up. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('repo root not found (no package.json above scripts/)')
}

const ROOT = repoRoot()
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

const FILES = ['README.md', 'site/index.html'] as const

/**
 * A block of published text: one paragraph, one markdown table row, one list
 * item, or one HTML line. Table rows are their own block on purpose - the
 * backend table is a LIST of claims, and folding it into one sentence would
 * hide a claim behind its neighbour.
 */
function blocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) {
      out.push(current.join(' '))
      current = []
    }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('|')) {
      flush()
      out.push(line)
      continue
    }
    if (/^([-*+]|\d+[.)])\s/.test(line)) {
      flush()
      current.push(line)
      continue
    }
    current.push(line)
  }
  flush()
  return out
}

/** Sentences of one block. A dot inside a number (Qwen2.5) is not a stop. */
function sentences(block: string): string[] {
  const flat = block.replace(/\s+/g, ' ').trim()
  if (flat === '') return []
  return flat
    .split(/(?<![0-9])[.!?](?=\s|$)/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

interface Corpus {
  name: string
  text: string
  sentences: string[]
}

const corpora: Corpus[] = FILES.map(name => {
  const text = read(name)
  return { name, text, sentences: blocks(text).flatMap(sentences) }
})

/** Every match of `pattern` in `text`, with its position. */
function occurrences(text: string, pattern: RegExp): Array<{ start: number; end: number }> {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const found: Array<{ start: number; end: number }> = []
  let match: RegExpExecArray | null = re.exec(text)
  while (match !== null) {
    found.push({ start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) re.lastIndex += 1
    match = re.exec(text)
  }
  return found
}

/** The ports the operator-facing `/connect` scan really probes. */
function harnessScanPorts(): Set<string> {
  const source = read('factory/harness/local-discovery.ts')
  const ports = new Set<string>()
  for (const match of source.matchAll(/127\.0\.0\.1:(\d+)/g)) ports.add(match[1]!)
  return ports
}

/** The ports the model layer's shared candidate list knows about. */
function modelLayerPorts(): Set<string> {
  const source = read('factory/model-router/local-servers.ts')
  const ports = new Set<string>()
  for (const match of source.matchAll(/127\.0\.0\.1:(\d+)/g)) ports.add(match[1]!)
  return ports
}

const HARNESS_PORTS = harnessScanPorts()
const MODEL_LAYER_PORTS = modelLayerPorts()

/** The DEPLOYMENT's window: only ever true next to a deployment word. */
const DEPLOYMENT_NUMBER = /13,?312/gi
/** The MODEL's ceiling. */
const MODEL_CEILING = /\b32\s?k\b|32,768|32768/gi
const DEPLOYMENT_WORD = /deploy|serv(e|es|ed|ing)|server|colab|\bt4\b|box|local window/i
const MODEL_WORD = /model|qwen|registry/i
/** "the model's window is ..." around the number - either order. */
const NUMBER_LABELLED_AS_MODEL_BEFORE =
  /(?:\bmodel(?:'s|s')?|\bqwen[^\s]*)[^.;:!?]{0,30}(?:window|limit|ceiling|context)[^.;:!?]{0,30}13,?312/i
const NUMBER_LABELLED_AS_MODEL_AFTER =
  /13,?312[^.;:!?]{0,40}(?:window|limit|ceiling|context)[^.;:!?]{0,40}\bmodel\b/i
/** The rule that decides between the two numbers. */
const SMALLER_WINS =
  /smaller\s+one\s+wins|smallest\s+one\s+wins|smaller\s+of\s+the\s+two|the\s+lower\s+(?:one|of)|\bmin\b/i
/** "the deployment gives you the full 32K" - the conflation this file exists for. */
const FULL_CEILING_CLAIM =
  /(?:deploy|colab|\bt4\b|box)[^.;:!?]{0,100}(?:full|entire|whole|complete|exactly)?\s*(?:32\s?k|32,768|32768)[^.;:!?]{0,20}(?:window|budget|room|space|limit|ceiling)/i
/** Words that mean "we found it for you". */
const DETECTION_WORD = /auto-?detect|detect(?:s|ed|ion)?|discover|scan|probe|finds?\b/i
/** The live seat mechanism. */
const LIVE_MECHANISM: Array<[string, RegExp]> = [
  ['probe', /probe/i],
  ['score', /score/i],
  ['best', /best/i],
  ['capability', /capabilit/i],
  ['route', /route/i],
  ['fit', /\bfit\b/i],
]
/** A gate that no live flow runs. */
const GATE_LANGUAGE = /try[- ]?out|qualif(?:y|ies|ied|ication)|pass[- ]?rate/i
/** "the model was admitted to the team" / "the model is muted". */
const GATE_ACTION =
  /\b(?:admit(?:s|ted|ting)?|mute[sd]?)\b[^.;:!?]{0,40}\b(?:seat|model|pool|team|crew)\b|\b(?:seat|model|pool|team|crew)\b[^.;:!?]{0,40}\b(?:admit(?:s|ted|ting)?|mute[sd]?)\b/i
/** A negative that makes a sentence true about a gap. */
const NEGATION = /not\b|never|no\b|yet\b/i

async function main(): Promise<void> {
  // ── Claim 1: vLLM ──────────────────────────────────────────────────────
  for (const corpus of corpora) {
    for (const sentence of corpus.sentences) {
      if (!/vllm/i.test(sentence)) continue

      // A claim that vLLM is found automatically must name the port.
      if (DETECTION_WORD.test(sentence)) {
        assert.ok(
          sentence.includes(':8000'),
          `${corpus.name}: a vLLM detection claim must name the port :8000: ${sentence}`,
        )
      }

      // The product must not claim whole-product auto-detection of vLLM
      // unless the harness scan REALLY probes it. The truth is read from
      // the code, never assumed: the gap was real when this rule was
      // written (2026-11-05) and the scan now probes :8000, so the rule
      // follows the code instead of the old state of the world.
      const claimsAutoDetect =
        /auto-?detect\w*[^.]{0,120}\bvllm\b/i.test(sentence) ||
        /\bvllm\b[^.]{0,120}auto-?detect\w*/i.test(sentence)
      if (claimsAutoDetect && !HARNESS_PORTS.has('8000')) {
        assert.ok(
          NEGATION.test(sentence),
          `${corpus.name}: the harness scan does not probe vLLM :8000, so the copy may not claim it is auto-detected: ${sentence}`,
        )
      }
    }
  }

  // The ports the copy claims are auto-detected must be ports the harness
  // really scans - a claim is a claim about the code.
  for (const corpus of corpora) {
    for (const sentence of corpus.sentences) {
      if (!/auto-?detect/i.test(sentence)) continue
      for (const match of sentence.matchAll(/:(\d{4,5})\b/g)) {
        const port = match[1]!
        assert.ok(
          HARNESS_PORTS.has(port),
          `${corpus.name}: claims to auto-detect :${port}, but the harness scan does not probe it (it probes ${[...HARNESS_PORTS].join(', ')})`,
        )
      }
    }
  }

  // If the copy says the scan does not probe :8000, that must still be true.
  const saysVllmNotScanned = corpora.some(corpus =>
    corpus.sentences.some(
      sentence =>
        /vllm/i.test(sentence) &&
        /does not (probe|scan|detect)|not (probed|scanned|detected)/i.test(sentence),
    ),
  )
  if (saysVllmNotScanned) {
    assert.ok(
      !HARNESS_PORTS.has('8000'),
      'the copy says the local scan does not probe vLLM :8000, but the harness scan now does - update the copy',
    )
  }
  // A claim that the product finds vLLM by itself must be backed by the scan.
  const claimsVllmAutoDetect = corpora.some(corpus =>
    corpus.sentences.some(
      sentence =>
        /vllm/i.test(sentence) &&
        /auto-?detect/i.test(sentence) &&
        !NEGATION.test(sentence),
    ),
  )
  if (claimsVllmAutoDetect) {
    assert.ok(
      HARNESS_PORTS.has('8000'),
      'the copy claims vLLM is auto-detected, but the harness scan does not probe :8000',
    )
  }
  // The model layer knows the port; that is the half that is true.
  assert.ok(
    MODEL_LAYER_PORTS.has('8000'),
    'the model layer candidate list should still carry the vLLM :8000 entry',
  )

  // ── Claim 2: which model takes a seat ─────────────────────────────────
  for (const corpus of corpora) {
    assert.ok(
      !/which model earns a seat/i.test(corpus.text),
      `${corpus.name}: "which model earns a seat" is a tryout-gate claim, and no live flow runs a gate`,
    )

    const mechanism = corpus.sentences.filter(
      sentence =>
        LIVE_MECHANISM.filter(([, re]) => re.test(sentence)).length >= 3 &&
        /seat|pool|crew|role|model/i.test(sentence),
    )
    assert.ok(
      mechanism.length > 0,
      `${corpus.name}: must state the live seat mechanism (probe / score / best / capability), not a gate`,
    )

    for (const sentence of corpus.sentences) {
      assert.ok(
        !GATE_LANGUAGE.test(sentence) && !GATE_ACTION.test(sentence),
        `${corpus.name}: a tryout / qualification gate is not wired into any live flow: ${sentence}`,
      )
    }
  }

  // ── Claim 3: the context window ───────────────────────────────────────
  for (const corpus of corpora) {
    // With both numbers in the copy, the rule that decides between them
    // has to be in the copy too - otherwise 32K reads as "what you get".
    const mentionsModelCeiling = /\b32\s?k\b|32,768|32768/i.test(corpus.text)
    const mentionsDeploymentWindow = /13,?312/i.test(corpus.text)
    if (mentionsModelCeiling && mentionsDeploymentWindow) {
      assert.ok(
        SMALLER_WINS.test(corpus.text),
        `${corpus.name}: with both the model ceiling and the deployment window in the copy, the smaller-one-wins rule must be stated`,
      )
    }

    for (const sentence of corpus.sentences) {
      assert.ok(
        !FULL_CEILING_CLAIM.test(sentence),
        `${corpus.name}: the deployment does not hand out the model's full ceiling: ${sentence}`,
      )
      for (const hit of occurrences(sentence, DEPLOYMENT_NUMBER)) {
        const before = sentence.slice(Math.max(0, hit.start - 160), hit.start)
        const around = sentence.slice(
          Math.max(0, hit.start - 160),
          Math.min(sentence.length, hit.end + 120),
        )
        assert.ok(
          DEPLOYMENT_WORD.test(before),
          `${corpus.name}: 13,312 is the DEPLOYMENT's window - label it as one (a deployment/serve/server word nearby): ${sentence}`,
        )
        assert.ok(
          !NUMBER_LABELLED_AS_MODEL_BEFORE.test(around) &&
            !NUMBER_LABELLED_AS_MODEL_AFTER.test(around),
          `${corpus.name}: 13,312 must not be presented as the model's own limit: ${sentence}`,
        )
      }
      for (const hit of occurrences(sentence, MODEL_CEILING)) {
        const around = sentence.slice(
          Math.max(0, hit.start - 160),
          Math.min(sentence.length, hit.end + 160),
        )
        assert.ok(
          MODEL_WORD.test(around),
          `${corpus.name}: 32K is the MODEL's own ceiling - label it as one (a model/Qwen/registry word nearby): ${sentence}`,
        )
      }
    }
  }

  console.log('public-claims: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

/**
 * Offline test for the per-model specification registry: alias dedupe, the
 * real window per size, unknown-model behaviour (null / 0 / false / generic),
 * tool-reasoning-vision flags, tokenizer families and the provider-optional
 * contract. No network, no keys.
 */
import assert from 'node:assert/strict'
import {
  canonicalModelKey,
  contextWindowFor,
  describeModelSpec,
  knownModelFamilies,
  lookupModelSpec,
  maxOutputFor,
  supportsReasoningFor,
  supportsToolsFor,
  supportsVisionFor,
  tokenizerFamilyFor,
} from './model-registry'

async function main(): Promise<void> {
  // 1. Alias dedupe: four spellings of one model, one canonical key.
  const spellings = [
    'qwen2.5-coder-3b-instruct',
    'Qwen2.5-Coder-3B',
    'qwen2.5-coder-3b',
    'qwen2.5-coder:3b',
  ]
  const keys = spellings.map(id => canonicalModelKey(id))
  assert.equal(new Set(keys).size, 1, `four spellings must dedupe: ${keys.join(', ')}`)
  assert.equal(keys[0], 'qwen2.5-coder-3b')
  for (const id of spellings) {
    assert.equal(canonicalModelKey(id), 'qwen2.5-coder-3b', id)
    assert.equal(contextWindowFor(id), 32768, id)
  }

  // 2. Quantisation suffix, underscore version and provider prefixes vanish.
  assert.equal(
    canonicalModelKey('Qwen3_5-4B-IQ4_XS'),
    canonicalModelKey('qwen3.5-4b-instruct'),
    'quantised llama.cpp file name and plain id are the same model',
  )
  assert.equal(canonicalModelKey('Qwen3_5-4B-IQ4_XS'), 'qwen3.5-4b')
  assert.equal(canonicalModelKey('qwen2.5-coder-3b-q4_k_m'), 'qwen2.5-coder-3b')
  assert.equal(canonicalModelKey('qwen2.5-coder-3b-q5_k_m'), 'qwen2.5-coder-3b')
  assert.equal(canonicalModelKey('openrouter/qwen/qwen2.5-coder-3b-instruct'), 'qwen2.5-coder-3b')
  assert.equal(canonicalModelKey('local/qwen2.5-coder-3b-instruct'), 'qwen2.5-coder-3b')
  assert.equal(canonicalModelKey('nvidia/meta/llama-3.1-8b-instruct'), 'llama-3.1-8b')
  assert.equal(canonicalModelKey('zen/qwen3-8b'), 'qwen3-8b')
  assert.equal(contextWindowFor('qwen2.5-coder-3b-instruct-q4_k_m.gguf'), 32768)

  // 3. The real window per size (no more one window for every local model).
  assert.equal(contextWindowFor('qwen2.5-coder-0.5b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-1.5b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-3b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-7b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-14b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-32b'), 32768)
  assert.equal(contextWindowFor('qwen2.5-3b-instruct'), 32768)
  assert.equal(contextWindowFor('qwen2.5-7b-instruct'), 32768)
  assert.equal(contextWindowFor('qwen3-4b'), 32768)
  assert.equal(contextWindowFor('qwen3-8b'), 32768)
  assert.equal(contextWindowFor('qwen3.5-4b'), 32768)
  assert.equal(contextWindowFor('deepseek-r1-distill-qwen-1.5b'), 131072)
  assert.equal(contextWindowFor('deepseek-r1-distill-qwen-7b'), 131072)
  assert.equal(contextWindowFor('llama-3.2-1b'), 131072)
  assert.equal(contextWindowFor('llama-3.2-3b'), 131072)
  assert.equal(contextWindowFor('llama-3.1-8b'), 131072)
  assert.equal(contextWindowFor('gemma-2-2b'), 8192)
  assert.equal(contextWindowFor('gemma-2-9b'), 8192)
  assert.equal(contextWindowFor('smollm2-1.7b'), 8192)
  assert.equal(contextWindowFor('phi-3.5-mini'), 131072)
  assert.equal(contextWindowFor('codellama-7b'), 16384)
  assert.equal(contextWindowFor('codellama-13b'), 16384)
  assert.equal(contextWindowFor('codellama-34b'), 16384)
  assert.equal(contextWindowFor('starcoder2-3b'), 16384)
  assert.equal(contextWindowFor('starcoder2-7b'), 16384)
  assert.equal(contextWindowFor('starcoder2-15b'), 16384)

  // 4. A size suffix selects the right spec, not just the right window.
  const coder3 = lookupModelSpec('qwen2.5-coder-3b')
  const coder7 = lookupModelSpec('qwen2.5-coder-7b')
  assert.ok(coder3 && coder7)
  assert.equal(coder3.label, 'Qwen2.5 Coder 3B')
  assert.equal(coder7.label, 'Qwen2.5 Coder 7B')
  assert.notEqual(canonicalModelKey('qwen2.5-coder-3b'), canonicalModelKey('qwen2.5-coder-7b'))
  assert.notEqual(maxOutputFor('qwen2.5-coder-0.5b'), maxOutputFor('qwen2.5-coder-32b'))
  assert.ok(maxOutputFor('qwen2.5-coder-3b') > 0)
  assert.ok(
    maxOutputFor('qwen2.5-coder-3b') <= contextWindowFor('qwen2.5-coder-3b'),
    'max output must fit inside the window',
  )

  // 5. An unknown model behaves exactly as before: null / 0 / false / generic.
  assert.equal(lookupModelSpec('totally-unknown-model'), null)
  assert.equal(contextWindowFor('totally-unknown-model'), 0)
  assert.equal(maxOutputFor('totally-unknown-model'), 0)
  assert.equal(supportsToolsFor('totally-unknown-model'), false)
  assert.equal(supportsReasoningFor('totally-unknown-model'), false)
  assert.equal(supportsVisionFor('totally-unknown-model'), false)
  assert.equal(tokenizerFamilyFor('totally-unknown-model'), 'generic')
  assert.equal(lookupModelSpec(''), null)
  assert.equal(contextWindowFor(''), 0)
  // A known family with an unknown size is unknown too: never guess a window.
  assert.equal(lookupModelSpec('qwen2.5-coder-72b'), null)
  assert.equal(contextWindowFor('qwen2.5-coder-72b'), 0)
  // An unknown model still gets a stable identity, so two spellings dedupe.
  assert.equal(canonicalModelKey('laguna-xs'), canonicalModelKey('LAGUNA-XS'))
  assert.equal(canonicalModelKey('laguna-xs'), 'laguna-xs')
  assert.equal(canonicalModelKey('qwen2.5-coder-72b'), 'qwen2.5-coder-72b')
  assert.equal(canonicalModelKey('my-model-q4_k_m'), 'my-model')

  // 6. Tool / reasoning / vision flags for specific known models.
  assert.equal(supportsToolsFor('qwen2.5-coder-3b'), false, 'small coder: no native tool calls')
  assert.equal(supportsToolsFor('codellama-7b'), false)
  assert.equal(supportsToolsFor('starcoder2-7b'), false)
  assert.equal(supportsToolsFor('qwen3-8b'), true)
  assert.equal(supportsToolsFor('qwen3.5-4b'), true)
  assert.equal(supportsToolsFor('llama-3.1-8b'), true)
  assert.equal(supportsToolsFor('hermes-3-llama-3.1-8b'), true)
  assert.equal(supportsReasoningFor('deepseek-r1-distill-qwen-7b'), true)
  assert.equal(supportsReasoningFor('deepseek-r1-distill-qwen-1.5b'), true)
  assert.equal(supportsReasoningFor('qwen3-8b'), true)
  assert.equal(supportsReasoningFor('qwen2.5-coder-3b'), false)
  assert.equal(supportsVisionFor('qwen2.5-vl-7b'), true)
  assert.equal(supportsVisionFor('qwen2.5-coder-3b'), false)
  assert.equal(supportsVisionFor('llama-3.2-3b'), false)
  assert.equal(supportsVisionFor('gemma-2-9b'), false)

  // 7. Tokenizer family selection.
  assert.equal(tokenizerFamilyFor('qwen2.5-coder-3b'), 'qwen')
  assert.equal(tokenizerFamilyFor('qwen3.5-4b'), 'qwen')
  assert.equal(tokenizerFamilyFor('llama-3.2-3b'), 'llama')
  assert.equal(tokenizerFamilyFor('phi-3.5-mini'), 'llama')
  assert.equal(tokenizerFamilyFor('gemma-2-2b'), 'gemma')
  assert.equal(tokenizerFamilyFor('mistral-7b-instruct-v0.3'), 'mistral')
  assert.equal(tokenizerFamilyFor('deepseek-r1'), 'deepseek')

  // 8. The provider refines but is never required.
  assert.equal(contextWindowFor('qwen2.5-coder-3b-instruct', 'openrouter'), 32768)
  assert.equal(contextWindowFor('qwen2.5-coder-3b-instruct', 'local'), 32768)
  assert.equal(contextWindowFor('meta/llama-3.1-8b-instruct', 'nvidia'), 131072)
  assert.equal(contextWindowFor('nvidia/meta/llama-3.1-8b-instruct'), 131072)
  assert.equal(contextWindowFor('qwen/qwen2.5-coder-32b-instruct', 'openrouter'), 32768)
  assert.equal(lookupModelSpec('qwen2.5-coder-3b-instruct', 'openrouter')?.family, 'qwen2.5-coder')
  assert.equal(lookupModelSpec('nope-not-a-model', 'openrouter'), null)

  // 9. Case-insensitivity across the whole table.
  assert.equal(contextWindowFor('QWEN2.5-CODER-3B'), 32768)
  assert.equal(contextWindowFor('LLAMA-3.2-3B'), 131072)
  assert.equal(contextWindowFor('DeepSeek-R1-Distill-Qwen-7B'), 131072)

  // 10. The family list is sorted, unique and contains the known families.
  const families = knownModelFamilies()
  assert.ok(families.includes('qwen2.5-coder'))
  assert.ok(families.includes('llama-3.2'))
  assert.ok(families.includes('gemma-2'))
  assert.ok(families.includes('smollm2'))
  assert.ok(families.includes('codellama'))
  assert.ok(families.includes('starcoder2'))
  assert.equal(new Set(families).size, families.length, 'families are unique')
  assert.deepEqual(families, [...families].sort(), 'families are sorted')

  // 11. The one-line description is honest and mentions the real numbers.
  const described = describeModelSpec(coder3)
  assert.ok(described.includes('Qwen2.5 Coder 3B'), described)
  assert.ok(described.includes('32768'), described)
  assert.ok(described.includes('tools=no'), described)
  assert.ok(!described.includes('\n'), 'one line only')
  assert.equal(described.split('\n').length, 1)

  console.log('model-registry: PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

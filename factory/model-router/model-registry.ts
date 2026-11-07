/**
 * Per-model specification registry (2026-11-05): know what you are talking to.
 *
 * The model layer used to treat every `local` route as ONE model with ONE
 * hardcoded 13,312-token window, and every hosted route as "unknown" (no
 * clamp at all). Both halves were wrong: a 3B model with a 32K window was cut
 * at 13K, and a hosted model with a 200K window was never trimmed. The layer
 * simply did not know which model it was calling.
 *
 * This file is the missing half: a per-model record of the REAL limits -
 * context window, safe max output, tool / reasoning / vision support and the
 * tokenizer family - so the budget can be computed from the model instead of
 * from a route constant.
 *
 * Rules of the house:
 *  - Pure functions, no classes, no I/O, no network, no clock.
 *  - An UNKNOWN model returns null / 0 / false / 'generic'. Never guess a
 *    window: inventing a ceiling cuts a good prompt for no reason, and
 *    inventing a floor lets the server truncate the head of the prompt.
 *  - Matching is case-insensitive and spelling-tolerant: one model arrives as
 *    'qwen2.5-coder-3b-instruct', 'Qwen2.5-Coder-3B', 'qwen2.5-coder:3b'
 *    (Ollama tag) or 'Qwen3_5-4B-IQ4_XS' (a llama.cpp file name).
 *  - `provider` may refine a match but is NEVER required.
 */

/** Tokenizer families the estimator knows how to charge for. */
export type TokenizerFamily =
  | 'qwen'
  | 'llama'
  | 'gemma'
  | 'mistral'
  | 'deepseek'
  | 'generic'

/** What the factory needs to know about one model. */
export interface ModelSpec {
  /** Canonical model family key, e.g. 'qwen2.5-coder'. */
  family: string
  /** Human label, e.g. 'Qwen2.5 Coder 3B'. */
  label: string
  /** Context window in tokens. */
  contextWindow: number
  /** Safe max output tokens to request. */
  maxOutputTokens: number
  supportsTools: boolean
  supportsReasoning: boolean
  supportsVision: boolean
  tokenizer: TokenizerFamily
}

/** The per-size part of a spec (family and tokenizer come from the rule). */
interface SpecFields {
  label: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsReasoning: boolean
  supportsVision: boolean
}

/** One family: how to recognise it and what each size looks like. */
interface FamilyRule {
  family: string
  /** Matched against the flattened id (dots and underscores became dashes). */
  detect: RegExp
  tokenizer: TokenizerFamily
  /**
   * Size key that is NOT spelled out in the id (e.g. 'full' for DeepSeek-R1).
   * It is the fallback when the id carries no size, and it is left out of
   * the canonical key because the id never carried it.
   */
  implicitSize?: string
  sizes: Record<string, SpecFields>
}

/**
 * The table. Ordered: the first rule whose `detect` matches wins, so the
 * specific rules (qwen2.5-coder, qwen3.5, codellama) sit above the broad
 * ones (qwen2.5, llama-3.1, mistral).
 *
 * Windows are the model's own advertised window, not a wish:
 *  - Qwen2.5 / Qwen2.5-Coder / Qwen3: 32,768 native (128K with YaRN on the
 *    7B+ coder sizes). We quote the native window: it is what a plain
 *    llama.cpp / Ollama serve gives.
 *  - Llama 3.1 / 3.2 and Phi-3.5-mini: 131,072.
 *  - Gemma 2 and SmolLM2: 8,192.
 *  - CodeLlama and StarCoder2: 16,384.
 */
const FAMILY_RULES: FamilyRule[] = [
  {
    family: 'qwen2.5-coder',
    detect: /qwen-?2-?5-coder/,
    tokenizer: 'qwen',
    sizes: {
      '0.5b': {
        label: 'Qwen2.5 Coder 0.5B',
        contextWindow: 32768,
        maxOutputTokens: 2048,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '1.5b': {
        label: 'Qwen2.5 Coder 1.5B',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '3b': {
        label: 'Qwen2.5 Coder 3B',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '7b': {
        label: 'Qwen2.5 Coder 7B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '14b': {
        label: 'Qwen2.5 Coder 14B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '32b': {
        label: 'Qwen2.5 Coder 32B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'qwen2.5-vl',
    detect: /qwen-?2-?5-vl/,
    tokenizer: 'qwen',
    sizes: {
      '3b': {
        label: 'Qwen2.5-VL 3B',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: true,
      },
      '7b': {
        label: 'Qwen2.5-VL 7B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: true,
      },
      '72b': {
        label: 'Qwen2.5-VL 72B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: true,
      },
    },
  },
  {
    family: 'qwen3.5',
    detect: /qwen-?3-?5(?![0-9])/,
    tokenizer: 'qwen',
    sizes: {
      '4b': {
        label: 'Qwen3.5 4B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
    },
  },
  {
    family: 'qwen3-coder',
    detect: /qwen-?3-coder/,
    tokenizer: 'qwen',
    sizes: {
      '30b': {
        label: 'Qwen3-Coder 30B A3B',
        contextWindow: 262144,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'qwen3',
    detect: /qwen-?3(?![0-9])/,
    tokenizer: 'qwen',
    sizes: {
      '4b': {
        label: 'Qwen3 4B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
      '8b': {
        label: 'Qwen3 8B',
        contextWindow: 32768,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
      '14b': {
        label: 'Qwen3 14B',
        contextWindow: 32768,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
      '30b': {
        label: 'Qwen3 30B A3B',
        contextWindow: 32768,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
      '32b': {
        label: 'Qwen3 32B',
        contextWindow: 32768,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
    },
  },
  {
    family: 'qwen2.5',
    detect: /qwen-?2-?5(?![0-9])/,
    tokenizer: 'qwen',
    sizes: {
      '0.5b': {
        label: 'Qwen2.5 0.5B Instruct',
        contextWindow: 32768,
        maxOutputTokens: 2048,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '1.5b': {
        label: 'Qwen2.5 1.5B Instruct',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '3b': {
        label: 'Qwen2.5 3B Instruct',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '7b': {
        label: 'Qwen2.5 7B Instruct',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'deepseek-r1-distill-qwen',
    detect: /deepseek-r1-distill-qwen/,
    tokenizer: 'qwen',
    sizes: {
      '1.5b': {
        label: 'DeepSeek-R1 Distill Qwen 1.5B',
        contextWindow: 131072,
        maxOutputTokens: 16384,
        supportsTools: false,
        supportsReasoning: true,
        supportsVision: false,
      },
      '7b': {
        label: 'DeepSeek-R1 Distill Qwen 7B',
        contextWindow: 131072,
        maxOutputTokens: 16384,
        supportsTools: false,
        supportsReasoning: true,
        supportsVision: false,
      },
    },
  },
  {
    family: 'deepseek-r1',
    detect: /deepseek-r1(?!-distill)/,
    tokenizer: 'deepseek',
    implicitSize: 'full',
    sizes: {
      full: {
        label: 'DeepSeek-R1',
        contextWindow: 65536,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: false,
      },
    },
  },
  {
    family: 'deepseek-chat',
    detect: /deepseek-(chat|v3)/,
    tokenizer: 'deepseek',
    implicitSize: 'full',
    sizes: {
      full: {
        label: 'DeepSeek Chat (V3)',
        contextWindow: 65536,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'hermes-3',
    detect: /hermes-?3/,
    tokenizer: 'llama',
    implicitSize: '8b',
    sizes: {
      '8b': {
        label: 'Hermes 3 Llama 3.1 8B',
        contextWindow: 131072,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'codellama',
    detect: /code-?llama/,
    tokenizer: 'llama',
    sizes: {
      '7b': {
        label: 'CodeLlama 7B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '13b': {
        label: 'CodeLlama 13B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '34b': {
        label: 'CodeLlama 34B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'starcoder2',
    detect: /starcoder-?2/,
    tokenizer: 'generic',
    sizes: {
      '3b': {
        label: 'StarCoder2 3B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '7b': {
        label: 'StarCoder2 7B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '15b': {
        label: 'StarCoder2 15B',
        contextWindow: 16384,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'llama-3.2',
    detect: /llama-?3-?2(?![0-9])/,
    tokenizer: 'llama',
    sizes: {
      '1b': {
        label: 'Llama 3.2 1B',
        contextWindow: 131072,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
      '3b': {
        label: 'Llama 3.2 3B',
        contextWindow: 131072,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'llama-3.1',
    detect: /llama-?3-?1(?![0-9])/,
    tokenizer: 'llama',
    sizes: {
      '8b': {
        label: 'Llama 3.1 8B',
        contextWindow: 131072,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'gemma-2',
    detect: /gemma-?2(?![0-9])/,
    tokenizer: 'gemma',
    sizes: {
      '2b': {
        label: 'Gemma 2 2B',
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
      '9b': {
        label: 'Gemma 2 9B',
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'smollm2',
    detect: /smollm-?2/,
    tokenizer: 'llama',
    sizes: {
      '1.7b': {
        label: 'SmolLM2 1.7B',
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'phi-3.5-mini',
    detect: /phi-?3-?5/,
    tokenizer: 'llama',
    implicitSize: 'mini',
    sizes: {
      mini: {
        label: 'Phi 3.5 mini',
        contextWindow: 131072,
        maxOutputTokens: 4096,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'codestral',
    detect: /codestral/,
    tokenizer: 'mistral',
    sizes: {
      '22b': {
        label: 'Codestral 22B',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
  {
    family: 'mistral',
    detect: /mistral/,
    tokenizer: 'mistral',
    sizes: {
      '7b': {
        label: 'Mistral 7B Instruct v0.3',
        contextWindow: 32768,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      },
    },
  },
]

/** Hosted / local route prefixes that may sit in front of the model id. */
const PROVIDER_PREFIXES = [
  'openrouter',
  'nvidia',
  'local',
  'zen',
  'hf',
  'huggingface',
  'ollama',
  'together',
  'groq',
  'fireworks',
  'deepinfra',
]

/**
 * Quantisation / precision suffixes that say nothing about the model.
 * The 'q' is REQUIRED ('q4_k_m', 'iq4_xs'): a bare number is a size or a
 * version, never a quantisation tag.
 */
const QUANT_PATTERN =
  /[-_.](?:(?:i?q)\d+(?:[-_.](?:xs|k(?:[-_.](?:m|s))?|0|1))?|awq|gptq|gguf|fp\d+|bf\d+|nvfp\d+|mxfp\d+|w\d+a\d+|int\d+|\d+bit)(?=([-_.]|$))/g

/** A size token: '3b', '1.5b'. The 'b' must not be part of a longer word. */
const SIZE_PATTERN = /(\d+(?:\.\d+)?)b(?![a-z0-9])/

/** A size token on its own (an Ollama tag): '3b'. */
const SIZE_ONLY_PATTERN = /^\d+(?:\.\d+)?b$/

/** Lowercase, dots and underscores become dashes: 'qwen3_5-4b' -> 'qwen3-5-4b'. */
function flatten(value: string): string {
  return value.replace(/[._\s]+/g, '-').replace(/-+/g, '-').toLowerCase()
}

/** Strip quantisation / precision suffixes from an id. */
function stripQuant(value: string): string {
  const withoutQuant = value.replace(QUANT_PATTERN, '')
  const withoutLeading = withoutQuant.replace(
    /^(?:awq|gptq|gguf|fp\d+|bf\d+|(?:i?q)\d+)(?:[-_.]|$)/,
    '',
  )
  return withoutLeading.replace(/[-_.]{2,}/g, '-')
}

/** Strip known route prefixes (and the caller's own provider prefix). */
function stripProviderPrefixes(value: string, providerName: string): string {
  let out = value
  let changed = true
  while (changed) {
    changed = false
    const prefixes =
      providerName.length > 0 ? [providerName, ...PROVIDER_PREFIXES] : PROVIDER_PREFIXES
    for (const prefix of prefixes) {
      if (out.startsWith(`${prefix}/`)) {
        out = out.slice(prefix.length + 1)
        changed = true
      }
    }
  }
  return out
}

/** The size written in the id, e.g. '3b' or '1.5b'. */
function extractSize(value: string): string | null {
  const text = value.replace(/_/g, '.')
  const match = SIZE_PATTERN.exec(text)
  const captured = match?.[1]
  return captured ? `${captured.toLowerCase()}b` : null
}

/** The provider name, reduced to something that can prefix an id. */
function normalizeProvider(provider?: string): string {
  if (!provider) return ''
  return provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * The fallback key for a model we do not know: the id itself, lower case,
 * with underscores turned into the dots that version numbers use and with
 * the quantisation suffix already gone. The size is kept where the id put
 * it, and appended only when the id did not spell it out.
 */
function fallbackKey(candidate: string, size: string | null): string {
  const key = candidate.replace(/_/g, '.').replace(/\.{2,}/g, '.')
  if (!size) return key
  if (key.includes(size)) return key
  return key.length > 0 ? `${key}-${size}` : size
}

/** The id, cut into the pieces the matcher works with. */
interface NormalizedModel {
  /** Candidate spellings to try, most specific first. */
  candidates: string[]
  /** Size carried by an Ollama tag (':3b'), used when the base has none. */
  tagSize: string | null
}

function normalizeModelId(modelId: string, provider?: string): NormalizedModel | null {
  const raw = modelId.trim().toLowerCase()
  if (raw.length === 0) return null
  const withoutExtension = raw.replace(/\.(gguf|safetensors|bin|pt|pth|onnx|mlx)$/, '')
  const colon = withoutExtension.indexOf(':')
  const base = colon > 0 ? withoutExtension.slice(0, colon) : withoutExtension
  const tag = colon > 0 ? withoutExtension.slice(colon + 1).trim() : ''
  const providerName = normalizeProvider(provider)

  const candidates: string[] = []
  const addCandidate = (value: string): void => {
    const cleaned = stripQuant(stripProviderPrefixes(value, providerName)).trim()
    if (cleaned.length === 0) return
    if (!candidates.includes(cleaned)) candidates.push(cleaned)
  }
  addCandidate(base)
  const slash = base.lastIndexOf('/')
  if (slash >= 0) addCandidate(base.slice(slash + 1))
  addCandidate(withoutExtension)

  return {
    candidates,
    tagSize: SIZE_ONLY_PATTERN.test(tag) ? tag.toLowerCase() : null,
  }
}

/** The family a flattened id belongs to (null when we do not know it). */
function detectFamily(flat: string): FamilyRule | null {
  for (const rule of FAMILY_RULES) {
    if (rule.detect.test(flat)) return rule
  }
  return null
}

/** A resolved model: the spec plus its canonical identity. */
interface ResolvedModel {
  spec: ModelSpec
  canonical: string
}

function resolveModel(modelId: string, provider?: string): ResolvedModel | null {
  const normalized = normalizeModelId(modelId, provider)
  if (!normalized) return null
  for (const candidate of normalized.candidates) {
    const rule = detectFamily(flatten(candidate))
    if (!rule) continue
    const size = extractSize(candidate) ?? normalized.tagSize
    const sizeKey = size ?? rule.implicitSize
    if (!sizeKey) continue
    const fields = rule.sizes[sizeKey]
    if (!fields) continue
    const canonical =
      sizeKey === rule.implicitSize ? rule.family : `${rule.family}-${sizeKey}`
    return {
      spec: {
        family: rule.family,
        tokenizer: rule.tokenizer,
        label: fields.label,
        contextWindow: fields.contextWindow,
        maxOutputTokens: fields.maxOutputTokens,
        supportsTools: fields.supportsTools,
        supportsReasoning: fields.supportsReasoning,
        supportsVision: fields.supportsVision,
      },
      canonical,
    }
  }
  return null
}

/**
 * The spec for a model id, or null when we do not know the model.
 * `provider` is optional and may only refine the match.
 */
export function lookupModelSpec(modelId: string, provider?: string): ModelSpec | null {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec : null
}

/** The model's context window in tokens. 0 means unknown (so: no clamp). */
export function contextWindowFor(modelId: string, provider?: string): number {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.contextWindow : 0
}

/** The model's safe max output in tokens. 0 means unknown. */
export function maxOutputFor(modelId: string, provider?: string): number {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.maxOutputTokens : 0
}

/** Does the model do native tool calls? False when we do not know. */
export function supportsToolsFor(modelId: string, provider?: string): boolean {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.supportsTools : false
}

/** Does the model think before it answers? False when we do not know. */
export function supportsReasoningFor(modelId: string, provider?: string): boolean {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.supportsReasoning : false
}

/** Does the model read images? False when we do not know. */
export function supportsVisionFor(modelId: string, provider?: string): boolean {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.supportsVision : false
}

/** The tokenizer family of a model. 'generic' when we do not know. */
export function tokenizerFamilyFor(modelId: string, provider?: string): TokenizerFamily {
  const resolved = resolveModel(modelId, provider)
  return resolved ? resolved.spec.tokenizer : 'generic'
}

/**
 * Normalized identity of a model id, so the same model under four spellings
 * dedupes: 'qwen2.5-coder-3b-instruct', 'Qwen2.5-Coder-3B',
 * 'qwen2.5-coder-3b' and 'qwen2.5-coder:3b' all become
 * 'qwen2.5-coder-3b'.
 *
 * An unknown model falls back to its normalized spelling (lower case, the
 * quantisation suffix gone, the size kept where the id put it), which is
 * still a stable identity.
 */
export function canonicalModelKey(modelId: string): string {
  const resolved = resolveModel(modelId)
  if (resolved) return resolved.canonical
  const normalized = normalizeModelId(modelId)
  if (!normalized) return ''
  const fallback = normalized.candidates[0] ?? ''
  const size = extractSize(fallback) ?? normalized.tagSize
  return fallbackKey(fallback, size)
}

/** A short, honest one-line description for a receipt or a UI row. */
export function describeModelSpec(spec: ModelSpec): string {
  const flags =
    `tools=${spec.supportsTools ? 'yes' : 'no'} ` +
    `reasoning=${spec.supportsReasoning ? 'yes' : 'no'} ` +
    `vision=${spec.supportsVision ? 'yes' : 'no'}`
  return `${spec.label} | ctx=${spec.contextWindow} out=${spec.maxOutputTokens} | ${flags}`
}

/** Every family the registry knows, sorted. */
export function knownModelFamilies(): string[] {
  const families = new Set<string>()
  for (const rule of FAMILY_RULES) families.add(rule.family)
  return Array.from(families).sort()
}

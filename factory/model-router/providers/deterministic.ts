import type {
  ModelProvider,
  ModelRequirements,
} from '../types'

export class DeterministicProvider
  implements ModelProvider {
  readonly name = 'deterministic'

  supports(
    _requirements: ModelRequirements,
  ): boolean {
    return true
  }

  async listModels(): Promise<string[]> {
    return ['deterministic-v1']
  }

  async complete(
    _model: string,
    prompt: string,
  ): Promise<string> {
    const lower = prompt.toLowerCase()

    if (
      lower.includes(
        'you are the final engineering reviewer',
      ) ||
      lower.includes(
        'final engineering reviewer',
      )
    ) {
      return JSON.stringify({
        verdict: 'pass',
        summary:
          'Deterministic review passed.',
        findings: [],
        requiredChanges: [],
        evidence: [
          'Deterministic provider generated a valid review.',
        ],
      })
    }

    if (
      lower.includes('planner') ||
      lower.includes('planning')
    ) {
      return [
        '# Plan',
        '',
        '1. Implement the requested change.',
        '2. Add or preserve verification.',
        '3. Run the supplied tests.',
        '4. Confirm acceptance criteria.',
      ].join('\n')
    }

    if (
      lower.includes('architect') ||
      lower.includes('architecture')
    ) {
      return [
        '# Architecture',
        '',
        'Use a minimal implementation.',
        'Keep the solution testable.',
        'Respect the requested workspace.',
        'Respect the acceptance criteria.',
      ].join('\n')
    }

    return [
      '# Deterministic Engineering Output',
      '',
      'Implement the requested task exactly as specified.',
      'Keep changes minimal and focused.',
    ].join('\n')
  }
}
import {
  CliCodingAgentProvider,
} from './cli'

const OPEN_CODE_COMMAND =
  process.platform === 'win32'
    ? 'opencode.cmd'
    : 'opencode'

export const openCodeProvider =
  new CliCodingAgentProvider({
    id: 'opencode',
    command:
      OPEN_CODE_COMMAND,

    buildArgs:
      request => [
        'run',

        // opencode v2 scopes to the process cwd (runProcess / the Windows
        // script both enter request.workspace first); v1's --dir is gone.
        ...(request.model
          ? [
              '--model',
              request.model,
            ]
          : []),

        '--format',
        'json',

        ...(request.autoApprove
          ? ['--auto']
          : []),

        request.prompt,
      ],
  })

const CODEX_COMMAND =
  process.platform === 'win32'
    ? 'codex.cmd'
    : 'codex'

export const codexProvider =
  new CliCodingAgentProvider({
    id: 'codex',
    command:
      CODEX_COMMAND,

    buildArgs:
      request => [
        'exec',

        ...(request.model
          ? [
              '--model',
              request.model,
            ]
          : []),

        request.prompt,
      ],
  })

const GEMINI_COMMAND =
  process.platform === 'win32'
    ? 'gemini.cmd'
    : 'gemini'

export const geminiProvider =
  new CliCodingAgentProvider({
    id: 'gemini',
    command:
      GEMINI_COMMAND,

    buildArgs:
      request => [
        '--prompt',
        request.prompt,
      ],
  })

const FREEBUFF_COMMAND =
  process.platform === 'win32'
    ? 'freebuff.cmd'
    : 'freebuff'

export const freebuffProvider =
  new CliCodingAgentProvider({
    id: 'freebuff',
    command:
      FREEBUFF_COMMAND,

    buildArgs:
      request => [
        '--cwd',
        request.workspace,
        request.prompt,
      ],
  })

export * from './types'
export * from './cli'
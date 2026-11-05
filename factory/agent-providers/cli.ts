import { spawn } from 'node:child_process'
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  CodingAgentId,
  CodingAgentProvider,
  CodingAgentRequest,
  CodingAgentResult,
} from './types'

interface CliAgentOptions {
  id: CodingAgentId
  command: string
  buildArgs(
    request: CodingAgentRequest,
  ): string[]
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

function runProcess(
  command: string,
  args: string[],
  cwd?: string,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on(
      'data',
      chunk => {
        stdout += String(chunk)
      },
    )

    child.stderr.on(
      'data',
      chunk => {
        stderr += String(chunk)
      },
    )

    child.once(
      'error',
      error => {
        resolve({
          code: -1,
          stdout,
          stderr: error.message,
        })
      },
    )

    child.once(
      'close',
      code => {
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        })
      },
    )
  })
}

function powershellScript(
  lines: string[],
): string {
  return lines.join('\n')
}

const WINDOWS_VERSION_SCRIPT =
  powershellScript([
    'param(',
    '  [string] $Command',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    '',
    'if ($Command -eq "opencode") {',
    '  $Resolved = Get-Command "opencode.ps1" -ErrorAction Stop | Select-Object -First 1',
    '  Write-Host "[factory-cli] resolved OpenCode: $($Resolved.Source)"',
    '  & $Resolved.Source --version',
    '  exit $LASTEXITCODE',
    '}',
    '',
    '& $Command --version',
    'exit $LASTEXITCODE',
  ])

const WINDOWS_GENERIC_SCRIPT =
  powershellScript([
    'param(',
    '  [string] $Command,',
    '  [string] $Workspace,',
    '  [string] $PromptFile,',
    '  [string] $ArgsFile',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    '',
    'Set-Location -LiteralPath $Workspace',
    '',
    '$Prompt = Get-Content -LiteralPath $PromptFile -Raw',
    '',
    '$ArgsList = @(',
    '  Get-Content -LiteralPath $ArgsFile -Raw | ConvertFrom-Json',
    ')',
    '',
    '& $Command @ArgsList $Prompt',
    'exit $LASTEXITCODE',
  ])

const WINDOWS_OPENCODE_SCRIPT =
  powershellScript([
    'param(',
    '  [string] $Workspace,',
    '  [string] $PromptFile',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    '',
    'Set-Location -LiteralPath $Workspace',
    '',
    '$Prompt = Get-Content -LiteralPath $PromptFile -Raw',
    '',
    '$Resolved = Get-Command "opencode.ps1" -ErrorAction Stop | Select-Object -First 1',
    '',
    'Write-Host "[factory-cli] resolved OpenCode: $($Resolved.Source)"',
    'Write-Host "[factory-cli] workspace: $Workspace"',
    'Write-Host "[factory-cli] prompt length: $($Prompt.Length)"',
    '',
    '& $Resolved.Source run --format json --auto $Prompt',
    '',
    'exit $LASTEXITCODE',
  ])

async function runWindowsVersion(
  command: string,
): Promise<ProcessResult> {
  const tempDir =
    await mkdtemp(
      join(
        tmpdir(),
        'factory-agent-',
      ),
    )

  const scriptPath =
    join(
      tempDir,
      'version.ps1',
    )

  try {
    await writeFile(
      scriptPath,
      WINDOWS_VERSION_SCRIPT,
      'utf8',
    )

    return await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        command,
      ],
    )
  } finally {
    await rm(
      tempDir,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

async function runWindowsAgent(
  options: {
    command: string
    workspace: string
    prompt: string
    args: string[]
    opencode: boolean
  },
): Promise<ProcessResult> {
  const tempDir =
    await mkdtemp(
      join(
        tmpdir(),
        'factory-agent-',
      ),
    )

  const scriptPath =
    join(
      tempDir,
      options.opencode
        ? 'opencode.ps1'
        : 'run.ps1',
    )

  const promptPath =
    join(
      tempDir,
      'prompt.txt',
    )

  const argsPath =
    join(
      tempDir,
      'args.json',
    )

  try {
    await writeFile(
      scriptPath,
      options.opencode
        ? WINDOWS_OPENCODE_SCRIPT
        : WINDOWS_GENERIC_SCRIPT,
      'utf8',
    )

    await writeFile(
      promptPath,
      options.prompt,
      'utf8',
    )

    await writeFile(
      argsPath,
      JSON.stringify(
        options.args,
      ),
      'utf8',
    )

    const scriptArgs =
      options.opencode
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            options.workspace,
            promptPath,
          ]
        : [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            options.command,
            options.workspace,
            promptPath,
            argsPath,
          ]

    return await runProcess(
      'powershell.exe',
      scriptArgs,
      options.workspace,
    )
  } finally {
    await rm(
      tempDir,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

export class CliCodingAgentProvider
  implements CodingAgentProvider {
  readonly id: CodingAgentId

  private readonly command: string

  private readonly buildArgs:
    CliAgentOptions['buildArgs']

  constructor(
    options: CliAgentOptions,
  ) {
    this.id =
      options.id

    this.command =
      options.command

    this.buildArgs =
      options.buildArgs
  }

  async available(): Promise<boolean> {
    const result =
      process.platform ===
      'win32'
        ? await runWindowsVersion(
            this.command,
          )
        : await runProcess(
            this.command,
            ['--version'],
          )

    return result.code === 0
  }

  async run(
    request: CodingAgentRequest,
  ): Promise<CodingAgentResult> {
    const args =
      this.buildArgs(
        request,
      )

    const isOpenCode =
      this.id ===
      'opencode'

    const result =
      process.platform ===
      'win32'
        ? await runWindowsAgent({
            command:
              this.command,
            workspace:
              request.workspace,
            prompt:
              request.prompt,
            args,
            opencode:
              isOpenCode,
          })
        : await runProcess(
            this.command,
            args,
            request.workspace,
          )

    return {
      provider:
        this.id,

      status:
        result.code ===
        0
          ? 'completed'
          : 'failed',

      output:
        result.stdout,

      filesChanged:
        [],

      diagnostics:
        result.code ===
        0
          ? result.stderr ||
            undefined
          : (
              result.stderr ||
              `Agent exited with code ${result.code}.`
            ).trim(),
    }
  }
}
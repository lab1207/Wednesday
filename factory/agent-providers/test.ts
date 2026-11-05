import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'

import {
  openCodeProvider,
} from './index'

const WORKSPACE =
  join(INSTALL_ROOT, 'dsh-test-workspace')

const FILE =
  'opencode-v14-proof.txt'

const EXPECTED =
  'OPENCODE_V14_OK'

async function main(): Promise<void> {
  const target =
    join(WORKSPACE, FILE)

  await rm(
    target,
    {
      force: true,
    },
  )

  const available =
    await openCodeProvider.available()

  console.log(
    JSON.stringify(
      {
        provider:
          openCodeProvider.id,
        available,
      },
      null,
      2,
    ),
  )

  if (!available) {
    throw new Error(
      'OpenCode is not available.',
    )
  }

  const prompt = [
    'You are the coder for a software factory.',
    '',
    'Create exactly one file named opencode-v14-proof.txt.',
    '',
    'The entire contents of the file must be exactly:',
    'OPENCODE_V14_OK',
    '',
    'Do not create any other files.',
    'Do not add any other words.',
    'Do not add a date.',
    'Do not add an explanation.',
    'Do not create a different filename.',
    'Inspect the workspace first.',
    'Create the requested file now.',
    'Read the file back and verify its exact contents.',
    'Then stop.',
  ].join('\n')

  console.log(
    '--- ADAPTER PROMPT ---',
  )
  console.log(prompt)
  console.log(
    '--- END PROMPT ---',
  )

  const result =
    await openCodeProvider.run({
      taskId:
        'opencode-v14-adapter-test',

      workspace:
        WORKSPACE,

      prompt:
        prompt.trim(),

      timeoutMs:
        300000,

      autoApprove:
        true,
    })

  console.log(
    JSON.stringify(
      {
        provider:
          result.provider,
        status:
          result.status,
        diagnostics:
          result.diagnostics,
      },
      null,
      2,
    ),
  )

  if (
    result.status !==
    'completed'
  ) {
    throw new Error(
      result.diagnostics ??
        'OpenCode failed.',
    )
  }

  const fileExists =
    existsSync(target)

  if (!fileExists) {
    throw new Error(
      `OpenCode did not create ${target}`,
    )
  }

  const actual =
    (
      await readFile(
        target,
        'utf8',
      )
    ).trim()

  console.log(
    JSON.stringify(
      {
        fileExists,
        actualContent:
          actual,
      },
      null,
      2,
    ),
  )

  if (
    actual !==
    EXPECTED
  ) {
    throw new Error(
      [
        'OpenCode created the file,',
        'but the contents are incorrect.',
        '',
        `Expected: ${EXPECTED}`,
        `Actual:   ${actual}`,
      ].join('\n'),
    )
  }

  console.log(
    'AGENT PROVIDER TEST: PASS',
  )
}

void main()
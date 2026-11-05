import assert from 'node:assert/strict'

import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  resolveExecutorTimeoutMs,
  resolveTaskWorkspace,
} from './factory-executor'

// V1.7 hardening — executor timeout resolution.
// Run: npx tsx factory/executor/timeout-test.ts

async function main(): Promise<void> {
  const saved = process.env.FACTORY_EXECUTOR_TIMEOUT_MS

  try {
    delete process.env.FACTORY_EXECUTOR_TIMEOUT_MS
    assert.equal(
      resolveExecutorTimeoutMs(),
      DEFAULT_EXECUTOR_TIMEOUT_MS,
      'unset env must fall back to the 30-minute default',
    )
    assert.equal(DEFAULT_EXECUTOR_TIMEOUT_MS, 1800000)

    process.env.FACTORY_EXECUTOR_TIMEOUT_MS = '60000'
    assert.equal(resolveExecutorTimeoutMs(), 60000, 'env override must win over default')

    assert.equal(
      resolveExecutorTimeoutMs(5000),
      5000,
      'explicit option must win over env',
    )

    for (const bad of ['0', '-5', 'abc', '', 'NaN', 'Infinity']) {
      process.env.FACTORY_EXECUTOR_TIMEOUT_MS = bad
      assert.equal(
        resolveExecutorTimeoutMs(),
        DEFAULT_EXECUTOR_TIMEOUT_MS,
        `invalid env ${JSON.stringify(bad)} must fall back to default`,
      )
    }

    assert.equal(
      resolveExecutorTimeoutMs(0),
      DEFAULT_EXECUTOR_TIMEOUT_MS,
      'non-positive explicit must fall back to default',
    )
    assert.equal(
      resolveExecutorTimeoutMs(Number.NaN),
      DEFAULT_EXECUTOR_TIMEOUT_MS,
      'NaN explicit must fall back to default',
    )

    // Workspace fail-fast: missing workspaces throw instead of running
    // in the install root (layer audit 2026-09-21).
    assert.equal(resolveTaskWorkspace(process.cwd()), process.cwd())
    assert.throws(
      () => resolveTaskWorkspace('/nonexistent-dir-xyz-123'),
      /does not exist/,
    )
  } finally {
    if (saved === undefined) {
      delete process.env.FACTORY_EXECUTOR_TIMEOUT_MS
    } else {
      process.env.FACTORY_EXECUTOR_TIMEOUT_MS = saved
    }
  }

  console.log('EXECUTOR TIMEOUT TEST: PASS')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/**
 * The repo-local wrapper over the shipped gate (2026-11-08, B231).
 *
 * WHY THIS FILE IS SMALL: the gate's logic lives in
 * `factory/harness/commit-scan.ts`, which SHIPS with the package, so an
 * installed `@lab1207/wednesday` can run `wednesday scan` in any repository.
 * This file exists for THIS repo: `.githooks/pre-commit` calls it, so the
 * hook needs no install path and no PATH lookup, and the hook's gate and a
 * user's gate are the same implementation and cannot drift.
 */
import { printReport, repoRoot, scanStaged } from '../factory/harness/commit-scan'

const allow =
  process.argv.includes('--allow-findings') ||
  process.env.WEDNESDAY_SCAN_ALLOW === '1'

const repo = process.argv[2] ? repoRoot(process.argv[2]) : repoRoot()

process.exit(printReport(scanStaged(repo), { allow }))

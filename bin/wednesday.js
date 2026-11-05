#!/usr/bin/env node
// Development entrypoint: tsx is a declared local runtime dependency.
import { tsImport } from 'tsx/esm/api'

// `run()` rather than importing for side effects: harness.ts must be importable
// (the dispatch test drives its REPL loop with a real Screen), so the CLI is
// started explicitly from here instead of at module load.
const harness = await tsImport('../factory/harness/harness.ts', import.meta.url)
await harness.run(process.argv.slice(2))

#!/usr/bin/env node
// Development entrypoint: tsx is a declared local runtime dependency.
//
// This bin is the small operator CLI (create/run/status/team/scan) over
// Hermes and the Factory; the product surface is `wednesday-mcp`, which any
// MCP client connects to.
import { tsImport } from 'tsx/esm/api'

process.title = 'wednesday'

await tsImport('../factory/cli.ts', import.meta.url)

#!/usr/bin/env node
// MCP entrypoint (2026-11-14).
//
// A harness spawns this process and speaks newline-delimited JSON-RPC over
// its stdin/stdout. Everything the client sees comes from factory/mcp/server.ts;
// this file exists so `npx wednesday-mcp` is a real command, the same way
// `npx wednesday` is.
import { tsImport } from 'tsx/esm/api'

process.title = 'wednesday-mcp'

await tsImport('../factory/mcp/server.ts', import.meta.url)

/**
 * Wednesday, drawn by Ink.
 *
 *   node --import tsx factory/tui-ink/main.ts [--workspace dir]
 *
 * Same engine as `wednesday`: `parseFlags` -> `replLoop` -> the
 * FactoryService pipeline. The only difference is the surface - Ink's React
 * components instead of the hand-rolled ANSI screen or pi-tui.
 */
import { parseFlags } from '../harness/harness'
import { PersistentFactoryEventBus } from '../events'
import { EVENTS_PATH } from '../paths'
import { inkRepl } from './entry'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('wednesday (Ink surface)\n\n  node --import tsx factory/tui-ink/main.ts [--workspace dir]\n')
  process.exit(0)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('The Ink surface needs a terminal. Use `npx wednesday` for pipes.')
  process.exit(1)
}

process.title = 'wednesday'

const bus = new PersistentFactoryEventBus({ filePath: EVENTS_PATH })
await inkRepl({ defaults: parseFlags(argv), bus })

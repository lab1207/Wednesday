/**
 * Wednesday's Ink surface - the engine entry.
 *
 *   node --import tsx factory/tui-ink/main.ts
 *
 * Same brain as every other surface: `parseFlags` -> `replLoop` -> the
 * FactoryService pipeline. What differs is the drawing - Ink's React
 * components (MIT, (c) 2025 Vadim Demedes) instead of pi-tui's viewport.
 */
import { createElement } from 'react'
import { render } from 'ink'
import { firstRunOnboarding, parseFlags, replLoop } from '../harness/harness'
import { loadConfig } from '../config'
import { activeCrew, applyCrew } from '../teams/crew-store'
import { PersistentFactoryEventBus } from '../events'
import { EVENTS_PATH } from '../paths'
import { saveSession } from '../harness/session-store'
import { InkStore } from './store'
import { createInkUi } from './ui'
import { InkApp } from './frame'

process.title = 'wednesday'

export interface InkReplOptions {
  defaults: ReturnType<typeof parseFlags>
  bus: PersistentFactoryEventBus
  advisories?: {
    update?: () => Promise<string | null>
    health?: () => Promise<string | null>
  }
  resume?: import('../harness/session-store').StoredSession | null
}

export async function inkRepl(options: InkReplOptions): Promise<void> {
  const { defaults, bus } = options
  await loadConfig()

  const crew = activeCrew()
  if (crew) applyCrew(crew)

  const store = new InkStore()
  store.setHeader({ model: process.env.DSH_LLM_MODEL ?? 'auto', workspace: defaults.workspace, mode: 'ACT' })

  const ui = createInkUi({
    store,
    sessionId: options.resume?.id,
    workspace: defaults.workspace,
  })

  const app = render(createElement(InkApp, { store }))

  store.line('Welcome to Wednesday!')
  store.line('Type your message below, or / for commands.', 'dim')
  store.line('')

  const advisories = options.advisories ?? {}
  if (advisories.update) {
    try {
      const notice = await advisories.update()
      if (notice) store.line(notice, 'yellow')
    } catch { /* a failed update check is not news */ }
  }
  if (advisories.health) {
    try {
      const line = await advisories.health()
      if (line) store.line(`startup ${line}`, 'dim')
    } catch { /* a failed health check is not news either */ }
  }

  const resume = options.resume ?? null
  if (resume) {
    store.line(`resumed session ${resume.id}`, 'dim')
    for (const message of resume.messages.slice(-12)) {
      if (!message.text?.trim()) continue
      store.line(`${message.tone === 'bold' ? '>' : '*'} ${message.text}`, 'plain')
    }
  }

  ui.crewChanged?.()

  try {
    if (process.env.WEDNESDAY_NO_ONBOARDING !== '1') {
      const proven = await firstRunOnboarding(ui as never)
      if (proven?.ok) store.line(proven.detail, 'dim')
    }
    await replLoop(defaults, bus, ui as never, undefined, undefined)
  } catch (error) {
    store.line(`error: ${error instanceof Error ? error.message : String(error)}`, 'red')
  } finally {
    try {
      saveSession({
        id: resume?.id ?? `ink_${Date.now().toString(36)}`,
        startedAt: Date.now(),
        savedAt: Date.now(),
        composerLabel: store.header.model,
        tokens: 0,
        messages: store.lines.map((row) => ({ text: row.text, tone: row.tone as never })),
      })
    } catch { /* a failed save costs the resume, never the exit */ }
    app.unmount()
  }
}

/**
 * Wednesday's ENGINE, drawn by Ink.
 *
 * `createInkUi` implements the engine's `ReplUi` seam over the Ink store -
 * the same contract the pi surface implements, with React components instead
 * of pi-tui's. The engine was not modified: one interface, many renderers.
 */
import { activeCrew, crewSeatSummary, crewMeterName } from '../teams/crew-store'
import { currentView, renderDaily } from '../harness/journey'
import type { SelectOption } from '../harness/screen'
import { InkStore, type Line, type SideLine, type Tone } from './store'

interface ViewLine {
  text: string
  tone?: string
}

interface EngineeringTaskLike {
  objective: string
  constraints?: string[]
}

interface ImageAttachmentLike {
  id?: string
  path?: string
  [key: string]: unknown
}

export interface InkUiOptions {
  store: InkStore
  sessionId?: string
  workspace?: string
}

const narrow = (tone?: string): Tone => {
  if (tone === 'dim' || tone === 'cyan' || tone === 'yellow' || tone === 'red' || tone === 'green' || tone === 'bold') return tone
  return 'plain'
}

export function createInkUi(options: InkUiOptions) {
  const { store } = options
  const attachments: ImageAttachmentLike[] = []
  let density: 'normal' | 'compact' | 'verbose' = 'normal'
  const recent: string[] = []
  let journeyView: ReturnType<typeof currentView> | null = null

  const renderSide = (): void => {
    const lines: SideLine[] = []
    const crew = activeCrew()
    if (crew) {
      lines.push({ text: crew.name, tone: 'bold' })
      lines.push({ text: crewSeatSummary(crew), tone: 'dim' })
      const name = crewMeterName(crew)
      if (name) lines.push({ text: name, tone: 'cyan' })
    } else {
      lines.push({ text: 'no crew · env route', tone: 'dim' })
    }
    if (journeyView) {
      for (const row of renderDaily(journeyView, 26)) lines.push({ text: row.text, tone: row.tone })
    }
    if (recent.length > 0) {
      lines.push({ text: '', tone: 'dim' })
      lines.push({ text: 'recent', tone: 'bold' })
      for (const row of recent.slice(-6)) lines.push({ text: row, tone: 'dim' })
    }
    store.setSide(density === 'compact' ? [] : lines)
  }

  return {
    ask: async (prompt: string): Promise<string | undefined> => {
      const value = await new Promise<string | undefined>((resolve) => {
        store.setOverlay({ type: 'ask', prompt, input: '', resolve })
      })
      if (value !== undefined && value.trim() && /wednesday/i.test(prompt)) {
        store.line(`> ${value.trim()}`, 'bold')
      }
      return value
    },

    approve: (task: EngineeringTaskLike): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        store.setOverlay({ type: 'confirm', title: task.objective, detail: (task.constraints ?? []).join('\n'), yesLabel: 'Approve', index: 1, resolve })
      }),

    clarify: (question: string): Promise<{ answer?: string; cancelled?: 'escape' | 'ctrl-c' }> =>
      new Promise((resolve) => {
        store.setOverlay({ type: 'clarify', question, input: '', resolve })
      }),

    confirm: (title: string, detail: string, yesLabel: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        store.setOverlay({ type: 'confirm', title, detail, yesLabel, index: 1, resolve })
      }),

    note: (text: string): void => {
      store.note(text)
    },

    error: (text: string): void => {
      store.error(text)
    },

    block: (lines: ViewLine[]): void => {
      store.block(lines.map((row) => ({ text: row.text, tone: narrow(row.tone) })))
    },

    live: (key: string, row: ViewLine): void => {
      store.liveRow(key, { text: row.text, tone: narrow(row.tone) })
    },

    page: (title: string, lines: string[]): Promise<void> =>
      new Promise<void>((resolve) => {
        store.setOverlay({ type: 'page', title, lines, offset: 0, resolve })
      }),

    progress: (text: string): void => {
      store.setStatus({ working: true, sessionTitle: text })
    },

    running: (active: boolean): void => {
      store.setStatus({ working: active })
    },

    askPrivate: (prompt = '>'): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        store.setOverlay({ type: 'ask', prompt, input: '', resolve })
      }),

    askSecret: (prompt = 'secret'): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        store.setOverlay({ type: 'ask', prompt, input: '', masked: true, resolve })
      }),

    askConfig: (prompt = '>'): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        store.setOverlay({ type: 'ask', prompt, input: '', resolve })
      }),

    statusContext: (): { sessionId?: string; path?: string; busy?: boolean } => ({
      sessionId: options.sessionId,
      path: options.workspace,
      busy: store.status.working,
    }),

    context: (tokens: number): void => {
      if (tokens > 0) store.setStatus({ context: `ctx ${tokens}` })
    },

    select: (title: string, list: SelectOption[]): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        const options = list.map((option) => ({
          value: String(option.value ?? ''),
          label: option.title || option.section || String(option.value ?? ''),
          description: option.desc,
          section: Boolean(option.section),
        }))
        const firstSelectable = options.findIndex((o) => !o.section)
        store.setOverlay({
          type: 'select',
          title,
          options,
          filter: '',
          index: firstSelectable >= 0 ? firstSelectable : 0,
          resolve,
        })
      }),

    redraw: (): void => {
      store.emit()
    },

    prefill: (text: string): void => {
      store.setInput(text)
    },

    journeyChanged: (view: unknown): void => {
      journeyView = view as typeof journeyView
      renderSide()
    },

    pendingAttachments: (): ImageAttachmentLike[] => attachments,

    clearAttachments: (): void => {
      attachments.length = 0
    },

    attachImage: (attachment: unknown): void => {
      attachments.push(attachment as ImageAttachmentLike)
    },

    clearSession: (fresh: boolean): void => {
      store.lines = []
      store.live.clear()
      if (fresh) store.line('session cleared - a fresh session starts here', 'dim')
      store.emit()
    },

    watchRun: (onInterrupt: () => void): (() => void) => {
      store.onInterrupt = onInterrupt
      return () => {
        store.onInterrupt = null
      }
    },

    crewChanged: (): void => {
      renderSide()
    },

    chatActivity: (activity: { role: string; detail: string } | null): void => {
      if (activity) {
        store.setStatus({ working: true, sessionTitle: `${activity.role} · ${activity.detail}` })
        recent.push(`${activity.role}: ${activity.detail}`)
        if (recent.length > 12) recent.shift()
        renderSide()
      } else {
        store.setStatus({ working: false })
      }
    },

    routeLabel: (label: string): void => {
      store.setHeader({ model: label })
    },

    display: (mode?: 'normal' | 'compact' | 'verbose'): 'normal' | 'compact' | 'verbose' => {
      if (mode) {
        density = mode
        if (density === 'compact') {
          store.line('transcript density: compact - the crew · journey rail is hidden (verbose brings it back)', 'dim')
        } else {
          store.line(`transcript density: ${mode}`, 'dim')
        }
        renderSide()
      }
      return density
    },

    sessionTitle: (title: string): void => {
      store.setStatus({ sessionTitle: title })
    },
  }
}

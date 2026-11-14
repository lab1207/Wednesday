/**
 * Mutable store for the Ink surface.
 *
 * The engine's `ReplUi` is imperative (line, note, live, select), while Ink is
 * a React renderer. This store is the seam: the adapter writes to it, the Ink
 * component subscribes and re-renders. No engine code knows Ink exists.
 */
import { PALETTE } from '../harness/harness'

export type Tone = 'plain' | 'dim' | 'cyan' | 'yellow' | 'red' | 'green' | 'bold'

export interface Line {
  text: string
  tone?: string
}

export interface SideLine {
  text: string
  tone?: string
}

export interface SelectOptionLike {
  value: string
  label: string
  description?: string
  section?: boolean
}

export type Overlay =
  | {
      type: 'select'
      title: string
      options: SelectOptionLike[]
      filter: string
      index: number
      resolve: (value: string | undefined) => void
    }
  | {
      type: 'confirm'
      title: string
      detail: string
      yesLabel: string
      index: number
      resolve: (value: boolean) => void
    }
  | {
      type: 'page'
      title: string
      lines: string[]
      offset: number
      resolve: () => void
    }
  | {
      type: 'clarify'
      question: string
      input: string
      resolve: (value: { answer?: string; cancelled?: 'escape' | 'ctrl-c' }) => void
    }
  | {
      type: 'ask'
      prompt: string
      input: string
      masked?: boolean
      resolve: (value: string | undefined) => void
    }

export interface HeaderFacts {
  model: string
  workspace: string
  mode: string
}

export interface StatusFacts {
  working: boolean
  context: string
  sessionTitle: string
}

const MAX_LINES = 2000

export class InkStore {
  lines: Line[] = []
  live = new Map<string, Line>()
  side: SideLine[] = []
  input = ''
  overlay: Overlay | null = null
  header: HeaderFacts = { model: 'auto', workspace: '', mode: 'ACT' }
  status: StatusFacts = { working: false, context: '', sessionTitle: '' }

  onSubmit: ((text: string) => void) | null = null
  onInterrupt: (() => void) | null = null

  private history: string[] = []
  private historyIndex = -1
  private historyDraft = ''

  private readonly listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  emit = (): void => {
    for (const fn of this.listeners) fn()
  }

  line = (text: string, tone?: string): void => {
    this.lines.push({ text, tone })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.emit()
  }

  note = (text: string): void => {
    this.line(text)
  }

  error = (text: string): void => {
    this.line(text, 'red')
  }

  block = (lines: Line[]): void => {
    for (const row of lines) this.line(row.text, row.tone)
  }

  liveRow = (key: string, row: Line): void => {
    this.live.set(key, row)
    this.emit()
  }

  clearLive = (key: string): void => {
    if (this.live.delete(key)) this.emit()
  }

  setSide = (lines: SideLine[]): void => {
    this.side = lines
    this.emit()
  }

  setHeader = (next: Partial<HeaderFacts>): void => {
    this.header = { ...this.header, ...next }
    this.emit()
  }

  setStatus = (next: Partial<StatusFacts>): void => {
    this.status = { ...this.status, ...next }
    this.emit()
  }

  setInput = (text: string): void => {
    this.input = text
    this.emit()
  }

  setOverlay = (overlay: Overlay | null): void => {
    this.overlay = overlay
    this.emit()
  }

  closeOverlay = (): void => {
    this.overlay = null
    this.emit()
  }

  openCommandPalette = (initialFilter = ''): void => {
    const options = PALETTE.map((entry) => ({
      value: String(entry.value ?? entry.title ?? ''),
      label: String(entry.title ?? entry.value ?? ''),
      description: entry.desc,
      section: Boolean(entry.section),
    }))
    const firstSelectable = options.findIndex((o) => !o.section)
    this.setOverlay({
      type: 'select',
      title: 'Commands',
      options,
      filter: initialFilter,
      index: firstSelectable >= 0 ? firstSelectable : 0,
      resolve: (value) => {
        if (value === undefined) return
        const picked = String(value)
        // Commands that expect args keep a trailing space in PALETTE; complete
        // commands (no trailing space) are convenient to run immediately.
        if (!picked.endsWith(' ')) {
          this.input = ''
          this.emit()
          this.pushHistory(picked)
          this.onSubmit?.(picked)
          return
        }
        this.setInput(picked)
      },
    })
  }

  private pushHistory = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.history[this.history.length - 1] !== trimmed) this.history.push(trimmed)
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
    this.historyIndex = -1
    this.historyDraft = ''
  }

  handleInput = (input: string, key: {
    upArrow?: boolean
    downArrow?: boolean
    leftArrow?: boolean
    rightArrow?: boolean
    return?: boolean
    escape?: boolean
    ctrl?: boolean
    shift?: boolean
    backspace?: boolean
    delete?: boolean
    pageUp?: boolean
    pageDown?: boolean
    tab?: boolean
  }): void => {
    if (this.overlay) {
      this.handleOverlayInput(input, key)
      return
    }

    // Command palette shortcuts (similar to screen/pi surfaces).
    if (key.ctrl && (input === 'p' || input === 'k')) {
      const filter = this.input.startsWith('/') ? this.input.slice(1).trim() : ''
      this.openCommandPalette(filter)
      return
    }
    if (key.ctrl && input === 'l') {
      this.lines = []
      this.live.clear()
      this.emit()
      return
    }
    if (key.ctrl && input === 'd') {
      if (this.input.trim() === '') {
        this.onSubmit?.('/exit')
      }
      return
    }

    if ((key as any).tab && this.input.startsWith('/')) {
      const filter = this.input.slice(1).trim()
      this.openCommandPalette(filter)
      return
    }

    // Simple composer history.
    if (key.upArrow) {
      if (this.history.length === 0) return
      if (this.historyIndex === -1) {
        this.historyDraft = this.input
        this.historyIndex = this.history.length - 1
      } else if (this.historyIndex > 0) {
        this.historyIndex--
      }
      this.input = this.history[this.historyIndex] ?? this.input
      this.emit()
      return
    }
    if (key.downArrow) {
      if (this.historyIndex === -1) return
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++
        this.input = this.history[this.historyIndex] ?? ''
      } else {
        this.historyIndex = -1
        this.input = this.historyDraft
      }
      this.emit()
      return
    }

    if (key.return) {
      const text = this.input
      this.input = ''
      this.emit()
      this.pushHistory(text)
      this.onSubmit?.(text)
      return
    }
    if (key.escape) {
      this.onInterrupt?.()
      return
    }
    if (key.backspace || key.delete) {
      this.input = this.input.slice(0, -1)
      this.emit()
      return
    }
    if (key.ctrl && input === 'c') {
      this.onInterrupt?.()
      return
    }
    if (input.length >= 1 && !key.ctrl && !key.escape) {
      const printable = [...input].filter((ch) => ch >= ' ').join('')
      if (printable) {
        // "command tab": typing '/' at an empty composer opens the command palette.
        if (printable === '/' && this.input === '') {
          this.input = '/'
          this.emit()
          this.openCommandPalette('')
          return
        }
        this.input += printable
        this.emit()
      }
    }
  }

  filteredSelectOptions = (overlay: Extract<Overlay, { type: 'select' }>): SelectOptionLike[] => {
    const q = overlay.filter.trim().toLowerCase()
    if (!q) return overlay.options
    return overlay.options.filter((option) => {
      if (option.section) return true
      return option.label.toLowerCase().includes(q)
        || (option.description ?? '').toLowerCase().includes(q)
        || option.value.toLowerCase().includes(q)
    })
  }

  private handleOverlayInput(input: string, key: {
    upArrow?: boolean
    downArrow?: boolean
    leftArrow?: boolean
    rightArrow?: boolean
    return?: boolean
    escape?: boolean
    ctrl?: boolean
    shift?: boolean
    backspace?: boolean
    delete?: boolean
    pageUp?: boolean
    pageDown?: boolean
    tab?: boolean
  }): void {
    const overlay = this.overlay
    if (!overlay) return

    if (key.ctrl && input === 'c') {
      const type = overlay.type
      const resolve = overlay.resolve as (value: any) => void
      this.closeOverlay()
      if (type === 'clarify') resolve({ cancelled: 'ctrl-c' })
      else if (type === 'confirm') resolve(false)
      else resolve(undefined)
      return
    }

    if (overlay.type === 'select') {
      const matches = this.filteredSelectOptions(overlay)
      const selectable = (i: number): boolean => {
        const option = matches[i]
        return Boolean(option && !option.section)
      }
      const clampIndex = (i: number): number => {
        if (matches.length === 0) return 0
        let next = Math.max(0, Math.min(matches.length - 1, i))
        if (selectable(next)) return next
        // move to nearest selectable
        for (let step = 1; step < matches.length; step++) {
          if (next + step < matches.length && selectable(next + step)) return next + step
          if (next - step >= 0 && selectable(next - step)) return next - step
        }
        return 0
      }
      overlay.index = clampIndex(overlay.index)

      if (key.escape) {
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(undefined)
        return
      }
      if (key.return) {
        const picked = matches[overlay.index]
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(picked && !picked.section ? picked.value : undefined)
        return
      }
      if (key.upArrow) {
        let next = overlay.index - 1
        while (next >= 0 && !selectable(next)) next--
        if (next >= 0) overlay.index = next
        this.emit()
        return
      }
      if (key.downArrow) {
        let next = overlay.index + 1
        while (next < matches.length && !selectable(next)) next++
        if (next < matches.length) overlay.index = next
        this.emit()
        return
      }
      if (key.backspace || key.delete) {
        overlay.filter = overlay.filter.slice(0, -1)
        overlay.index = 0
        this.emit()
        return
      }
      if (input.length >= 1 && !key.ctrl && !key.escape) {
        const printable = [...input].filter((ch) => ch >= ' ').join('')
        if (printable) {
          overlay.filter += printable
          overlay.index = 0
          this.emit()
        }
      }
      return
    }

    if (overlay.type === 'confirm') {
      if (key.escape) {
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(false)
        return
      }
      if (key.return) {
        const answer = overlay.index === 0
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(answer)
        return
      }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        overlay.index = overlay.index === 0 ? 1 : 0
        this.emit()
      }
      return
    }

    if (overlay.type === 'page') {
      if (key.escape || key.return || input === 'q') {
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve()
        return
      }
      const pageSize = 20
      const maxOffset = Math.max(0, overlay.lines.length - 1)
      const maxPageOffset = Math.max(0, overlay.lines.length - pageSize)
      if (key.downArrow) {
        overlay.offset = Math.min(maxOffset, overlay.offset + 1)
        this.emit()
        return
      }
      if (key.upArrow) {
        overlay.offset = Math.max(0, overlay.offset - 1)
        this.emit()
        return
      }
      if (key.pageDown) {
        overlay.offset = Math.min(maxPageOffset, overlay.offset + pageSize)
        this.emit()
        return
      }
      if (key.pageUp) {
        overlay.offset = Math.max(0, overlay.offset - pageSize)
        this.emit()
      }
      return
    }

    if (overlay.type === 'clarify') {
      if (key.escape) {
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve({ cancelled: 'escape' })
        return
      }
      if (key.return) {
        const answer = overlay.input
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve({ answer })
        return
      }
      if (key.backspace || key.delete) {
        overlay.input = overlay.input.slice(0, -1)
        this.emit()
        return
      }
      if (input.length >= 1 && !key.ctrl && !key.escape) {
        const printable = [...input].filter((ch) => ch >= ' ').join('')
        if (printable) {
          overlay.input += printable
          this.emit()
        }
      }
      return
    }

    if (overlay.type === 'ask') {
      if (key.escape) {
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(undefined)
        return
      }
      if (key.return) {
        const value = overlay.input
        const resolve = overlay.resolve
        this.closeOverlay()
        resolve(value)
        return
      }
      if (key.backspace || key.delete) {
        overlay.input = overlay.input.slice(0, -1)
        this.emit()
        return
      }
      if (input.length >= 1 && !key.ctrl && !key.escape) {
        const printable = [...input].filter((ch) => ch >= ' ').join('')
        if (printable) {
          overlay.input += printable
          this.emit()
        }
      }
      return
    }
  }
}

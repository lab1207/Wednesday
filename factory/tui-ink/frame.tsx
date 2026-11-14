/**
 * Wednesday's Ink surface.
 *
 * The engine's `ReplUi` writes to an `InkStore`; this component subscribes and
 * draws it. No engine code knows Ink exists - the same seam the pi surface
 * uses, with React components instead of pi-tui's.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { InkStore, Line, Overlay } from './store'

const TONE_COLOR: Record<string, string | undefined> = {
  plain: undefined,
  dim: 'gray',
  cyan: 'cyan',
  yellow: 'yellow',
  red: 'red',
  green: 'green',
  bold: 'white',
}

function toneText(text: string, tone?: string): React.ReactNode {
  const color = TONE_COLOR[tone ?? 'plain']
  if (tone === 'bold') return <Text bold>{text}</Text>
  if (color) return <Text color={color}>{text}</Text>
  return <Text>{text}</Text>
}

function Header({ store }: { store: InkStore }) {
  const { header } = store
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{'❖ WEDNESDAY'}</Text>
      <Text color="gray">{`${header.model} · ${header.workspace} · ${header.mode}`}</Text>
    </Box>
  )
}

function Transcript({ store }: { store: InkStore }) {
  const lines = store.lines
  const live = [...store.live.values()]
  const all = [...lines, ...live]
  // Keep the tail; the transcript is a document but the viewport is bounded.
  const visible = all.slice(-60)
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor="gray" paddingX={1}>
      {visible.length === 0 ? <Text color="gray"> </Text> : null}
      {visible.map((line, i) => (
        <Text key={i} wrap="truncate-end">{toneText(line.text, line.tone)}</Text>
      ))}
    </Box>
  )
}

function SidePanel({ store }: { store: InkStore }) {
  const { side } = store
  if (side.length === 0) return null
  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">roles &amp; models</Text>
      <Text color="gray">{'─'.repeat(30)}</Text>
      {side.map((line, i) => (
        <Text key={i} wrap="truncate-end">{toneText(line.text, line.tone)}</Text>
      ))}
    </Box>
  )
}

function Composer({ store }: { store: InkStore }) {
  const { input, overlay } = store
  if (overlay) return null
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan">{'❯ '}</Text>
      <Text>{input}</Text>
      <Text color="cyan">{'▌'}</Text>
    </Box>
  )
}

function Footer({ store }: { store: InkStore }) {
  const { status } = store
  return (
    <Box flexDirection="column">
      <Text color="gray">
        {`session ${status.sessionTitle || '—'} · ${status.working ? 'working…' : 'idle'} · ${status.context}`}
      </Text>
      <Text color="gray">{'type a request · / commands · ctrl+p palette · ↑↓ history · ctrl+l clear · ctrl+c stop'}</Text>
    </Box>
  )
}

function SelectOverlay({ store, overlay }: { store: InkStore; overlay: Extract<Overlay, { type: 'select' }> }) {
  const matches = store.filteredSelectOptions(overlay)
  const window = 14
  const start = Math.max(0, Math.min(overlay.index - Math.floor(window / 2), Math.max(0, matches.length - window)))
  const visible = matches.slice(start, start + window)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{overlay.title}</Text>
      <Text color="gray">{` ↑↓ navigate · Enter select · Esc cancel · type to filter`}</Text>
      <Text color="cyan">{` filter: ${overlay.filter || '(all)'}  (${matches.length}/${overlay.options.length})`}</Text>
      <Text color="gray">{'─'.repeat(40)}</Text>
      {visible.length === 0 ? <Text color="gray"> no matches</Text> : null}
      {visible.map((option, i) => {
        const absolute = start + i
        const selected = absolute === overlay.index
        if (option.section) {
          return <Text key={i} color="yellow" bold>{` ${option.label}`}</Text>
        }
        return (
          <Text key={i} inverse={selected} color={selected ? undefined : 'white'}>
            {` ${selected ? '❯' : ' '} ${option.label}${option.description ? `  ${option.description}` : ''}`}
          </Text>
        )
      })}
      {matches.length > start + window && <Text color="gray">{` … ${matches.length - (start + window)} more`}</Text>}
    </Box>
  )
}

function ConfirmOverlay({ overlay }: { overlay: Extract<Overlay, { type: 'confirm' }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{overlay.title}</Text>
      <Text>{overlay.detail}</Text>
      <Text>
        <Text inverse={overlay.index === 0}>{` ${overlay.yesLabel} `}</Text>
        <Text inverse={overlay.index === 1}>{` No, keep going `}</Text>
      </Text>
      <Text color="gray">{' ↑↓ move · Enter choose · Esc cancel'}</Text>
    </Box>
  )
}

function PageOverlay({ overlay }: { overlay: Extract<Overlay, { type: 'page' }> }) {
  const pageSize = 20
  const end = Math.min(overlay.lines.length, overlay.offset + pageSize)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{overlay.title}</Text>
      <Text color="gray">{` lines ${overlay.offset + 1}-${end} of ${overlay.lines.length} · ↑↓/PgUp/PgDn scroll · Enter/Esc/q close`}</Text>
      <Text color="gray">{'─'.repeat(40)}</Text>
      {overlay.lines.slice(overlay.offset, end).map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
    </Box>
  )
}

function ClarifyOverlay({ overlay }: { overlay: Extract<Overlay, { type: 'clarify' }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{'Question'}</Text>
      <Text>{overlay.question}</Text>
      <Text color="cyan">{`❯ ${overlay.input}`}</Text>
      <Text color="gray">{' Enter answer · Esc skip · ctrl+c stop'}</Text>
    </Box>
  )
}

function AskOverlay({ overlay }: { overlay: Extract<Overlay, { type: 'ask' }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{overlay.prompt}</Text>
      <Text color="cyan">{`❯ ${overlay.masked ? '•'.repeat(overlay.input.length) : overlay.input}`}</Text>
      <Text color="gray">{' Enter submit · Esc cancel'}</Text>
    </Box>
  )
}

function OverlayView({ store, overlay }: { store: InkStore; overlay: Overlay }) {
  switch (overlay.type) {
    case 'select': return <SelectOverlay store={store} overlay={overlay} />
    case 'confirm': return <ConfirmOverlay overlay={overlay} />
    case 'page': return <PageOverlay overlay={overlay} />
    case 'clarify': return <ClarifyOverlay overlay={overlay} />
    case 'ask': return <AskOverlay overlay={overlay} />
  }
}

export function InkApp({ store }: { store: InkStore }) {
  const [, setTick] = useState(0)
  const { exit } = useApp()

  useEffect(() => {
    return store.subscribe(() => setTick((n) => n + 1))
  }, [store])

  useInput((input, key) => {
    store.handleInput(input, key)
  })

  const overlay = store.overlay
  return (
    <Box flexDirection="column" height="100%">
      <Header store={store} />
      <Box flexDirection="row" flexGrow={1} marginTop={0}>
        <Transcript store={store} />
        <SidePanel store={store} />
      </Box>
      {overlay ? <OverlayView store={store} overlay={overlay} /> : <Composer store={store} />}
      <Footer store={store} />
    </Box>
  )
}

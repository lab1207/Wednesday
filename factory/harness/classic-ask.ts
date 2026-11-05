/**
 * The classic (non-alternate-screen) prompt.
 *
 * Extracted from `harness.ts` for one reason: the Up-arrow recall and the EOF
 * contract could not be tested through a child process. A piped child puts
 * readline in dumb mode — no line editor at all — so pressing Up there proves
 * nothing. With the streams handed in, the same code can be driven in-process
 * and the behaviour that was actually broken (Up did nothing on the classic
 * path) becomes a real assertion.
 *
 * One reader for the whole session, created lazily: creating it eagerly gave the
 * TUI a SECOND reader on stdin, where readline echoes whatever it does not
 * recognise — every mouse report landed on screen as `0;42;16M` text.
 */
import { createInterface } from 'node:readline'

export interface ClassicAskStreams {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  /** Cap on recallable entries (default 500, matching the screen composer). */
  historyLimit?: number
}

export interface ClassicAsk {
  (prompt: string): Promise<string | undefined>
  /** Recallable entries, oldest first. Exposed for tests and `/exit` receipts. */
  history(): string[]
  /** Release the reader. Safe to call more than once. */
  close(): void
}

export function createClassicAsk(streams: ClassicAskStreams): ClassicAsk {
  const limit = streams.historyLimit ?? 500
  // readline PREPENDS onto the array it is handed and recalls newest-first, so
  // this list is newest-first too — which is the opposite end from the screen
  // composer's history. Getting that backwards is invisible until the cap and
  // the duplicate rule start trimming the wrong side.
  const entries: string[] = []
  let readline: ReturnType<typeof createInterface> | null = null
  let lines: AsyncIterator<string> | null = null

  const ask = async (prompt: string): Promise<string | undefined> => {
    streams.output.write(prompt)
    if (!readline) {
      // No `removeHistoryDuplicates`: readline implements it by DELETING the
      // earlier copy and appending the new one, which reorders the list so the
      // oldest request ends up on top. The same consecutive-duplicate rule the
      // screen composer uses is applied here instead, on the correct end.
      readline = createInterface({ input: streams.input, output: streams.output, history: entries })
      lines = readline[Symbol.asyncIterator]()
    }
    const next = await lines!.next()
    if (next.done) return undefined
    // readline already recorded the line at the front; only tidy up here.
    if (entries.length > 1 && entries[0] === entries[1]) entries.splice(1, 1)
    if (entries.length > limit) entries.length = limit
    return String(next.value)
  }

  /** Oldest first, like the screen composer's history. */
  ask.history = () => [...entries].reverse()
  ask.close = () => {
    readline?.close()
    readline = null
    lines = null
  }
  return ask
}

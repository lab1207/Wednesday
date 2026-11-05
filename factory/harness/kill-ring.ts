/**
 * The KILL RING — the Emacs "kill and yank" memory.
 *
 * Adapted from pi (https://github.com/earendil-works/pi), which is MIT
 * licensed, Copyright (c) 2025 Mario Zechner. Changes: the ring is CAPPED
 * (pi's grows for the life of the process), the entries can be read and
 * restored (the undo stack keeps the ring coherent), and the semantics are
 * documented where they are load-bearing.
 *
 * Why it exists: Wednesday's composer could DELETE text but could not get it
 * back. Ctrl+W was a one-way door — a mistyped phrase was gone, and the only
 * way back was to retype it. The undo stack (see `undo-stack.ts`) is the
 * general safety net; the ring is the older, faster gesture: kill a span,
 * move somewhere else, yank it back.
 *
 * The rules, and why each one matters:
 *
 *  1. ONLY the kill chords feed the ring (Ctrl+U, Ctrl+K, Ctrl+W). Plain
 *     Backspace does not — that is what undo is for. If every delete fed the
 *     ring, Ctrl+Y would paste a character the operator deleted by accident,
 *     which is worse than not having a ring at all.
 *  2. CONSECUTIVE KILLS ACCUMULATE into one entry. Three Ctrl+W in a row
 *     yank back three words, not one word three times.
 *  3. A BACKWARD kill PREPENDS and a FORWARD kill APPENDS, so the yank comes
 *     back in the order the text was read, not reversed.
 *  4. A kill of NOTHING never enters the ring (and so never breaks the
 *     accumulation chain).
 */
export class KillRing {
  private ring: string[] = []

  /** How many entries the ring keeps. A long session must not grow forever. */
  static readonly LIMIT = 50

  /**
   * Put killed text in the ring.
   *
   * @param text the killed text (empty text is ignored)
   * @param opts.prepend true for a backward kill, false for a forward one
   * @param opts.accumulate merge with the newest entry instead of adding one
   */
  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (!text) return
    if (opts.accumulate && this.ring.length > 0) {
      const last = this.ring.pop()!
      this.ring.push(opts.prepend ? text + last : last + text)
    } else {
      this.ring.push(text)
    }
    while (this.ring.length > KillRing.LIMIT) this.ring.shift()
  }

  /** The newest entry, without changing the ring. */
  peek(): string | undefined {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined
  }

  /**
   * Move the newest entry to the back — the yank-pop cycle.
   *
   * The order really changes: after a yank-pop the "most recent" kill is no
   * longer the most recent. That is the point of the gesture (it walks back
   * through what was killed), and it is why the ring can be restored from an
   * undo snapshot without losing the walk.
   */
  rotate(): void {
    if (this.ring.length > 1) {
      const last = this.ring.pop()!
      this.ring.unshift(last)
    }
  }

  /** The entries, oldest first. */
  entries(): readonly string[] {
    return this.ring
  }

  /** Replace the whole ring (the undo stack keeps it coherent). */
  restore(entries: readonly string[]): void {
    this.ring = entries.slice(-KillRing.LIMIT)
  }

  get length(): number {
    return this.ring.length
  }
}

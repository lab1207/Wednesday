/**
 * The UNDO STACK — snapshot-based undo for the composer.
 *
 * Adapted from pi (https://github.com/earendil-works/pi), which is MIT
 * licensed, Copyright (c) 2025 Mario Zechner. Changes: the stack is CAPPED,
 * it can be trimmed, and the snapshot type is ours (a flat composer has one
 * string and one caret, not a tree of logical lines).
 *
 * Why it exists: EVERY edit the composer makes must be recoverable. The
 * kill ring only remembers the kill chords; undo remembers everything —
 * typing, backspace, a paste, a completion that was accepted, a yank.
 *
 * The snapshot is a COPY, not a reference: the composer mutates its string in
 * place, so a stack of references would hold the same final text a hundred
 * times and undo would be a no-op.
 */
export class UndoStack<S> {
  private stack: S[] = []

  /** How many snapshots the stack keeps. */
  static readonly LIMIT = 100

  /** Push a deep copy of the given state. */
  push(state: S): void {
    this.stack.push(structuredClone(state))
  }

  /**
   * Pop the newest snapshot.
   *
   * The popped value is handed out directly (it is already a detached copy);
   * the caller owns it.
   */
  pop(): S | undefined {
    return this.stack.pop()
  }

  /** Forget everything. */
  clear(): void {
    this.stack.length = 0
  }

  /** Drop the oldest snapshots until at most `max` remain. */
  trim(max: number): void {
    if (this.stack.length > max) this.stack.splice(0, this.stack.length - max)
  }

  get length(): number {
    return this.stack.length
  }
}

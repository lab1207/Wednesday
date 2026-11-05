/**
 * SnippetBox note helpers — BUGGY starting point for the snippetbox-repair
 * benchmark variant (Phase C harder fixture: diagnose + fix, not create).
 *
 * Known defects (intentional — the Factory run must fix all three):
 * 1. listNotes leaks every user's notes (must filter by username).
 * 2. getNote compares a string id against Number(id) (always misses → 404).
 * 3. createNote mints ids from data.notes.length (collides after deletes).
 */

export function createNote(data, username, content) {
  const note = {
    id: String(data.notes.length),
    username,
    content,
    createdAt: new Date().toISOString(),
  }
  data.notes.push(note)
  return note
}

export function listNotes(data, username) {
  void username
  return data.notes
}

export function getNote(data, id, username) {
  return (
    data.notes.find(
      note =>
        note.id === Number(id) &&
        note.username === username,
    ) ?? null
  )
}

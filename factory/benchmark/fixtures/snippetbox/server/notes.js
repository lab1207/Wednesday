/**
 * SnippetBox note helpers — CLEAN implementation for the snippetbox benchmark.
 */

export function createNote(data, username, content) {
  const note = {
    id: Math.random().toString(36).slice(2, 10),
    username,
    content,
    createdAt: new Date().toISOString(),
  }
  data.notes.push(note)
  return note
}

export function listNotes(data, username) {
  return data.notes.filter(note => note.username === username)
}

export function getNote(data, id, username) {
  return (
    data.notes.find(
      note =>
        note.id === id &&
        note.username === username,
    ) ?? null
  )
}


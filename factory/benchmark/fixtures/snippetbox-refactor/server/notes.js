/**
 * SnippetBox note helpers — WORKING but messy starting point for the
 * snippetbox-refactor benchmark variant.
 *
 * All behavior is CORRECT (base probes pass): notes isolate per user, ids
 * are unique strings, getNote matches. What is WRONG is the shape: one
 * flat module, duplicated serialization, magic values, no input validation
 * anywhere (validation lives in no layer at all). The Factory run must
 * restructure without breaking behavior AND add 400-level input validation
 * with a stable `{ error: string }` shape.
 */

let nextId = 1

export function createNote(data, username, content) {
  const note = {
    id: `n${Date.now().toString(36)}${(nextId++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    username,
    content,
    createdAt: new Date().toISOString(),
  }
  data.notes.push(note)
  return { id: note.id, username: note.username, content: note.content, createdAt: note.createdAt }
}

export function listNotes(data, username) {
  const out = []
  for (let i = 0; i < data.notes.length; i++) {
    const note = data.notes[i]
    if (note.username === username) {
      out.push({ id: note.id, username: note.username, content: note.content, createdAt: note.createdAt })
    }
  }
  return out
}

export function getNote(data, id, username) {
  for (let i = 0; i < data.notes.length; i++) {
    const note = data.notes[i]
    if (String(note.id) === String(id) && note.username === username) {
      return { id: note.id, username: note.username, content: note.content, createdAt: note.createdAt }
    }
  }
  return null
}
